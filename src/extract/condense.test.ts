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

describe('condenseJson — serialized JSON payloads', () => {
    it('parses and condenses a nested JSON string instead of clipping it', () => {
        // The StandVirtual/urql case: the listings live inside a serialized string. Clipping
        // it hides every field name from the model, which then invents them.
        const inner = JSON.stringify({
            advertSearch: {
                edges: Array.from({ length: 30 }, (_v, i) => ({
                    node: { id: i, title: `BMW ${i}`, price: { amount: { units: 5490, currencyCode: 'EUR' } } },
                })),
            },
        });
        const out = condenseJson({ urqlState: { '-699923': { data: inner } } });
        const text = JSON.stringify(out);

        expect(text).toContain('advertSearch');
        expect(text).toContain('currencyCode');   // a real field name is now visible
        expect(text).toContain('units');
        expect(text).not.toContain('\\"advertSearch');  // not left as an escaped string
    });

    it('leaves short strings alone even when they parse as JSON', () => {
        const out = condenseJson({ a: '{}', b: 'null', c: '[1,2]' }) as Record<string, unknown>;
        expect(out['a']).toBe('{}');
        expect(out['b']).toBe('null');
        expect(out['c']).toBe('[1,2]');
    });

    it('still clips a long string that is not JSON', () => {
        const out = condenseJson({ description: 'x'.repeat(900) }) as { description: string };
        expect(out.description.endsWith('…')).toBe(true);
    });
});

describe('condensePage — schema.org visibility', () => {
    it('surfaces ld+json alongside markup, since condenseHtml strips all scripts', () => {
        // Without this the best extraction route on sites like OLX is invisible to the
        // model, which can then only ever produce a class-name-keyed CSS recipe.
        const body = `<html><head>
            <script type="application/ld+json">${JSON.stringify({
                '@type': 'Product', name: 'BMW 320d', offers: { price: '14500', priceCurrency: 'EUR' },
            })}</script></head>
            <body><div data-cy="l-card"><a href="/d/ad-ID1.html">BMW 320d</a></div></body></html>`;

        const out = condensePage(body, 'text/html');
        expect(out.kind).toBe('html');
        expect(out.text).toContain('SCHEMA.ORG');
        expect(out.text).toContain('priceCurrency');
        expect(out.text).toContain('data-cy');   // markup still present as the alternative
    });

    it('omits the schema.org section entirely when the page has none', () => {
        const out = condensePage('<html><body><div class="ad">x</div></body></html>', 'text/html');
        expect(out.text).not.toContain('SCHEMA.ORG');
    });

    it('survives a malformed ld+json block without losing the valid ones', () => {
        const body = `<html><head>
            <script type="application/ld+json">{ nope }</script>
            <script type="application/ld+json">{"@type":"Product","name":"Keep"}</script>
            </head><body><p>x</p></body></html>`;
        const out = condensePage(body, 'text/html');
        expect(out.text).toContain('Keep');
    });
});

describe('condenseHtml — repeat collapsing must not destroy the listings', () => {
    it('keeps exemplar cards when every class is a generated hash', () => {
        // The OLX failure exactly: emotion class hashes are stripped, so every div ends up
        // with an identical signature, and the listings grid gets culled as a duplicate
        // sibling of the nav. Measured before the fix: 52 cards in, 0 out.
        const card = (i: number) => `
            <div class="css-${i}abc" data-cy="l-card">
                <a href="/d/anuncio/bmw-ID${i}.html">BMW ${i}</a>
                <p class="css-${i}xyz">10 850 €</p><span class="css-${i}k">173000 km</span>
            </div>`;
        const page = `<html><body>
            <nav class="css-nav1"><div class="css-n1">a</div><div class="css-n2">b</div>
                 <div class="css-n3">c</div><div class="css-n4">d</div></nav>
            <div class="css-grid">${Array.from({ length: 52 }, (_v, i) => card(i)).join('')}</div>
        </body></html>`;

        const out = condenseHtml(page);
        const cards = out.match(/data-cy="l-card"/g) ?? [];
        expect(cards.length).toBeGreaterThan(0);
        expect(cards.length).toBeLessThan(10);   // collapsed, but not annihilated
        expect(out).toContain('href');
        expect(out).toContain('€');
        expect(out).toContain('km');
    });

    it('keeps a large subtree from being grouped with small siblings', () => {
        const page = `<html><body><main>
            <div class="css-a">tiny</div><div class="css-b">tiny</div>
            <div class="css-c">tiny</div><div class="css-d">tiny</div>
            <div class="css-grid" data-cy="results">${'<article data-cy="l-card">listing content here</article>'.repeat(30)}</div>
        </main></body></html>`;
        const out = condenseHtml(page);
        expect(out).toContain('data-cy="results"');
        expect(out).toContain('data-cy="l-card"');
    });
});
