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
 * Reduce a JSON value to its shape.
 *
 * Arrays keep their first two entries plus a count marker: the model needs the element
 * shape and the fact that it repeats, never the hundredth element. Long strings are
 * clipped because a base64 thumbnail or a description paragraph contributes nothing to
 * deciding which key holds the price.
 */
export function condenseJson(value: unknown, depth = 0): unknown {
    if (depth > MAX_DEPTH) {
        return '…';
    }
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === 'string') {
        return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (Array.isArray(value)) {
        const sample = value.slice(0, MAX_ARRAY_SAMPLE).map((item) => condenseJson(item, depth + 1));
        if (value.length > MAX_ARRAY_SAMPLE) {
            sample.push(`…and ${value.length - MAX_ARRAY_SAMPLE} more of the same shape`);
        }
        return sample;
    }
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            out[key] = condenseJson(inner, depth + 1);
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
export function condensePage(body: string, contentType: string): CondenseResult {
    const originalBytes = Buffer.byteLength(body);

    const asJson = _tryParseJson(body);
    if (asJson !== null && (contentType.includes('json') || body.trimStart().startsWith('{') || body.trimStart().startsWith('['))) {
        const text = JSON.stringify(condenseJson(asJson), null, 1);
        return { text, originalBytes, condensedBytes: Buffer.byteLength(text), kind: 'json' };
    }

    const nextData = _extractNextData(body);
    if (nextData !== null) {
        const text = JSON.stringify(condenseJson(nextData), null, 1);
        return { text, originalBytes, condensedBytes: Buffer.byteLength(text), kind: 'nextdata' };
    }

    const text = condenseHtml(body);
    return { text, originalBytes, condensedBytes: Buffer.byteLength(text), kind: 'html' };
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
