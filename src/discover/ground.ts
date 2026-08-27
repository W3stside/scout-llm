/**
 * Grounding a search URL in paths the site actually publishes.
 *
 * The model knows which classified sites exist — that part of its memory is reliable. What
 * it does not know is any given site's URL schema, and it will confidently invent one:
 * asked for BMWs on olx.pt it proposed `/autos/bmw`, a perfectly plausible path that 404s.
 * The real one is `/carros-motos-e-barcos/carros/bmw`. No number of retries fixes a guess,
 * because each retry is another guess from the same faulty memory.
 *
 * So: fetch the site's own homepage and harvest the links it publishes. The model then
 * CHOOSES a path from real ones rather than inventing one. Query parameters remain a guess
 * — they are rarely present in navigation links — but a wrong parameter merely fails to
 * filter, which verification catches, whereas a wrong path returns nothing at all.
 */

import * as cheerio from 'cheerio';
import type { Result } from '../core/result.ts';
import { isErr, ok } from '../core/result.ts';
import { hostOf } from '../core/url.ts';
import type { ScoutError } from '../core/types.ts';
import { fetchPage } from '../fetch/index.ts';

export type SiteMap = {
    readonly host: string;
    /** Category/navigation paths, shortest first — the broad ones are the useful ones. */
    readonly paths: readonly string[];
    /** Query parameter names seen in the site's own links: its real filter vocabulary. */
    readonly queryParams: readonly string[];
};

/** Enough to show the shape of the site without swamping the prompt. */
const MAX_PATHS = 60;
const MAX_PARAMS = 30;

/** Navigation noise that is never a search path. */
const IGNORE = /\/(login|signin|register|account|help|support|terms|privacy|cookie|about|contact|blog|news|app|download|jobs|press)(\/|$)/i;

export async function mapSite(
    site: string,
    options: { readonly minHostIntervalMs: number; readonly respectRobots: boolean },
): Promise<Result<SiteMap, ScoutError>> {
    const host = hostOf(`https://${site.replace(/^https?:\/\//, '')}`) ?? site;

    const fetched = await fetchPage(`https://${host}/`, {
        mode: 'auto',
        minHostIntervalMs: options.minHostIntervalMs,
        respectRobots: options.respectRobots,
    });
    if (isErr(fetched)) {
        return fetched;
    }

    const $ = cheerio.load(fetched.value.page.body);
    const paths = new Set<string>();
    const params = new Set<string>();

    for (const el of $('a[href]').toArray()) {
        const href = $(el).attr('href');
        if (href === undefined || href.length === 0) {
            continue;
        }

        let parsed: URL;
        try {
            parsed = new URL(href, `https://${host}/`);
        } catch {
            continue;
        }
        // Off-site links describe someone else's schema.
        if (parsed.hostname.replace(/^www\./, '') !== host.replace(/^www\./, '')) {
            continue;
        }
        for (const key of parsed.searchParams.keys()) {
            if (key.length <= 60) {
                params.add(key);
            }
        }

        const path = parsed.pathname.replace(/\/+$/, '');
        if (path.length <= 1 || IGNORE.test(path)) {
            continue;
        }
        // Deep paths are individual listings; the shallow ones are the categories a search
        // is built from.
        if (path.split('/').filter((s) => s.length > 0).length > 4) {
            continue;
        }
        paths.add(path);
    }

    const sorted = [...paths].sort((a, b) => a.length - b.length).slice(0, MAX_PATHS);
    return ok({ host, paths: sorted, queryParams: [...params].slice(0, MAX_PARAMS) });
}

/** Render a site map for the prompt, compactly. */
export function describeSiteMap(map: SiteMap): string {
    return (
        `Real paths published by ${map.host} (choose from these, do not invent):\n` +
        map.paths.map((p) => `  ${p}`).join('\n') +
        (map.queryParams.length > 0
            ? `\n\nQuery parameters this site actually uses in its own links:\n  ${map.queryParams.join(', ')}`
            : '\n\n(no query parameters observed in navigation links)')
    );
}
