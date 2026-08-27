/**
 * Turning scraped strings into numbers.
 *
 * This is where a European locale quietly ruins a scraper. On standvirtual.pt and
 * olx.pt a price renders as "14.500 €" — fourteen and a half thousand euros. Hand that
 * to parseFloat and you get 14.5, it sails under a `price.max: 15000` filter, and you
 * are notified about every car on the site. The inverse is just as bad: "1,250.00" read
 * as a comma-thousands number when it is really 1.25.
 *
 * The rule that resolves it: when both separators appear, the RIGHTMOST is the decimal
 * point. When only one appears, it is a thousands separator if it is followed by exactly
 * three digits and preceded by at least one — otherwise it is a decimal point.
 */

/**
 * Parse a number out of arbitrary scraped text.
 *
 * Returns null rather than NaN or 0 for anything unparseable. Null is a value the
 * filters and the store both understand as "the seller did not say"; 0 would silently
 * pass a `price.min` check and NaN poisons every comparison it touches.
 */
/**
 * The first contiguous number in a string, preserving grouping separators.
 *
 * `[ .,  ]` counts as grouping only when followed by exactly three digits and
 * not by a fourth — which is what keeps "14.500" and "142 000" intact while stopping the
 * token at the dash in "2016 - 169.000 km".
 */
function _firstNumberToken(raw: string): string | null {
    // Two alternatives tried separately, grouped-first. They are NOT one alternation: with
    // `\d{1,3}` and `*`, "2016" matched as just "201" because the shorter branch succeeded
    // at the same position and regex alternation takes the first that matches.
    //
    // Separators are spelled as escapes because the class includes U+00A0 and U+202F, which
    // Intl and most European sites use for grouping and which are invisible in source.
    const GROUPED = /-?\d+(?:[ .,\u00A0\u202F]\d{3})+(?:[.,]\d{1,2})?/;
    const PLAIN = /-?\d+(?:[.,]\d+)?/;

    const grouped = GROUPED.exec(raw);
    const plain = PLAIN.exec(raw);

    // Prefer whichever starts earlier; on a tie the grouped form is the truer read of the
    // same digits ("14.500" rather than "14").
    let chosen: string | null;
    if (grouped !== null && plain !== null) {
        chosen = grouped.index <= plain.index ? grouped[0] : plain[0];
    } else {
        chosen = grouped?.[0] ?? plain?.[0] ?? null;
    }
    if (chosen === null) {
        return null;
    }
    return chosen.replace(/[\u00A0\u202F]/g, ' ');
}

export function coerceNumber(raw: unknown): number | null {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? raw : null;
    }
    if (typeof raw !== 'string') {
        return null;
    }

    // Read the FIRST well-formed number rather than stripping every non-digit.
    //
    // Stripping was catastrophic on real pages: "2016 - 169.000 km" became 2016169000, and
    // a selector that accidentally caught a stylesheet turned every `12px` and `16px` into
    // one 8.5e+29 "price". A number has to be a contiguous token, not the digits that
    // happen to appear anywhere in the string.
    //
    // The token grammar allows space/dot/comma as GROUPING only when followed by exactly
    // three digits, so "142 000" and "14.500" stay whole while " - " ends the token.
    const token = _firstNumberToken(raw);
    if (token === null) {
        return null;
    }

    const negative = token.startsWith('-');
    // Spaces inside a token are always grouping — no locale uses one as a decimal point —
    // so they are removed before the dot/comma analysis below. Leaving them in meant
    // parseFloat("142 000") stopped at the space and returned 142.
    const digitsOnly = token.replace(/-/g, '').replace(/ /g, '');

    const lastDot = digitsOnly.lastIndexOf('.');
    const lastComma = digitsOnly.lastIndexOf(',');

    let normalized: string;

    if (lastDot >= 0 && lastComma >= 0) {
        // Both present — the rightmost is the decimal separator.
        const decimalAt = Math.max(lastDot, lastComma);
        const intPart = digitsOnly.slice(0, decimalAt).replace(/[.,]/g, '');
        const fracPart = digitsOnly.slice(decimalAt + 1).replace(/[.,]/g, '');
        normalized = `${intPart}.${fracPart}`;
    } else if (lastDot >= 0 || lastComma >= 0) {
        const sepAt = lastDot >= 0 ? lastDot : lastComma;
        const before = digitsOnly.slice(0, sepAt);
        const after = digitsOnly.slice(sepAt + 1);

        const looksLikeThousands =
            after.length === 3 &&
            before.length > 0 &&
            // "1.500" is thousands; "0.500" would be odd but is still thousands-shaped.
            // A second separator earlier (1.500.000) also settles it.
            !/[.,]/.test(after);

        if (looksLikeThousands) {
            normalized = `${before.replace(/[.,]/g, '')}${after}`;
        } else {
            normalized = `${before.replace(/[.,]/g, '')}.${after}`;
        }
    } else {
        normalized = digitsOnly;
    }

    const value = Number.parseFloat(normalized);
    if (!Number.isFinite(value)) {
        return null;
    }
    return negative ? -value : value;
}

/**
 * Parse a four-digit year, rejecting values that cannot be a vehicle year.
 *
 * Bounded because a recipe pointed at the wrong field routinely yields a mileage or an
 * ad id, and "year: 142000" passing a `year.min: 2015` filter is exactly the kind of
 * silent nonsense that makes a bot untrustworthy.
 */
export function coerceYear(raw: unknown): number | null {
    // Upper bound allows next-model-year listings, which appear late in a calendar year.
    const maxYear = new Date().getFullYear() + 2;

    const inRange = (candidate: number): boolean =>
        candidate >= 1900 && candidate <= maxYear;

    // Registration dates render as "01/2018", "01-2018" or "Janeiro 2018" as often as a
    // bare year. Stripping separators first would make that 12018, so pull a standalone
    // four-digit group out before falling back to numeric parsing.
    if (typeof raw === 'string') {
        const matches = raw.match(/\d{4}/g);
        if (matches !== null) {
            for (const match of matches) {
                const candidate = Number.parseInt(match, 10);
                if (inRange(candidate)) {
                    return candidate;
                }
            }
        }
    }

    const n = coerceNumber(raw);
    if (n === null) {
        return null;
    }
    const year = Math.trunc(n);
    return inRange(year) ? year : null;
}

/** Trim and collapse whitespace; empty becomes null so "missing" is one value, not two. */
export function coerceText(raw: unknown): string | null {
    if (typeof raw === 'number') {
        return String(raw);
    }
    if (typeof raw !== 'string') {
        return null;
    }
    const text = raw.replace(/\s+/g, ' ').trim();
    return text.length > 0 ? text : null;
}
