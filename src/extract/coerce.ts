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
export function coerceNumber(raw: unknown): number | null {
    if (typeof raw === 'number') {
        return Number.isFinite(raw) ? raw : null;
    }
    if (typeof raw !== 'string') {
        return null;
    }

    // Keep digits and both separators; drop currency symbols, NBSP, thin spaces, units.
    const cleaned = raw.replace(/[^\d.,-]/g, '');
    if (cleaned.length === 0) {
        return null;
    }

    const negative = cleaned.startsWith('-');
    const digitsOnly = cleaned.replace(/-/g, '');

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
