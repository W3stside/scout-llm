/**
 * Recipe self-repair.
 *
 * Scrapers do not fail loudly. When a site redesigns, extraction returns zero listings and
 * the bot simply goes quiet — which is indistinguishable from a slow market, so the
 * failure can persist for weeks before anyone notices. Healing exists to close that gap:
 * regenerate the recipe against the live page, and if the new one works, carry on.
 *
 * Four rules keep it from doing more harm than the breakage it repairs:
 *
 *   Only on emptiness, never on errors. A block or a network fault also yields nothing,
 *   but regenerating cannot fix either — it just burns a model load and hits the site
 *   again while it is already refusing us.
 *
 *   Only after a streak. A single empty poll is unremarkable: a genuinely empty search, a
 *   transient hiccup. Healing on one would regenerate constantly.
 *
 *   Only if the result is better. A regenerated recipe that also extracts nothing must be
 *   discarded, not saved. Overwriting is irreversible in effect — the previous mapping is
 *   gone from the working tree — so a no-improvement heal keeps what it had.
 *
 *   Only once per cooldown. Failed attempts count toward it, so a site that is down does
 *   not get re-scraped and re-generated on every single poll.
 */

import type { Result } from '../core/result.ts';
import { isErr, ok } from '../core/result.ts';
import { asTargetId, type Recipe, type ScoutError, type Target } from '../core/types.ts';
import type { FetchedPage } from '../fetch/index.ts';
import { generateRecipe } from '../extract/generate.ts';
import { applyRecipe } from '../extract/selectors.ts';
import { saveRecipe } from '../extract/recipe.ts';
import type { OllamaOptions } from '../llm/ollama.ts';
import type { Store } from '../store/db.ts';
import { consecutiveEmptyRuns, lastHealAt, recordHeal } from '../store/listings.ts';

/** Consecutive empty runs before a recipe is considered stale rather than unlucky. */
export const EMPTY_RUNS_BEFORE_HEAL = 3;

/**
 * Minimum gap between attempts. Sized well above the longest sensible poll interval, so a
 * persistently broken target regenerates a handful of times a day rather than hourly.
 */
export const HEAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type HealDecision =
    | { readonly kind: 'skip'; readonly reason: string }
    | { readonly kind: 'attempt' };

/**
 * Whether this target has earned a heal attempt. Separated from the attempt itself so the
 * poll pipeline can decide cheaply, and so the rules are testable without a model.
 */
export function shouldHeal(store: Store, target: Target, extracted: number): HealDecision {
    if (extracted > 0) {
        return { kind: 'skip', reason: 'extraction produced listings' };
    }

    const streak = consecutiveEmptyRuns(store, asTargetId(target.id));
    if (streak < EMPTY_RUNS_BEFORE_HEAL) {
        return {
            kind: 'skip',
            reason: `${streak}/${EMPTY_RUNS_BEFORE_HEAL} consecutive empty runs — not stale yet`,
        };
    }

    const last = lastHealAt(store, asTargetId(target.id));
    if (last !== null) {
        const elapsed = Date.now() - last;
        if (elapsed < HEAL_COOLDOWN_MS) {
            const hours = Math.ceil((HEAL_COOLDOWN_MS - elapsed) / 3_600_000);
            return { kind: 'skip', reason: `healed recently — next attempt in ~${hours}h` };
        }
    }

    return { kind: 'attempt' };
}

export type HealResult = {
    readonly outcome: 'healed' | 'no-improvement' | 'failed';
    readonly message: string;
    /** Present only when the heal succeeded; the caller re-extracts with it. */
    readonly recipe: Recipe | null;
    readonly listingsAfter: number;
};

export type HealDeps = {
    readonly ollama: OllamaOptions;
    readonly store: Store;
    readonly recipesDir: string;
};

/**
 * Regenerate a target's recipe against a page already in hand.
 *
 * Takes the fetched page rather than a URL: the caller just fetched it to discover the
 * emptiness, and re-fetching would both waste a request and risk healing against a
 * *different* page than the one that failed.
 */
export async function healTarget(
    target: Target,
    current: Recipe | null,
    page: FetchedPage,
    deps: HealDeps,
): Promise<Result<HealResult, ScoutError>> {
    const targetId = asTargetId(target.id);
    const beforeList = current?.list ?? '(none)';

    const requiredFields: string[] = [];
    if (target.filters.price !== undefined) {
        requiredFields.push('price');
    }
    if (target.filters.year !== undefined) {
        requiredFields.push('year');
    }
    if (target.filters.km !== undefined) {
        requiredFields.push('km (mileage)');
    }

    const generated = await generateRecipe(deps.ollama, {
        url: target.url,
        body: page.body,
        contentType: page.contentType,
        criteria: target.criteria,
        requiredFields,
    });

    if (isErr(generated)) {
        recordHeal(deps.store, targetId, 'failed', {
            beforeList,
            error: generated.error.message,
        });
        return ok({
            outcome: 'failed',
            message: `could not generate a new recipe: ${generated.error.message}`,
            recipe: null,
            listingsAfter: 0,
        });
    }

    // Prove the candidate works against the very page that defeated the old one, BEFORE
    // writing it. Saving first and testing later would replace a merely-stale recipe with
    // an actively broken one and lose the original from the working tree.
    const candidate = generated.value.recipe;
    const extracted = applyRecipe(candidate, page);
    const listingsAfter = isErr(extracted) ? 0 : extracted.value.length;

    if (listingsAfter === 0) {
        recordHeal(deps.store, targetId, 'no-improvement', {
            beforeList,
            afterList: candidate.list,
            listingsAfter: 0,
            ...(isErr(extracted) ? { error: extracted.error.message } : {}),
        });
        return ok({
            outcome: 'no-improvement',
            message:
                'regenerated recipe also extracted 0 listings — keeping the existing one. ' +
                'The page may require a login, be blocking us, or genuinely have no results.',
            recipe: null,
            listingsAfter: 0,
        });
    }

    const saved = await saveRecipe(deps.recipesDir, target.id, candidate);
    if (isErr(saved)) {
        recordHeal(deps.store, targetId, 'failed', {
            beforeList,
            afterList: candidate.list,
            listingsAfter,
            error: saved.error.message,
        });
        return ok({
            outcome: 'failed',
            message: `new recipe works but could not be written: ${saved.error.message}`,
            recipe: null,
            listingsAfter,
        });
    }

    recordHeal(deps.store, targetId, 'healed', {
        beforeList,
        afterList: candidate.list,
        listingsAfter,
    });

    return ok({
        outcome: 'healed',
        message:
            `recipe regenerated — now extracting ${listingsAfter} listings.\n` +
            `  was: ${beforeList}\n  now: ${candidate.list}`,
        recipe: candidate,
        listingsAfter,
    });
}
