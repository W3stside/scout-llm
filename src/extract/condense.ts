/**
 * Shrinking a page to something a model can reason about.
 *
 * A StandVirtual results page is 400KB-1.5MB of markup, most of it inline scripts,
 * SVG path data, and fifty near-identical listing cards. Feeding that raw is wasteful
 * even at 256K context, and actively harmful: the signal the model needs — "what does ONE
 * listing look like, and what wraps the set" — is buried under forty-nine repetitions of
 * itself.
 *
 * So the goal is not compression, it is *exemplification*. Two instances of a repeated
 * structure tell the model everything a hundred would: enough to see which attributes are
 * stable identifiers and which vary per record.
 */

import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';

export type CondenseResult = {
    readonly text: string;
    readonly originalBytes: number;
    readonly condensedBytes: number;
    /** Which route produced this — worth logging, since it explains recipe `mode`. */
    readonly kind: 'nextdata' | 'json' | 'html';
};

const MAX_STRING = 120;
const MAX_ARRAY_SAMPLE = 2;
const MAX_DEPTH = 14;

/**
 * Only strings past this length are considered for JSON parsing. Short strings that
 * happen to parse — a bare "null", a numeric id, "[]" — are content, not structure, and
 * expanding them would obscure the shape rather than reveal it.
 */
const MIN_NESTED_JSON = 200;

/** Sample depth for key/value parameter arrays, where each entry names a distinct field. */
const MAX_KEYED_SAMPLE = 16;

const KEY_PROPS = ['key', 'name', 'label', 'code', 'id'] as const;

/**
 * Whether an array looks like a parameter list — objects each carrying a short, distinct
 * identifier — rather than a list of records. Requires the identifiers to actually differ,
 * so an array of listing nodes that happen to have an `id` is not mistaken for one.
 */
function _isKeyedArray(value: readonly unknown[]): boolean {
    if (value.length < 3) {
        return false;
    }
    const head = value.slice(0, 6).filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v));
    if (head.length < 3) {
        return false;
    }

    for (const prop of KEY_PROPS) {
        const values = head.map((entry) => entry[prop]).filter((v): v is string => typeof v === 'string');
        if (values.length === head.length && new Set(values).size === values.length) {
            // Short identifiers, not free text — a `name` holding a listing title is not a key.
            if (values.every((v) => v.length <= 32)) {
                return true;
            }
        }
    }
    return false;
}

function _parseIfJson(value: string): unknown {
    if (value.length < MIN_NESTED_JSON) {
        return null;
    }
    const trimmed = value.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
        return null;
    }
}

export type CondenseLimits = {
    readonly maxString: number;
    readonly maxArraySample: number;
    readonly maxKeyedSample: number;
    readonly maxDepth: number;
};

const DEFAULT_LIMITS: CondenseLimits = {
    maxString: MAX_STRING,
    maxArraySample: MAX_ARRAY_SAMPLE,
    maxKeyedSample: MAX_KEYED_SAMPLE,
    maxDepth: MAX_DEPTH,
};

/**
 * Progressively tighter passes, tried in order until the result fits the token budget.
 *
 * Ordered by what costs the least understanding: clipping strings first, then depth, and
 * only last the keyed-array sample — because that one is what makes field names like
 * `mileage` visible, and losing it is what caused the model to invent paths.
 */
const TIGHTER_LIMITS: readonly CondenseLimits[] = [
    { maxString: 60, maxArraySample: 2, maxKeyedSample: 16, maxDepth: 12 },
    { maxString: 40, maxArraySample: 1, maxKeyedSample: 16, maxDepth: 10 },
    { maxString: 30, maxArraySample: 1, maxKeyedSample: 10, maxDepth: 8 },
];

/**
 * Reduce a JSON value to its shape.
 *
 * Arrays keep their first entries plus a count marker: the model needs the element shape
 * and the fact that it repeats, never the hundredth element. Long strings are clipped
 * because a description paragraph contributes nothing to deciding which key holds the
 * price — unless the string is itself JSON, in which case it is structure and gets parsed.
 */
export function condenseJson(value: unknown, depth = 0, limits: CondenseLimits = DEFAULT_LIMITS): unknown {
    if (depth > limits.maxDepth) {
        return '…';
    }
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string') {
        // A long string that is itself JSON gets parsed and condensed rather than clipped.
        //
        // This is not a nicety. urql serializes its entire cache as a string inside
        // __NEXT_DATA__, so on StandVirtual the 175KB payload holding every listing is a
        // string value. Clipping it to 120 characters showed the model
        // `"{\"advertSearch\":{\"__typename\":\"Adver…"` — enough to infer the path, not
        // enough to see any field names, so it invented plausible ones (`attributes.year`,
        // `images[0].url`) that do not exist and silently extracted nulls.
        //
        // The recipe's `unwrap` handles this at extraction time; without the same
        // treatment here, the model cannot see what it is writing a recipe against.
        const nested = _parseIfJson(value);
        if (nested !== null) {
            return condenseJson(nested, depth + 1, limits);
        }
        return value.length > limits.maxString ? `${value.slice(0, limits.maxString)}…` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) {
        // Key/value parameter arrays are the exception to sampling. For a list of listing
        // cards, two exemplars tell you everything. For [{key:'origin'},{key:'make'},
        // {key:'year'},{key:'mileage'}…] the KEYS are the signal — sampling two of them
        // hides that `mileage` exists at all, and a recipe cannot address what the model
        // never saw. Observed on StandVirtual: `year` and `mileage` sit past position 6.
        const limit = _isKeyedArray(value) ? limits.maxKeyedSample : limits.maxArraySample;
        const sample = value.slice(0, limit).map((item) => condenseJson(item, depth + 1, limits));
        if (value.length > limit) {
            sample.push(`…and ${value.length - limit} more of the same shape`);
        }
        return sample;
    }
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            out[key] = condenseJson(inner, depth + 1, limits);
        }
        return out;
    }
    return null;
}

/**
 * Strip a document to its structural skeleton.
 *
 * Attributes are filtered to the ones a selector can actually key on. Framework noise
 * (styled-components hashes, Tailwind's hundred utility classes) is dropped entirely —
 * it is both the bulk of the bytes and the worst thing a recipe could latch onto, since
 * those names change on every build.
 */
export function condenseHtml(html: string): string {
    const $ = cheerio.load(html);

    $('script, style, noscript, svg, iframe, link, meta, template').remove();
    $('*')
        .contents()
        .filter((_i, node) => node.type === 'comment')
        .remove();

    const KEEP_ATTRS = new Set(['id', 'class', 'href', 'src', 'data-testid', 'data-cy', 'data-id', 'itemprop', 'itemtype', 'role', 'aria-label']);

    $('*').each((_i, el) => {
        const element = el as Element;
        const attribs = element.attribs;
        if (attribs === undefined || attribs === null) {
            return;
        }
        for (const name of Object.keys(attribs)) {
            if (!KEEP_ATTRS.has(name)) {
                delete attribs[name];
                continue;
            }
            if (name === 'class') {
                const filtered = _usefulClasses(attribs[name] ?? '');
                if (filtered.length === 0) {
                    delete attribs[name];
                } else {
                    attribs[name] = filtered;
                }
            }
        }
    });

    _collapseRepeats($);

    return $('body').html()?.replace(/\n\s*\n/g, '\n').trim() ?? '';
}

/**
 * Drop generated class names, keep human-authored ones.
 *
 * Hashed names (`css-1x2y3z`, `sc-eCImPb`) and utility soup are worse than useless in a
 * recipe: they change every deploy, so a selector built on them breaks silently while
 * looking perfectly reasonable in the committed file.
 */
function _usefulClasses(raw: string): string {
    const kept = raw
        .split(/\s+/)
        .filter((c) => c.length > 0)
        .filter((c) => !/^(css|sc|jsx)-[a-z0-9]{4,}$/i.test(c))
        .filter((c) => !/^[a-z]+-\[.+\]$/i.test(c))
        .filter((c) => !/^(hover|focus|sm|md|lg|xl|dark):/.test(c))
        .filter((c) => c.length < 40);
    return kept.slice(0, 4).join(' ');
}

/**
 * Replace runs of structurally identical siblings with two exemplars and a marker.
 *
 * "Structurally identical" is judged by tag plus retained class signature — the same
 * heuristic a person uses when eyeballing a results page for the repeating unit.
 */
function _collapseRepeats($: cheerio.CheerioAPI): void {
    $('*').each((_i, el) => {
        const parent = $(el as Element);
        const children = parent.children().toArray();
        if (children.length <= MAX_ARRAY_SAMPLE + 1) {
            return;
        }

        const groups = new Map<string, Element[]>();
        for (const child of children) {
            const element = child as Element;
            const signature = `${element.tagName}.${element.attribs?.['class'] ?? ''}`;
            const bucket = groups.get(signature);
            if (bucket === undefined) {
                groups.set(signature, [element]);
            } else {
                bucket.push(element);
            }
        }

        for (const [, bucket] of groups) {
            if (bucket.length <= MAX_ARRAY_SAMPLE + 1) {
                continue;
            }
            const dropped = bucket.length - MAX_ARRAY_SAMPLE;
            for (let i = MAX_ARRAY_SAMPLE; i < bucket.length; i += 1) {
                const victim = bucket[i];
                if (victim !== undefined) {
                    $(victim).remove();
                }
            }
            const anchor = bucket[MAX_ARRAY_SAMPLE - 1];
            if (anchor !== undefined) {
                $(anchor).after(`<!-- …${dropped} more siblings of the same shape -->`);
            }
        }
    });
}

/**
 * Pick the best condensation route for a page and apply it.
 *
 * __NEXT_DATA__ is tried first because when it exists it is strictly better evidence: it
 * is the same object the site's own components render from, so a recipe written against
 * it breaks only when the API changes, not when a designer renames a class.
 */
/**
 * Byte budget for the condensed payload.
 *
 * The baked model runs at num_ctx 32768. At roughly 3.6 bytes per token this leaves room
 * for the system prompt and the response alongside the page. Overflow is the failure mode
 * worth engineering against, because Ollama truncates silently — the model would receive a
 * page cut off mid-structure and write a recipe against whatever survived, with no error
 * anywhere to explain why extraction later yields nulls.
 */
const BUDGET_BYTES = 85_000;

export function condensePage(body: string, contentType: string, budgetBytes = BUDGET_BYTES): CondenseResult {
    const originalBytes = Buffer.byteLength(body);

    const asJson = _tryParseJson(body);
    if (asJson !== null && (contentType.includes('json') || body.trimStart().startsWith('{') || body.trimStart().startsWith('['))) {
        return _condenseWithinBudget(asJson, originalBytes, budgetBytes, 'json');
    }

    const nextData = _extractNextData(body);
    if (nextData !== null) {
        return _condenseWithinBudget(nextData, originalBytes, budgetBytes, 'nextdata');
    }

    const text = condenseHtml(body);
    return { text, originalBytes, condensedBytes: Buffer.byteLength(text), kind: 'html' };
}

/**
 * Condense at default fidelity, then retry progressively tighter until it fits.
 *
 * The last set of limits is used unconditionally if nothing fits — a too-large payload is
 * still better evidence than none, and the caller has the byte counts to notice.
 */
function _condenseWithinBudget(
    payload: unknown,
    originalBytes: number,
    budgetBytes: number,
    kind: 'json' | 'nextdata',
): CondenseResult {
    const attempts = [DEFAULT_LIMITS, ...TIGHTER_LIMITS];

    let text = '';
    for (const limits of attempts) {
        text = JSON.stringify(condenseJson(payload, 0, limits), null, 1);
        if (Buffer.byteLength(text) <= budgetBytes) {
            break;
        }
    }
    return { text, originalBytes, condensedBytes: Buffer.byteLength(text), kind };
}

function _tryParseJson(body: string): unknown {
    const trimmed = body.trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return null;
    }
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

function _extractNextData(body: string): unknown {
    try {
        const $ = cheerio.load(body);
        const raw = $('script#__NEXT_DATA__').first().text();
        if (raw.trim().length === 0) {
            return null;
        }
        return JSON.parse(raw);
    } catch {
        return null;
    }
}
