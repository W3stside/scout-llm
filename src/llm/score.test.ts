/**
 * Deterministic pre-filters. These run before any inference, so their behaviour has to be
 * exactly predictable — especially the missing-value rule, which decides whether a
 * seller's omission quietly hides a good match.
 */

import { describe, expect, it } from 'vitest';
import { isDecodableImage, rejectReason } from './score.ts';
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

describe('image format gating', () => {
    // Exercised via the exported helper's behaviour through fixtures rather than the
    // network: the property under test is which byte signatures are accepted.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)]);
    const avif = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(20)]);
    const html = Buffer.from('<!doctype html><html><body>blocked</body></html>');

    it('accepts JPEG and PNG', () => {
        expect(isDecodableImage(jpeg)).toBe(true);
        expect(isDecodableImage(png)).toBe(true);
    });

    it('rejects WebP and AVIF — llama.cpp cannot decode them', () => {
        // Sending one returns a bare 400 that fails the whole scoring call. This is the
        // bug that lost 11 of 13 OLX listings.
        expect(isDecodableImage(webp)).toBe(false);
        expect(isDecodableImage(avif)).toBe(false);
    });

    it('rejects an HTML error page a CDN returned with status 200', () => {
        expect(isDecodableImage(html)).toBe(false);
    });

    it('rejects a truncated response', () => {
        expect(isDecodableImage(Buffer.from([0xff, 0xd8]))).toBe(false);
    });
});
