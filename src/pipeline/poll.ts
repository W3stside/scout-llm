/**
 * One poll of one target: fetch, extract, filter, diff, judge, decide.
 *
 * The ordering is the whole design, and it is not arbitrary:
 *
 *   fetch -> extract        deterministic; the model is not involved
 *   -> deterministic filter cheap, exact, discards the bulk
 *   -> diff against store   decides what is NEW, on fingerprints alone
 *   -> judge                the model finally runs, on single digits of listings
 *   -> notify
 *
 * Two properties fall out of that. Inference cost scales with what is *new*, not with
 * how large the search is — a 200-listing target still judges two listings a poll. And
 * because the diff happens before the judge, nothing the model does can invent a
 * notification: it can change how a listing is described, never whether it is new.
 */

import type { Result } from '../core/result.ts';
import { isErr, isOk, ok } from '../core/result.ts';
import { fingerprintOf } from '../core/url.ts';
import {
    asTargetId,
    type IdentifiedListing,
    type Listing,
    type ScoutError,
    type Target,
    type Verdict,
    type Fingerprint,
} from '../core/types.ts';
import { fetchPage } from '../fetch/index.ts';
import { applyRecipe } from '../extract/selectors.ts';
import { loadRecipe } from '../extract/recipe.ts';
import { rejectReason, scoreListing } from '../llm/score.ts';
import type { OllamaOptions } from '../llm/ollama.ts';
import type { Store } from '../store/db.ts';
import { finishRun, recordSeen, selectNew, startRun, isMuted } from '../store/listings.ts';
import { healTarget, shouldHeal, type HealResult } from './heal.ts';
import type { Config } from '../core/config.ts';

export type Notification = {
    readonly listing: IdentifiedListing;
    readonly verdict: Verdict;
};

export type PollReport = {
    readonly targetId: string;
    readonly extracted: number;
    readonly passedFilters: number;
    readonly fresh: number;
    readonly judged: number;
    readonly notifications: readonly Notification[];
    readonly via: 'http' | 'browser';
    readonly escalated: boolean;
    /** Non-fatal problems: one listing failed to score, an image 404'd. */
    readonly warnings: readonly string[];
    /** Set when extraction came up empty and a repair was attempted. */
    readonly healed: HealResult | null;
};

export type PollDeps = {
    readonly config: Config;
    readonly ollama: OllamaOptions;
    readonly store: Store;
    /** Skip all inference. Every new listing is recorded but nothing is notified. */
    readonly noLlm?: boolean;
};

export async function pollTarget(
    target: Target,
    deps: PollDeps,
): Promise<Result<PollReport, ScoutError>> {
    const targetId = asTargetId(target.id);
    const runId = startRun(deps.store, targetId);
    const warnings: string[] = [];

    const recipe = await loadRecipe(deps.config.recipesDir, target.id);
    if (isErr(recipe)) {
        finishRun(deps.store, runId, { status: 'error', error: recipe.error.message });
        return recipe;
    }

    const fetched = await fetchPage(target.url, {
        mode: target.fetchMode,
        minHostIntervalMs: deps.config.minHostIntervalMs,
        respectRobots: deps.config.respectRobots,
    });
    if (isErr(fetched)) {
        finishRun(deps.store, runId, { status: 'error', error: fetched.error.message });
        return fetched;
    }

    const extracted = applyRecipe(recipe.value, fetched.value.page);
    if (isErr(extracted)) {
        finishRun(deps.store, runId, {
            status: 'error',
            fetchMode: fetched.value.page.via,
            error: extracted.error.message,
        });
        return extracted;
    }

    let listings = extracted.value;
    let healed: HealResult | null = null;

    if (listings.length === 0) {
        // The empty run is recorded FIRST, so this attempt counts toward the streak that
        // gates the next one. Recording after would let a heal that fails to fix anything
        // re-trigger immediately on the following poll.
        finishRun(deps.store, runId, { status: 'empty', fetchMode: fetched.value.page.via, listingCount: 0 });

        const decision = deps.noLlm === true
            ? { kind: 'skip' as const, reason: '--no-llm' }
            : shouldHeal(deps.store, target, 0);

        if (decision.kind === 'attempt') {
            const attempt = await healTarget(target, recipe.value, fetched.value.page, {
                ollama: deps.ollama,
                store: deps.store,
                recipesDir: deps.config.recipesDir,
            });

            if (!isErr(attempt)) {
                healed = attempt.value;
                if (attempt.value.recipe !== null) {
                    // Re-extract with the repaired recipe rather than waiting for the next
                    // poll — the page is already fetched, and a fifteen-minute wait to act
                    // on a fix we already have is pure latency.
                    const retry = applyRecipe(attempt.value.recipe, fetched.value.page);
                    if (!isErr(retry)) {
                        listings = retry.value;
                    }
                }
            }
        } else {
            warnings.push(`extracted 0 listings; heal skipped: ${decision.reason}`);
        }

        if (listings.length === 0) {
            return ok({
                targetId: target.id,
                extracted: 0,
                passedFilters: 0,
                fresh: 0,
                judged: 0,
                notifications: [],
                via: fetched.value.page.via,
                escalated: fetched.value.escalated,
                warnings: [
                    ...warnings,
                    ...(healed !== null ? [`heal ${healed.outcome}: ${healed.message}`] : []),
                ],
                healed,
            });
        }
    }

    // Deterministic filters first: free, and it keeps the model's attention on candidates
    // that already clear the hard constraints.
    const survivors = listings.filter((l) => rejectReason(l, target.filters) === null);

    const identified = survivors.map((listing) => _identify(listing, target.id));

    // The diff. Everything downstream operates on this and only this.
    const fresh = selectNew(deps.store, targetId, identified);

    const verdicts = new Map<Fingerprint, Verdict>();
    const notifications: Notification[] = [];

    if (deps.noLlm !== true) {
        for (const listing of fresh) {
            if (_isMutedListing(deps.store, listing, targetId)) {
                continue;
            }

            const scored = await scoreListing(deps.ollama, {
                listing,
                criteria: target.criteria,
                photoGrade: target.notify.photoGrade,
            });

            if (isErr(scored)) {
                // One failed judgement must not abort the poll — the listing stays
                // unrecorded so the next run retries it rather than losing it silently.
                warnings.push(`scoring failed for ${listing.url}: ${scored.error.message}`);
                continue;
            }

            verdicts.set(listing.fingerprint, scored.value);
            if (scored.value.score >= target.notify.minScore) {
                notifications.push({ listing, verdict: scored.value });
            }
        }
    }

    // Recorded AFTER judging: a crash mid-judge leaves the listing unseen, so the next
    // poll retries it instead of swallowing it forever.
    const toRecord = deps.noLlm === true ? fresh : fresh.filter((l) => verdicts.has(l.fingerprint));
    recordSeen(deps.store, toRecord, verdicts);

    finishRun(deps.store, runId, {
        status: 'ok',
        fetchMode: fetched.value.page.via,
        listingCount: listings.length,
        newCount: fresh.length,
    });

    return ok({
        targetId: target.id,
        extracted: listings.length,
        passedFilters: survivors.length,
        fresh: fresh.length,
        judged: verdicts.size,
        notifications,
        via: fetched.value.page.via,
        escalated: fetched.value.escalated,
        warnings,
        healed,
    });
}

function _identify(listing: Listing, targetId: string): IdentifiedListing {
    return {
        ...listing,
        targetId: asTargetId(targetId),
        fingerprint: fingerprintOf(targetId, listing.url),
    };
}

/**
 * Mutes are checked against both the listing URL and, when the recipe captured one, the
 * seller name in `extra`. Muting a dealer is far more useful than muting one of their
 * forty ads, so the seller check is the one that carries the weight.
 */
function _isMutedListing(store: Store, listing: IdentifiedListing, targetId: ReturnType<typeof asTargetId>): boolean {
    if (isMuted(store, 'listing', listing.url, targetId)) {
        return true;
    }
    const seller = listing.extra['seller'] ?? listing.extra['dealer'] ?? null;
    if (typeof seller === 'string' && seller.length > 0) {
        return isMuted(store, 'seller', seller, targetId);
    }
    return false;
}

export { isOk };
