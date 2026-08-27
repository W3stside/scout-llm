/**
 * Fetch orchestration: try cheap, escalate on evidence.
 *
 * The escalation is driven by `blocked` specifically, not by any failure. A 404 or a
 * DNS error means the browser would fail identically, and spending four seconds and a
 * Chromium launch to confirm that would be waste. Only an actual block — a challenge
 * page, a 403, a JS-only shell — is evidence that rendering would help.
 */

import type { Result } from '../core/result.ts';
import { isErr, ok } from '../core/result.ts';
import type { ScoutError } from '../core/types.ts';
import { fetchViaBrowser } from './browser.ts';
import { fetchViaHttp, type FetchedPage } from './http.ts';

export type { FetchedPage } from './http.ts';
export { closeBrowser } from './browser.ts';

export type FetchOptions = {
    readonly mode: 'auto' | 'http' | 'browser';
    readonly minHostIntervalMs: number;
    readonly respectRobots: boolean;
};

export type FetchOutcome = {
    readonly page: FetchedPage;
    /** True when the HTTP path was tried and rejected, so a recipe can pin the browser. */
    readonly escalated: boolean;
};

export async function fetchPage(
    url: string,
    options: FetchOptions,
): Promise<Result<FetchOutcome, ScoutError>> {
    if (options.mode === 'browser') {
        const direct = await fetchViaBrowser(url, { minHostIntervalMs: options.minHostIntervalMs });
        return isErr(direct) ? direct : ok({ page: direct.value, escalated: false });
    }

    const viaHttp = await fetchViaHttp(url, {
        minHostIntervalMs: options.minHostIntervalMs,
        respectRobots: options.respectRobots,
    });

    if (!isErr(viaHttp)) {
        return ok({ page: viaHttp.value, escalated: false });
    }

    // `http` is a deliberate pin — the caller asked for cheap-only and wants the failure.
    if (options.mode === 'http') {
        return viaHttp;
    }

    if (viaHttp.error.kind !== 'blocked') {
        return viaHttp;
    }

    const viaBrowser = await fetchViaBrowser(url, { minHostIntervalMs: options.minHostIntervalMs });
    return isErr(viaBrowser) ? viaBrowser : ok({ page: viaBrowser.value, escalated: true });
}
