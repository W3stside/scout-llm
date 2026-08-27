/**
 * Message rendering. The escaping cases are the load-bearing ones: Telegram rejects a
 * whole message on malformed HTML, so an unescaped seller title does not render oddly —
 * it silently drops the notification entirely.
 */

import { describe, expect, it } from 'vitest';
import { decodeCallback, encodeCallback, escapeHtml, renderListing } from './render.ts';
import { asFingerprint, asTargetId, type IdentifiedListing, type Verdict } from '../core/types.ts';

function listing(partial: Partial<IdentifiedListing> = {}): IdentifiedListing {
    return {
        url: 'https://standvirtual.com/carros/anuncio/bmw-320d-ID1.html',
        title: 'BMW 320d Touring Pack M', price: 14500, currency: 'EUR',
        year: 2018, km: 142000, location: 'Porto', image: null, extra: {},
        fingerprint: asFingerprint('a'.repeat(32)), targetId: asTargetId('standvirtual-bmw'),
        ...partial,
    };
}

const VERDICT: Verdict = {
    score: 0.91, reason: 'Diesel Touring, 2018, private seller.',
    priceAssessment: 'bargain', photoNotes: null,
};

describe('escapeHtml', () => {
    it('escapes the characters Telegram parses as markup', () => {
        expect(escapeHtml('<b>PERFECT</b> & clean')).toBe('&lt;b&gt;PERFECT&lt;/b&gt; &amp; clean');
    });
});

describe('renderListing', () => {
    it('leads with title, price and the model\'s reason', () => {
        // pt-PT groups with U+00A0, so normalize whitespace rather than pinning the exact
        // separator byte — the assertion is about content, not about ICU's spacing choice.
        const out = renderListing(listing(), VERDICT).replace(/\s/g, ' ');
        expect(out).toContain('BMW 320d Touring Pack M');
        expect(out).toContain('14 500 EUR');
        expect(out).toContain('Diesel Touring, 2018, private seller.');
        expect(out).toContain('match 91%');
    });

    it('escapes a seller title containing markup', () => {
        // A real failure mode: sellers write "<<<TOP>>>" in titles. Unescaped, Telegram
        // rejects the message and the notification vanishes with no error surfaced.
        const out = renderListing(listing({ title: '<b>TOP</b> BMW & Co' }), VERDICT);
        expect(out).toContain('&lt;b&gt;TOP&lt;/b&gt; BMW &amp; Co');
        expect(out).not.toContain('<b>TOP</b>');
    });

    it('escapes model-supplied text too', () => {
        const out = renderListing(listing(), { ...VERDICT, reason: 'Looks <great> & cheap' });
        expect(out).toContain('Looks &lt;great&gt; &amp; cheap');
    });

    it('omits specs the seller did not state rather than printing "?"', () => {
        const out = renderListing(listing({ year: null, km: null, location: null }), VERDICT);
        expect(out).not.toContain('?');
        expect(out).not.toContain('null');
    });

    it('says "price on request" instead of showing a bare number', () => {
        expect(renderListing(listing({ price: null }), VERDICT)).toContain('price on request');
    });

    it('shows the price badge only when the model committed to one', () => {
        expect(renderListing(listing(), VERDICT)).toContain('bargain');
        const unknown = renderListing(listing(), { ...VERDICT, priceAssessment: 'unknown' });
        expect(unknown).not.toContain('bargain');
        expect(unknown).not.toContain('unknown');
    });

    it('includes photo notes only when photoGrade produced them', () => {
        expect(renderListing(listing(), VERDICT)).not.toContain('📷');
        const graded = renderListing(listing(), { ...VERDICT, photoNotes: 'Bodywork looks straight.' });
        expect(graded).toContain('📷');
        expect(graded).toContain('Bodywork looks straight.');
    });
});

describe('callback payloads', () => {
    it('round-trips within Telegram\'s 64-byte cap', () => {
        const encoded = encodeCallback('mute-seller', 'a'.repeat(32));
        expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64);
        expect(decodeCallback(encoded)).toEqual({ action: 'mute-seller', fingerprint: 'a'.repeat(32) });
    });

    it('rejects junk rather than guessing', () => {
        expect(decodeCallback('nonsense')).toBeNull();
        expect(decodeCallback('bogus:abc')).toBeNull();
        expect(decodeCallback('hide:')).toBeNull();
    });

    it('refuses to emit a truncated fingerprint that would match nothing', () => {
        const encoded = encodeCallback('mute-seller', 'x'.repeat(200));
        expect(encoded.startsWith('invalid:')).toBe(true);
        expect(decodeCallback(encoded)).toBeNull();
    });
});
