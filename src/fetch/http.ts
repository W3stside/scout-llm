/**
 * The cheap fetch path: a plain HTTP request with convincing browser headers.
 *
 * This handles the majority of real pages at ~200ms and ~50MB, versus several seconds
 * and several hundred MB for Chromium. The interesting problem is not fetching but
 * *knowing when it failed* — bot protection rarely returns an error. It returns 200 with
 * a challenge page, and a naive caller extracts zero listings and reports success.
 * `classifyResponse` exists to turn that silent failure into an explicit `blocked`,
 * which is what triggers the browser fallback.
 */

import { Agent, interceptors, request } from 'undici';
import type { Result } from '../core/result.ts';
import { err, messageOf, ok } from '../core/result.ts';
import { scoutError, type ScoutError } from '../core/types.ts';
import { guardedConnector, readBodyCapped } from './guard.ts';
import { awaitHostSlot, browserLikeHeaders, isAllowedByRobots } from './politeness.ts';

export type FetchedPage = {
    readonly url: string;
    readonly finalUrl: string;
    readonly status: number;
    readonly body: string;
    readonly contentType: string;
    readonly via: 'http' | 'browser';
};

export type HttpFetchOptions = {
    readonly minHostIntervalMs: number;
    readonly respectRobots: boolean;
    readonly timeoutMs?: number;
};

/**
 * Markers that a 200 response is a challenge/interstitial rather than content. Matched
 * case-insensitively against the first portion of the body.
 */
const CHALLENGE_MARKERS: readonly string[] = [
    'cf-browser-verification',
    'cf_chl_opt',
    'challenge-platform',
    'just a moment',
    'checking your browser',
    'enable javascript and cookies to continue',
    'px-captcha',
    'perimeterx',
    'datadome',
    'incapsula',
    '_incapsula_resource',
    'access denied',
    'are you a robot',
    'unusual traffic',
];

/**
 * Ceiling on a page body. Real listing pages — even __NEXT_DATA__-heavy ones — top out
 * around 2-3MB; 10MB is generous headroom, not a tuning knob. The cap exists so a hostile
 * or broken host cannot stream the container into its memory limit.
 */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Shared dispatcher. Two interceptors, both load-bearing:
 *
 *   decompress — undici does NOT decompress automatically. Since browserLikeHeaders
 *                advertises gzip/deflate/br (omitting it would itself be a bot signal),
 *                without this every body would arrive as compressed bytes and .text()
 *                would hand back mojibake that no selector could ever match.
 *   redirect   — classifieds routinely 301 to a canonical slug. Headers are stripped on
 *                cross-origin hops so a redirect to an unrelated host cannot harvest the
 *                referer or any cookie we may later attach.
 *
 * The connector is the SSRF boundary: every connection this dispatcher opens — including
 * each redirect hop, which the interceptor re-dispatches through the same connector — is
 * refused unless it lands on a public address. See guard.ts for why this lives at connect
 * time rather than on the URL string.
 */
const _dispatcher = new Agent({
    connect: guardedConnector({ timeoutMs: 10_000 }),
    // Wire-side twin of the streaming cap below: readBodyCapped bounds DECOMPRESSED
    // bytes, this bounds bytes on the wire, so neither a slow drip nor a gzip bomb has a
    // path around the other's cap.
    maxResponseSize: MAX_BODY_BYTES,
}).compose(
    interceptors.decompress(),
    interceptors.redirect({
        maxRedirections: 5,
        stripHeadersOnCrossOriginRedirect: ['authorization', 'cookie', 'referer'],
    }),
);

export type PageClass = 'ok' | 'blocked' | 'not-found' | 'server-error';

/**
 * Decide whether a response is usable content.
 *
 * The `length < 2000` heuristic catches the case a status code cannot: a 200 that is
 * really a JS-only shell. A genuine listing page — even an empty search result — carries
 * navigation, footer and markup well past that. Kept deliberately low to avoid
 * misclassifying a legitimately sparse API response as a block.
 */
export function classifyResponse(status: number, body: string): PageClass {
    if (status === 404 || status === 410) {
        return 'not-found';
    }
    if (status === 403 || status === 429 || status === 401) {
        return 'blocked';
    }
    if (status >= 500) {
        return 'server-error';
    }
    if (status >= 300 && status < 400) {
        return 'blocked';
    }

    const head = body.slice(0, 8_000).toLowerCase();
    if (CHALLENGE_MARKERS.some((marker) => head.includes(marker))) {
        return 'blocked';
    }
    if (body.trim().length < 2_000 && !head.trimStart().startsWith('{') && !head.trimStart().startsWith('[')) {
        return 'blocked';
    }
    return 'ok';
}

export async function fetchViaHttp(
    url: string,
    options: HttpFetchOptions,
): Promise<Result<FetchedPage, ScoutError>> {
    if (options.respectRobots) {
        const allowed = await isAllowedByRobots(url);
        if (!allowed) {
            return err(
                scoutError(
                    'config',
                    `robots.txt disallows ${url} — set RESPECT_ROBOTS=false to override deliberately`,
                ),
            );
        }
    }

    await awaitHostSlot(url, options.minHostIntervalMs);

    const timeoutMs = options.timeoutMs ?? 20_000;

    try {
        const res = await request(url, {
            method: 'GET',
            headers: browserLikeHeaders(),
            dispatcher: _dispatcher,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            // headersTimeout and bodyTimeout are PER-PHASE and per-chunk: a host that
            // drips one byte every few seconds satisfies both forever. This signal is the
            // wall-clock ceiling on the whole exchange, redirect hops included.
            signal: AbortSignal.timeout(timeoutMs * 3),
        });

        const bodyRead = await readBodyCapped(res.body, MAX_BODY_BYTES);
        if (!bodyRead.ok) {
            return bodyRead;
        }
        const body = bodyRead.value.toString('utf-8');
        const contentTypeRaw = res.headers['content-type'];
        const contentType =
            typeof contentTypeRaw === 'string'
                ? contentTypeRaw
                : Array.isArray(contentTypeRaw)
                  ? (contentTypeRaw[0] ?? '')
                  : '';

        const verdict = classifyResponse(res.statusCode, body);
        if (verdict === 'blocked') {
            return err(
                scoutError('blocked', `http fetch looks blocked (status ${res.statusCode})`, {
                    cause: { status: res.statusCode, preview: body.slice(0, 200) },
                }),
            );
        }
        if (verdict === 'not-found') {
            return err(scoutError('network', `${url} returned ${res.statusCode}`));
        }
        if (verdict === 'server-error') {
            return err(scoutError('network', `${url} returned ${res.statusCode}`));
        }

        return ok({
            url,
            finalUrl: url,
            status: res.statusCode,
            body,
            contentType,
            via: 'http',
        });
    } catch (thrown: unknown) {
        return err(scoutError('network', `http fetch failed: ${messageOf(thrown)}`, { cause: thrown }));
    }
}
