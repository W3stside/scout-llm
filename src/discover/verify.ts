/**
 * Did the search URL actually filter anything?
 *
 * This exists because of one specific, nasty property of classified sites: an unrecognised
 * query parameter is not an error. `?price_max=15000` on a site expecting
 * `search[filter_float_price:to]` returns HTTP 200, a full page, and every listing at any
 * price. Extraction succeeds. The recipe is fine. Everything looks healthy, and the search
 * is worthless.
 *
 * The only reliable signal is the results themselves: if the shopper asked for under
 * 15,000 and a third of the results are above it, that parameter did not apply. Pure and
 * synchronous, so the discovery loop can score candidate URLs without another model call.
 */

import type { Listing } from '../core/types.ts';
import type { SearchIntent } from './intent.ts';

export type ConstraintCheck = {
    readonly name: string;
    /** Listings that stated a value for this field — the only ones that can be judged. */
    readonly stated: number;
    readonly satisfied: number;
    /** satisfied / stated, or null when nothing stated a value. */
    readonly ratio: number | null;
};

export type Verification = {
    readonly checks: readonly ConstraintCheck[];
    /** Worst ratio across checks, or null when no numeric constraint could be judged. */
    readonly weakest: number | null;
    /** Whether the URL looks genuinely filtered. */
    readonly looksFiltered: boolean;
    readonly summary: string;
};

/**
 * A filter is credible above this share of conforming results.
 *
 * Not 1.0 deliberately. Sites legitimately include a few promoted or "similar" listings
 * that ignore the active filters — OLX does exactly this — so demanding perfection would
 * reject working URLs. Well below 0.85 means the parameter was ignored outright.
 */
const FILTERED_THRESHOLD = 0.85;

/** Below this many judgeable listings, the ratio is noise rather than evidence. */
const MIN_SAMPLE = 4;

function _check(
    name: string,
    listings: readonly Listing[],
    read: (l: Listing) => number | null,
    ok: (value: number) => boolean,
): ConstraintCheck | null {
    let stated = 0;
    let satisfied = 0;
    for (const listing of listings) {
        const value = read(listing);
        if (value === null) {
            continue;
        }
        stated += 1;
        if (ok(value)) {
            satisfied += 1;
        }
    }
    if (stated === 0) {
        return null;
    }
    return { name, stated, satisfied, ratio: satisfied / stated };
}

export function verifyAgainstIntent(
    listings: readonly Listing[],
    intent: SearchIntent,
): Verification {
    const checks: ConstraintCheck[] = [];

    if (intent.priceMax !== null) {
        const c = _check('price cap', listings, (l) => l.price, (v) => v <= (intent.priceMax ?? Infinity));
        if (c !== null) {
            checks.push(c);
        }
    }
    if (intent.priceMin !== null) {
        const c = _check('price floor', listings, (l) => l.price, (v) => v >= (intent.priceMin ?? -Infinity));
        if (c !== null) {
            checks.push(c);
        }
    }
    if (intent.yearMin !== null) {
        const c = _check('year from', listings, (l) => l.year, (v) => v >= (intent.yearMin ?? -Infinity));
        if (c !== null) {
            checks.push(c);
        }
    }
    if (intent.yearMax !== null) {
        const c = _check('year to', listings, (l) => l.year, (v) => v <= (intent.yearMax ?? Infinity));
        if (c !== null) {
            checks.push(c);
        }
    }
    if (intent.kmMax !== null) {
        const c = _check('mileage cap', listings, (l) => l.km, (v) => v <= (intent.kmMax ?? Infinity));
        if (c !== null) {
            checks.push(c);
        }
    }

    // Only checks with a meaningful sample decide the verdict; a lone listing stating a
    // price says nothing about whether the site filtered on it.
    const judgeable = checks.filter((c) => c.stated >= MIN_SAMPLE && c.ratio !== null);
    const weakest =
        judgeable.length > 0 ? Math.min(...judgeable.map((c) => c.ratio ?? 1)) : null;

    // An empty result set is a failure of a different kind — too narrow, or blocked — and
    // must not be reported as perfectly filtered.
    const looksFiltered =
        listings.length > 0 && (weakest === null || weakest >= FILTERED_THRESHOLD);

    const lines = checks.map((c) => {
        const pct = c.ratio === null ? '—' : `${Math.round(c.ratio * 100)}%`;
        const verdict =
            c.stated < MIN_SAMPLE
                ? 'too few to judge'
                : (c.ratio ?? 0) >= FILTERED_THRESHOLD
                  ? 'applied'
                  : 'NOT applied';
        return `${c.name}: ${c.satisfied}/${c.stated} (${pct}) — ${verdict}`;
    });

    const summary =
        listings.length === 0
            ? 'no listings extracted — the URL may be wrong, too narrow, or blocked'
            : lines.length === 0
              ? `${listings.length} listings; no numeric constraint could be checked`
              : `${listings.length} listings\n${lines.join('\n')}`;

    return { checks, weakest, looksFiltered, summary };
}

/**
 * Rank candidate URLs. Higher is better.
 *
 * Deliberately prefers a correctly-filtered small result set over a large unfiltered one:
 * the whole point is a search that already excludes what you do not want. The listing count
 * only breaks ties, and its contribution is logarithmic so a site padding results cannot
 * outrank one that actually filtered.
 */
export function scoreCandidate(listings: readonly Listing[], verification: Verification): number {
    if (listings.length === 0) {
        return 0;
    }
    const filterScore = verification.weakest ?? 0.6; // unjudgeable sits below a proven pass
    const sizeScore = Math.min(Math.log10(listings.length + 1) / 2, 1);
    return filterScore * 10 + sizeScore;
}

/**
 * Feedback for the next attempt, phrased so the model can act on it.
 *
 * Naming the parameter that failed is what turns a retry into a correction rather than
 * another guess at the same schema.
 */
export function retryHint(verification: Verification, listings: readonly Listing[]): string {
    if (listings.length === 0) {
        return 'That URL returned no listings at all. It may be a landing page rather than search results, the path may be wrong, or the filters may be so narrow nothing matches. Try a broader path with fewer parameters.';
    }
    const failed = verification.checks.filter(
        (c) => c.stated >= MIN_SAMPLE && (c.ratio ?? 1) < FILTERED_THRESHOLD,
    );
    if (failed.length === 0) {
        return 'Filters appear to have applied.';
    }
    return (
        `These constraints were NOT applied by the URL — the site returned results ignoring them: ` +
        failed.map((c) => `${c.name} (only ${Math.round((c.ratio ?? 0) * 100)}% conform)`).join(', ') +
        `. The query parameter names are probably wrong for this site. Try different parameter ` +
        `names, or encode the constraint in the URL PATH instead of the query string.`
    );
}
