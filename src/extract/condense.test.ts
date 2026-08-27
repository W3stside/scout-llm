/**
 * Condensation. The property that matters is not "smaller" but "structure preserved":
 * whatever survives must still let a model see which key holds the price and what wraps
 * the repeating set.
 */

import { describe, expect, it } from 'vitest';
import { condenseHtml, condenseJson, condensePage } from './condense.ts';

describe('condenseJson', () => {
    it('samples long arrays but keeps the element shape', () => {
        const input = { ads: Array.from({ length: 60 }, (_v, i) => ({ id: i, title: `Car ${i}`, price: 1000 + i })) };
        const out = condenseJson(input) as { ads: unknown[] };
        expect(out.ads).toHaveLength(3); // 2 exemplars + the count marker
        expect(out.ads[0]).toEqual({ id: 0, title: 'Car 0', price: 1000 });
        expect(String(out.ads[2])).toContain('58 more');
    });

    it('clips long strings that carry no structural signal', () => {
        const out = condenseJson({ description: 'x'.repeat(500) }) as { description: string };
        expect(out.description.length).toBeLessThan(140);
        expect(out.description.endsWith('…')).toBe(true);
    });

    it('preserves nested key paths — the thing a recipe addresses', () => {
        const input = { props: { pageProps: { urqlState: { ads: [{ node: { price: { amount: 14500 } } }] } } } };
        const out = condenseJson(input) as Record<string, never>;
        expect(JSON.stringify(out)).toContain('pageProps');
        expect(JSON.stringify(out)).toContain('amount');
    });

    it('terminates on deeply nested structures instead of recursing forever', () => {
        let deep: unknown = { leaf: true };
        for (let i = 0; i < 50; i += 1) {
            deep = { nest: deep };
        }
        expect(() => condenseJson(deep)).not.toThrow();
        expect(JSON.stringify(condenseJson(deep))).toContain('…');
    });

    it('handles nulls and mixed types without losing keys', () => {
        const out = condenseJson({ a: null, b: 0, c: false, d: 'x' }) as Record<string, unknown>;
        expect(Object.keys(out)).toEqual(['a', 'b', 'c', 'd']);
        expect(out['b']).toBe(0);
        expect(out['c']).toBe(false);
    });
});

describe('condenseHtml', () => {
    const PAGE = `<html><head><style>.x{color:red}</style></head><body>
        <script>var tracking = 1;</script>
        <!-- a comment -->
        <main class="results css-1a2b3c">
            ${Array.from({ length: 40 }, (_v, i) => `
            <article class="ad css-9z8y7x" data-testid="listing-card" style="margin:0" onclick="x()">
                <h2><a href="/anuncio/car-ID${i}.html">BMW ${i}</a></h2>
                <span data-testid="price">14.500 €</span>
            </article>`).join('')}
        </main></body></html>`;

    it('drops scripts, styles and comments', () => {
        const out = condenseHtml(PAGE);
        expect(out).not.toContain('tracking');
        expect(out).not.toContain('color:red');
        expect(out).not.toContain('a comment');
    });

    it('collapses 40 identical cards to exemplars plus a marker', () => {
        const out = condenseHtml(PAGE);
        const cards = out.match(/data-testid="listing-card"/g) ?? [];
        expect(cards.length).toBe(2);
        expect(out).toContain('more siblings of the same shape');
    });

    it('keeps stable hooks a recipe should key on', () => {
        const out = condenseHtml(PAGE);
        expect(out).toContain('data-testid="price"');
        expect(out).toContain('href');
    });

    it('drops generated class hashes that would make a brittle selector', () => {
        const out = condenseHtml(PAGE);
        expect(out).not.toContain('css-1a2b3c');
        expect(out).not.toContain('css-9z8y7x');
        expect(out).toContain('ad'); // human-authored class survives
    });

    it('drops presentational and handler attributes', () => {
        const out = condenseHtml(PAGE);
        expect(out).not.toContain('onclick');
        expect(out).not.toContain('style=');
    });

    it('shrinks the payload substantially', () => {
        expect(condenseHtml(PAGE).length).toBeLessThan(PAGE.length / 3);
    });
});

describe('condensePage routing', () => {
    it('prefers __NEXT_DATA__ over markup when present', () => {
        const body = `<html><body><div>markup</div>
            <script id="__NEXT_DATA__" type="application/json">{"props":{"ads":[{"id":1}]}}</script>
            </body></html>`;
        const out = condensePage(body, 'text/html');
        expect(out.kind).toBe('nextdata');
        expect(out.text).toContain('props');
    });

    it('treats a JSON response as JSON', () => {
        const out = condensePage('{"data":[{"id":1}]}', 'application/json');
        expect(out.kind).toBe('json');
    });

    it('falls back to markup when there is no embedded payload', () => {
        const out = condensePage('<html><body><div class="ad">x</div></body></html>', 'text/html');
        expect(out.kind).toBe('html');
    });

    it('reports byte counts so the shrink ratio is observable', () => {
        const out = condensePage('<html><body>' + '<p class="x">hello</p>'.repeat(200) + '</body></html>', 'text/html');
        expect(out.originalBytes).toBeGreaterThan(out.condensedBytes);
    });
});
