/**
 * Deterministic pre-filters. These run before any inference, so their behaviour has to be
 * exactly predictable — especially the missing-value rule, which decides whether a
 * seller's omission quietly hides a good match.
 */

import { describe, expect, it } from 'vitest';
import { rejectReason } from './score.ts';
import type { Listing } from '../core/types.ts';

function listing(partial: Partial<Listing>): Listing {
    return {
        url: 'https://sv.com/a-ID1', title: 'BMW 320d Touring', price: 14500, currency: 'EUR',
        year: 2018, km: 142000, location: 'Porto', image: null, extra: {}, ...partial,
    };
}

const FILTERS = {
    price: { max: 15000 },
    year: { min: 2015 },
    km: { max: 200000 },
    excludeTitle: ['para peças', 'acidentado'],
};

describe('rejectReason', () => {
    it('accepts a listing inside every bound', () => {
        expect(rejectReason(listing({}), FILTERS)).toBeNull();
    });

    it('rejects on price with a reason naming the bound', () => {
        const reason = rejectReason(listing({ price: 19000 }), FILTERS);
        expect(reason).toContain('price');
        expect(reason).toContain('15000');
    });

    it('rejects on year and mileage', () => {
        expect(rejectReason(listing({ year: 2012 }), FILTERS)).toContain('year');
        expect(rejectReason(listing({ km: 260000 }), FILTERS)).toContain('km');
    });

    it('does NOT reject when the seller omitted the value', () => {
        // The important rule: a null price means "not stated", not "fails the filter".
        // Rejecting here would silently hide listings whose price is on request.
        expect(rejectReason(listing({ price: null }), FILTERS)).toBeNull();
        expect(rejectReason(listing({ year: null }), FILTERS)).toBeNull();
        expect(rejectReason(listing({ km: null }), FILTERS)).toBeNull();
    });

    it('rejects on excluded title substrings, case-insensitively', () => {
        expect(rejectReason(listing({ title: 'BMW 320d PARA PEÇAS' }), FILTERS)).toContain('para peças');
        expect(rejectReason(listing({ title: 'BMW acidentado' }), FILTERS)).toContain('acidentado');
    });

    it('tolerates a missing title', () => {
        expect(rejectReason(listing({ title: null }), FILTERS)).toBeNull();
    });

    it('applies no bound when the filter is absent', () => {
        expect(rejectReason(listing({ price: 999999 }), { excludeTitle: [] })).toBeNull();
    });

    it('honours a min bound as well as a max', () => {
        expect(rejectReason(listing({ price: 500 }), { price: { min: 1000 }, excludeTitle: [] })).toContain('below min');
    });
});
