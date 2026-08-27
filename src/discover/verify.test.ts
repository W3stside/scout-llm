/**
 * Filter verification. The case that matters is the silent one: a URL returning HTTP 200,
 * a full page, a working recipe, and every listing ignoring the price cap. Nothing else in
 * the system can tell that apart from a search that worked.
 */

import { describe, expect, it } from 'vitest';
import { retryHint, scoreCandidate, verifyAgainstIntent } from './verify.ts';
import type { SearchIntent } from './intent.ts';
import type { Listing } from '../core/types.ts';

const INTENT: SearchIntent = {
    category: 'cars', brand: 'BMW', model: '3 Series',
    priceMin: null, priceMax: 15000, yearMin: 2015, yearMax: null, kmMax: 200000,
    attributes: ['estate', 'diesel'], location: 'Porto', country: 'pt', exclude: ['salvado'],
};

function listing(price: number | null, year: number | null, km: number | null = 100000): Listing {
    return {
        url: `https://x.com/${price}-${year}-${km}`, title: 'BMW', price, currency: 'EUR',
        year, km, location: 'Porto', image: null, extra: {},
    };
}

describe('verifyAgainstIntent', () => {
    it('recognises a properly filtered result set', () => {
        const listings = [
            listing(9000, 2018), listing(12000, 2019), listing(14500, 2016),
            listing(11000, 2020), listing(13750, 2017), listing(8500, 2021),
        ];
        const v = verifyAgainstIntent(listings, INTENT);
        expect(v.looksFiltered).toBe(true);
        expect(v.summary).toContain('applied');
        expect(v.summary).not.toContain('NOT applied');
    });

    it('catches a price cap the site silently ignored — the whole point', () => {
        // Exactly what a wrong query parameter produces: 200 OK, full page, no filtering.
        const listings = [
            listing(38490, 2023), listing(24500, 2020), listing(26750, 2021),
            listing(22900, 2021), listing(9000, 2018), listing(41000, 2022),
        ];
        const v = verifyAgainstIntent(listings, INTENT);
        expect(v.looksFiltered).toBe(false);
        expect(v.summary).toContain('NOT applied');
        expect(retryHint(v, listings)).toContain('price cap');
    });

    it('tolerates a few promoted listings that ignore the filters', () => {
        // OLX genuinely injects these. Demanding 100% would reject working URLs.
        const listings = [
            ...Array.from({ length: 18 }, (_v, i) => listing(10000 + i * 100, 2018)),
            listing(38000, 2023), // one promoted outlier
        ];
        const v = verifyAgainstIntent(listings, INTENT);
        expect(v.looksFiltered).toBe(true);
    });

    it('does not judge on a sample too small to mean anything', () => {
        const listings = [listing(38000, 2023), listing(41000, 2022)];
        const v = verifyAgainstIntent(listings, INTENT);
        // Two listings cannot distinguish "unfiltered" from "a thin but correct result set".
        expect(v.summary).toContain('too few to judge');
        expect(v.looksFiltered).toBe(true);
    });

    it('never reports an empty result set as filtered', () => {
        const v = verifyAgainstIntent([], INTENT);
        expect(v.looksFiltered).toBe(false);
        expect(v.summary).toContain('no listings');
        expect(retryHint(v, [])).toContain('no listings at all');
    });

    it('ignores listings that stated no value, rather than counting them as failures', () => {
        const listings = [
            listing(null, null), listing(null, null), listing(null, null),
            listing(9000, 2018), listing(12000, 2019), listing(14000, 2020),
            listing(11000, 2017), listing(13000, 2016),
        ];
        const v = verifyAgainstIntent(listings, INTENT);
        expect(v.looksFiltered).toBe(true);
        const priceCheck = v.checks.find((c) => c.name === 'price cap');
        expect(priceCheck?.stated).toBe(5);
    });

    it('reports honestly when no numeric constraint is checkable', () => {
        const bare: SearchIntent = { ...INTENT, priceMax: null, yearMin: null, kmMax: null };
        const v = verifyAgainstIntent([listing(9000, 2018)], bare);
        expect(v.summary).toContain('no numeric constraint');
        expect(v.weakest).toBeNull();
    });

    it('flags a mileage cap independently of price', () => {
        const listings = Array.from({ length: 8 }, (_v, i) => listing(9000 + i, 2018, 400000));
        const v = verifyAgainstIntent(listings, INTENT);
        expect(v.looksFiltered).toBe(false);
        expect(retryHint(v, listings)).toContain('mileage cap');
    });
});

describe('scoreCandidate', () => {
    it('prefers a correctly filtered small set over a large unfiltered one', () => {
        const good = Array.from({ length: 20 }, (_v, i) => listing(10000 + i, 2018));
        const bad = Array.from({ length: 2000 }, (_v, i) => listing(30000 + i, 2023));
        const goodScore = scoreCandidate(good, verifyAgainstIntent(good, INTENT));
        const badScore = scoreCandidate(bad, verifyAgainstIntent(bad, INTENT));
        expect(goodScore).toBeGreaterThan(badScore);
    });

    it('scores an empty result set at zero', () => {
        expect(scoreCandidate([], verifyAgainstIntent([], INTENT))).toBe(0);
    });

    it('breaks ties on size when filtering is equally good', () => {
        const few = Array.from({ length: 5 }, (_v, i) => listing(10000 + i, 2018));
        const many = Array.from({ length: 50 }, (_v, i) => listing(10000 + i, 2018));
        expect(scoreCandidate(many, verifyAgainstIntent(many, INTENT)))
            .toBeGreaterThan(scoreCandidate(few, verifyAgainstIntent(few, INTENT)));
    });
});
