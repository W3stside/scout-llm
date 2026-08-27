/**
 * Dedupe correctness. These cases are the actual failure modes that produce phantom
 * "new listing" alerts, so they are pinned rather than left to inspection.
 */

import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, fingerprintOf, hostOf } from './url.ts';

describe('canonicalizeUrl', () => {
    it('collapses tracking params that differ per render', () => {
        const a = canonicalizeUrl('https://olx.pt/d/anuncio/bmw-320d-ID123.html?utm_source=email');
        const b = canonicalizeUrl('https://olx.pt/d/anuncio/bmw-320d-ID123.html?utm_source=push&fbclid=xyz');
        expect(a).not.toBeNull();
        expect(a).toBe(b);
    });

    it('collapses the search-position breadcrumbs OLX appends to result links', () => {
        const a = canonicalizeUrl('https://olx.pt/d/anuncio/x-ID9.html?search_id=aaa&position=3');
        const b = canonicalizeUrl('https://olx.pt/d/anuncio/x-ID9.html?search_id=bbb&position=41');
        expect(a).toBe(b);
    });

    it('is insensitive to query order', () => {
        expect(canonicalizeUrl('https://x.com/a?b=2&a=1')).toBe(canonicalizeUrl('https://x.com/a?a=1&b=2'));
    });

    it('normalizes scheme, www, port, fragment and trailing slash', () => {
        expect(canonicalizeUrl('http://WWW.Example.com:443/listing/1/#photos')).toBe(
            'https://example.com/listing/1',
        );
    });

    it('keeps meaningful params that identify the resource', () => {
        const out = canonicalizeUrl('https://x.com/ad?id=99&utm_medium=cpc');
        expect(out).toBe('https://x.com/ad?id=99');
    });

    it('resolves relative hrefs against the page they were found on', () => {
        expect(canonicalizeUrl('/d/anuncio/bmw-ID5.html', 'https://www.olx.pt/carros/')).toBe(
            'https://olx.pt/d/anuncio/bmw-ID5.html',
        );
    });

    it('returns null on junk rather than throwing, so one bad field drops one listing', () => {
        expect(canonicalizeUrl('')).toBeNull();
        expect(canonicalizeUrl('not a url')).toBeNull();
        expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
        expect(canonicalizeUrl('mailto:a@b.c')).toBeNull();
    });

    it('does NOT merge genuinely different listings', () => {
        const a = canonicalizeUrl('https://olx.pt/d/anuncio/bmw-ID123.html');
        const b = canonicalizeUrl('https://olx.pt/d/anuncio/bmw-ID124.html');
        expect(a).not.toBe(b);
    });
});

describe('fingerprintOf', () => {
    it('is stable for the same target and url', () => {
        expect(fingerprintOf('t1', 'https://x.com/a')).toBe(fingerprintOf('t1', 'https://x.com/a'));
    });

    it('scopes by target, so one car under two saved searches alerts on each', () => {
        expect(fingerprintOf('t1', 'https://x.com/a')).not.toBe(fingerprintOf('t2', 'https://x.com/a'));
    });
});

describe('hostOf', () => {
    it('extracts the host for rate limiting', () => {
        expect(hostOf('https://WWW.StandVirtual.com/carros')).toBe('www.standvirtual.com');
    });
    it('returns null on junk', () => {
        expect(hostOf('nope')).toBeNull();
    });
});
