/**
 * Locale parsing. The "14.500 €" case is the one that matters most: misreading it as
 * 14.5 lets every car on the site through a `price.max: 15000` filter.
 */

import { describe, expect, it } from 'vitest';
import { coerceNumber, coerceText, coerceYear } from './coerce.ts';

describe('coerceNumber — Portuguese/European formats', () => {
    it('reads dot-as-thousands, the format StandVirtual and OLX actually use', () => {
        expect(coerceNumber('14.500 €')).toBe(14500);
        expect(coerceNumber('1.500')).toBe(1500);
        expect(coerceNumber('142.000 km')).toBe(142000);
    });

    it('reads space-as-thousands', () => {
        expect(coerceNumber('14 500 €')).toBe(14500);
        expect(coerceNumber('142 000 km')).toBe(142000);
        expect(coerceNumber('14 500')).toBe(14500); // non-breaking space
    });

    it('reads comma-as-decimal when a dot-thousands is also present', () => {
        expect(coerceNumber('14.500,50')).toBe(14500.5);
        expect(coerceNumber('1.234.567,89')).toBe(1234567.89);
    });

    it('reads anglo comma-thousands with dot-decimal', () => {
        expect(coerceNumber('14,500.50')).toBe(14500.5);
        expect(coerceNumber('1,250')).toBe(1250);
    });

    it('reads a bare decimal', () => {
        expect(coerceNumber('14.5')).toBe(14.5);
        expect(coerceNumber('0,75')).toBe(0.75);
    });

    it('passes through real numbers', () => {
        expect(coerceNumber(14500)).toBe(14500);
        expect(coerceNumber(0)).toBe(0);
    });

    it('returns null — never 0 or NaN — for absent or junk values', () => {
        expect(coerceNumber('')).toBeNull();
        expect(coerceNumber('Sob consulta')).toBeNull();
        expect(coerceNumber(null)).toBeNull();
        expect(coerceNumber(undefined)).toBeNull();
        expect(coerceNumber({})).toBeNull();
        expect(coerceNumber(Number.NaN)).toBeNull();
    });

    it('handles negatives', () => {
        expect(coerceNumber('-1.500')).toBe(-1500);
    });
});

describe('coerceYear', () => {
    it('accepts plausible vehicle years', () => {
        expect(coerceYear('2018')).toBe(2018);
        expect(coerceYear(2015)).toBe(2015);
    });

    it('pulls the year out of a registration date', () => {
        // These render as often as a bare year on PT car listings. Naive separator
        // stripping would turn "01/2018" into 12018.
        expect(coerceYear('01/2018')).toBe(2018);
        expect(coerceYear('01-2018')).toBe(2018);
        expect(coerceYear('Janeiro 2018')).toBe(2018);
        expect(coerceYear('2018/03')).toBe(2018);
    });

    it('rejects a mileage that landed in the year field — the real misparse', () => {
        // A recipe pointed one parameter off yields this; unbounded it would pass a
        // `year.min: 2015` filter and quietly admit everything.
        expect(coerceYear('142000')).toBeNull();
        expect(coerceYear(142000)).toBeNull();
    });

    it('rejects out-of-range years', () => {
        expect(coerceYear('1800')).toBeNull();
        expect(coerceYear('2999')).toBeNull();
    });

    it('returns null for junk', () => {
        expect(coerceYear('n/a')).toBeNull();
        expect(coerceYear(null)).toBeNull();
    });
});

describe('coerceText', () => {
    it('collapses whitespace', () => {
        expect(coerceText('  BMW   320d \n Touring ')).toBe('BMW 320d Touring');
    });
    it('maps empty to null so absent is one value', () => {
        expect(coerceText('   ')).toBeNull();
        expect(coerceText('')).toBeNull();
        expect(coerceText(null)).toBeNull();
    });
    it('stringifies numbers', () => {
        expect(coerceText(2018)).toBe('2018');
    });
});

describe('coerceNumber — must not merge digits across separators', () => {
    it('stops at a dash instead of concatenating two values', () => {
        // OLX renders "2016 - 169.000 km" in one text node. Stripping every non-digit
        // produced 2016169000, which sailed past a `km.max: 200000` filter as nonsense.
        expect(coerceNumber('2016 - 169.000 km')).toBe(2016);
    });

    it('ignores trailing junk after the first number', () => {
        expect(coerceNumber('10.850 €Negociável')).toBe(10850);
        expect(coerceNumber('14.100 € · Porto · hoje')).toBe(14100);
    });

    it('does not turn a leaked stylesheet into an astronomical number', () => {
        // The real failure: a selector caught an inline <style> and every 12px/16px became
        // digits, yielding a price of 8.499280100112161e+29.
        const leaked = '8.499 €.css-o2j8v0{font-size:var(--fontSizeBodyExtraSmall,12px);line-height:16px;color:#02282C;}';
        expect(coerceNumber(leaked)).toBe(8499);
    });

    it('still keeps grouped thousands whole', () => {
        expect(coerceNumber('142 000 km')).toBe(142000);
        expect(coerceNumber('1.234.567,89 €')).toBe(1234567.89);
    });
});
