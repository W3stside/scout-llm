/**
 * Applying a recipe to a fetched page. This is the zero-LLM path that runs on every
 * poll — the model wrote the recipe once, but nothing here calls it.
 *
 * Three modes, in descending order of how well they survive a redesign:
 *
 *   jsonld — schema.org blocks. Standardized and usually machine-maintained, so it
 *            changes least. Rare on classifieds but free when present.
 *   json   — JSONPath into a payload the page already carries (__NEXT_DATA__) or is.
 *            The workhorse for Next.js sites: the data is the same object the site's
 *            own components render from, so it changes only when the API changes.
 *   css    — selectors over markup. Breaks whenever a designer touches a class name.
 *
 * Every field is individually fallible. A listing missing a price yields price: null and
 * still counts; only a missing URL discards the record, because without one there is no
 * identity and therefore no way to dedupe it.
 */

import * as cheerio from 'cheerio';
import { JSONPath } from 'jsonpath-plus';
import type { Result } from '../core/result.ts';
import { err, messageOf, ok } from '../core/result.ts';
import { canonicalizeUrl } from '../core/url.ts';
import { scoutError, type CssField, type Listing, type Recipe, type ScoutError } from '../core/types.ts';
import { coerceNumber, coerceText, coerceYear } from './coerce.ts';
import type { FetchedPage } from '../fetch/http.ts';

/** Fields that map onto the typed Listing shape; anything else lands in `extra`. */
const KNOWN_FIELDS = new Set(['url', 'title', 'price', 'currency', 'year', 'km', 'location', 'image']);

export function applyRecipe(recipe: Recipe, page: FetchedPage): Result<readonly Listing[], ScoutError> {
    const records = _selectRecords(recipe, page);
    if (!records.ok) {
        return records;
    }

    const listings: Listing[] = [];
    for (const record of records.value) {
        const listing = _buildListing(recipe, record, page.finalUrl);
        if (listing !== null) {
            listings.push(listing);
        }
    }

    return ok(listings);
}

// --- Record selection ---------------------------------------------------------------

/**
 * A record is either a JSON value (json/jsonld modes) or a cheerio element (css mode).
 * `unknown` rather than `any` for the JSON side: every read out of it is forced through
 * the coercion helpers, which is exactly the discipline we want on scraped data.
 */
type Record_ = { readonly kind: 'json'; readonly value: unknown } | { readonly kind: 'css'; readonly html: string };

function _selectRecords(recipe: Recipe, page: FetchedPage): Result<readonly Record_[], ScoutError> {
    if (recipe.mode === 'css') {
        try {
            const $ = cheerio.load(page.body);
            const nodes = $(recipe.list).toArray();
            return ok(nodes.map((node) => ({ kind: 'css' as const, html: $.html(node) })));
        } catch (thrown: unknown) {
            return err(scoutError('parse', `css selection failed: ${messageOf(thrown)}`, { cause: thrown }));
        }
    }

    const payload = recipe.mode === 'jsonld' ? _extractJsonLd(page) : _extractJsonPayload(recipe, page);
    if (!payload.ok) {
        return payload;
    }

    const unwrapped = _unwrapJsonStrings(payload.value, recipe.unwrap);

    try {
        const found: unknown[] = JSONPath({ path: recipe.list, json: unwrapped as object, wrap: true });
        return ok(found.map((value) => ({ kind: 'json' as const, value })));
    } catch (thrown: unknown) {
        return err(scoutError('parse', `jsonpath '${recipe.list}' failed: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

/**
 * Parse serialized-JSON fields in place, so `list` can address through them.
 *
 * Mutates a structuredClone rather than the caller's object: the payload is also handed
 * to the condenser during healing, and a half-unwrapped document would make the model's
 * view of the page disagree with the recipe's.
 *
 * A field that is not a string, or is a string that does not parse, is left exactly as
 * found. An over-broad unwrap path is therefore harmless, which is what allows the
 * generator to use a wildcard instead of naming a volatile query hash.
 */
function _unwrapJsonStrings(payload: unknown, paths: readonly string[]): unknown {
    if (paths.length === 0) {
        return payload;
    }

    let working: unknown;
    try {
        working = structuredClone(payload);
    } catch {
        return payload;
    }

    for (const path of paths) {
        let hits: { parent?: unknown; parentProperty?: string; value?: unknown }[];
        try {
            hits = JSONPath({ path, json: working as object, resultType: 'all', wrap: true }) as typeof hits;
        } catch {
            continue;
        }

        for (const hit of hits) {
            const { parent, parentProperty, value } = hit;
            if (typeof value !== 'string' || parent === undefined || parent === null || parentProperty === undefined) {
                continue;
            }
            try {
                (parent as Record<string, unknown>)[parentProperty] = JSON.parse(value);
            } catch {
                continue;
            }
        }
    }
    return working;
}

/**
 * Pull the structured payload a page carries.
 *
 * `response` covers the case where the fetched URL is itself an API endpoint — often the
 * cleanest route, since it skips markup entirely.
 */
function _extractJsonPayload(recipe: Recipe, page: FetchedPage): Result<unknown, ScoutError> {
    const source = recipe.source ?? 'nextdata';

    if (source === 'response') {
        try {
            return ok(JSON.parse(page.body));
        } catch (thrown: unknown) {
            return err(scoutError('parse', `response is not JSON: ${messageOf(thrown)}`, { cause: thrown }));
        }
    }

    try {
        const $ = cheerio.load(page.body);

        if (source === 'nextdata') {
            const raw = $('script#__NEXT_DATA__').first().text();
            if (raw.trim().length === 0) {
                return err(scoutError('empty-extraction', 'no __NEXT_DATA__ script on the page'));
            }
            return ok(JSON.parse(raw));
        }

        // `inline`: no single well-known id, so take the largest JSON-looking script and
        // let the recipe's path do the discriminating. Largest is a good proxy — the
        // state blob dwarfs config and analytics snippets.
        let best = '';
        for (const el of $('script').toArray()) {
            const text = $(el).text().trim();
            if (text.length > best.length && (text.startsWith('{') || text.startsWith('['))) {
                best = text;
            }
        }
        if (best.length === 0) {
            return err(scoutError('empty-extraction', 'no inline JSON script found'));
        }
        return ok(JSON.parse(best));
    } catch (thrown: unknown) {
        return err(scoutError('parse', `inline JSON parse failed: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

/**
 * Collect every ld+json block into one array, so a recipe path can address across them
 * without caring which <script> a given Product happened to land in.
 */
function _extractJsonLd(page: FetchedPage): Result<unknown, ScoutError> {
    try {
        const $ = cheerio.load(page.body);
        const blocks: unknown[] = [];
        for (const el of $('script[type="application/ld+json"]').toArray()) {
            const text = $(el).text().trim();
            if (text.length === 0) {
                continue;
            }
            try {
                blocks.push(JSON.parse(text));
            } catch {
                // A single malformed block is common and must not discard the valid ones.
                continue;
            }
        }
        if (blocks.length === 0) {
            return err(scoutError('empty-extraction', 'no parseable ld+json blocks on the page'));
        }
        return ok(blocks);
    } catch (thrown: unknown) {
        return err(scoutError('parse', `ld+json parse failed: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

// --- Field extraction ---------------------------------------------------------------

function _buildListing(recipe: Recipe, record: Record_, baseUrl: string): Listing | null {
    const raw = new Map<string, unknown>();
    for (const [field, spec] of Object.entries(recipe.fields)) {
        raw.set(field, _readField(record, spec));
    }

    // No URL means no identity means no dedupe. Discard rather than invent one.
    const urlRaw = raw.get('url');
    const canonical = typeof urlRaw === 'string' ? canonicalizeUrl(urlRaw, baseUrl) : null;
    if (canonical === null) {
        return null;
    }

    const extra: Record<string, string | number | null> = {};
    for (const [field, value] of raw) {
        if (KNOWN_FIELDS.has(field)) {
            continue;
        }
        const text = coerceText(value);
        extra[field] = text;
    }

    const imageRaw = raw.get('image');
    const image = typeof imageRaw === 'string' ? canonicalizeUrl(imageRaw, baseUrl) : null;

    return {
        url: canonical,
        title: coerceText(raw.get('title')),
        price: coerceNumber(raw.get('price')),
        currency: coerceText(raw.get('currency')),
        year: coerceYear(raw.get('year')),
        km: coerceNumber(raw.get('km')),
        location: coerceText(raw.get('location')),
        image,
        extra,
    };
}

function _readField(record: Record_, spec: CssField): unknown {
    if (record.kind === 'css') {
        return _readCssField(record.html, spec);
    }
    // JSON modes address fields by path; the object form is a css-only affordance.
    const path = typeof spec === 'string' ? spec : spec.sel;
    try {
        const found: unknown[] = JSONPath({ path, json: record.value as object, wrap: true });
        const first = found[0];
        return first === undefined ? null : first;
    } catch {
        return null;
    }
}

function _readCssField(html: string, spec: CssField): unknown {
    try {
        const $ = cheerio.load(html);
        const selector = typeof spec === 'string' ? spec : spec.sel;
        const attr = typeof spec === 'string' ? undefined : spec.attr;

        // The record's own root can carry the value (a listing <a> whose href is the URL),
        // so try the root before descending.
        const root = $.root().children().first();
        const matched = selector.trim().length === 0 ? root : $(selector).first();
        const element = matched.length > 0 ? matched : root.is(selector) ? root : matched;

        if (element.length === 0) {
            return null;
        }
        if (attr !== undefined && attr !== null) {
            return element.attr(attr) ?? null;
        }
        return element.text();
    } catch {
        return null;
    }
}
