/**
 * Recipe application against fixtures shaped like the real thing: a Next.js
 * __NEXT_DATA__ blob, a schema.org block, and plain markup.
 *
 * The recurring theme is partial failure. Real listings omit fields constantly, and the
 * required behaviour is that one gap degrades one field — never the record, and never
 * the batch.
 */

import { describe, expect, it } from 'vitest';
import { applyRecipe } from './selectors.ts';
import { RecipeSchema, type Recipe } from '../core/types.ts';
import type { FetchedPage } from '../fetch/http.ts';
import { isOk } from '../core/result.ts';

function page(body: string, finalUrl = 'https://www.standvirtual.com/carros'): FetchedPage {
    return { url: finalUrl, finalUrl, status: 200, body, contentType: 'text/html', via: 'http' };
}

function recipe(partial: Omit<Recipe, 'generatedBy' | 'generatedAt' | 'host' | 'fingerprint'>): Recipe {
    return RecipeSchema.parse({
        generatedBy: 'test', generatedAt: '2026-08-27T00:00:00Z', host: 'standvirtual.com',
        ...partial,
    });
}

// --- json / __NEXT_DATA__ -----------------------------------------------------------

const NEXT_DATA = page(`<!doctype html><html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { ads: [
        { id: 1, title: 'BMW 320d Touring', price: { amount: '14.500', currency: 'EUR' },
          params: { year: '2018', mileage: '142.000 km' }, city: 'Porto',
          url: '/anuncio/bmw-320d-ID1.html', photo: 'https://cdn.sv.com/1.jpg' },
        { id: 2, title: 'BMW 320d', price: { amount: '18.900', currency: 'EUR' },
          params: { year: '01/2020', mileage: '89.000 km' }, city: 'Lisboa',
          url: '/anuncio/bmw-320d-ID2.html', photo: null },
        // Missing price and year entirely — must still yield a listing.
        { id: 3, title: 'BMW 318d', price: null, params: {}, city: null,
          url: '/anuncio/bmw-318d-ID3.html', photo: null },
    ] } },
})}</script></body></html>`);

const NEXT_RECIPE = recipe({
    mode: 'json', source: 'nextdata',
    list: '$.props.pageProps.ads[*]',
    fields: {
        url: '$.url', title: '$.title', price: '$.price.amount', currency: '$.price.currency',
        year: '$.params.year', km: '$.params.mileage', location: '$.city', image: '$.photo',
    },
});

describe('json mode over __NEXT_DATA__', () => {
    it('extracts every record', () => {
        const out = applyRecipe(NEXT_RECIPE, NEXT_DATA);
        expect(isOk(out)).toBe(true);
        if (!isOk(out)) return;
        expect(out.value).toHaveLength(3);
    });

    it('parses dot-thousands prices correctly, not as decimals', () => {
        const out = applyRecipe(NEXT_RECIPE, NEXT_DATA);
        if (!isOk(out)) throw new Error('expected ok');
        expect(out.value[0]?.price).toBe(14500);
        expect(out.value[1]?.price).toBe(18900);
    });

    it('resolves relative listing urls against the page', () => {
        const out = applyRecipe(NEXT_RECIPE, NEXT_DATA);
        if (!isOk(out)) throw new Error('expected ok');
        expect(out.value[0]?.url).toBe('https://standvirtual.com/anuncio/bmw-320d-ID1.html');
    });

    it('reads a year out of a registration date', () => {
        const out = applyRecipe(NEXT_RECIPE, NEXT_DATA);
        if (!isOk(out)) throw new Error('expected ok');
        expect(out.value[1]?.year).toBe(2020);
    });

    it('degrades a record with missing fields instead of dropping it', () => {
        const out = applyRecipe(NEXT_RECIPE, NEXT_DATA);
        if (!isOk(out)) throw new Error('expected ok');
        const third = out.value[2];
        expect(third?.title).toBe('BMW 318d');
        expect(third?.price).toBeNull();
        expect(third?.year).toBeNull();
        expect(third?.location).toBeNull();
    });

    it('reports empty-extraction when __NEXT_DATA__ is absent', () => {
        const out = applyRecipe(NEXT_RECIPE, page('<html><body>nothing</body></html>'));
        expect(isOk(out)).toBe(false);
        if (isOk(out)) return;
        expect(out.error.kind).toBe('empty-extraction');
    });

    it('yields an empty list — not an error — when the path matches nothing', () => {
        // A structural change that empties the list is what triggers healing upstream;
        // it is not a parse failure here.
        const wrong = recipe({ mode: 'json', source: 'nextdata', list: '$.props.nope[*]', fields: { url: '$.url' } });
        const out = applyRecipe(wrong, NEXT_DATA);
        expect(isOk(out)).toBe(true);
        if (!isOk(out)) return;
        expect(out.value).toHaveLength(0);
    });

    it('drops only the record whose url is unusable', () => {
        const body = page(`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
            ads: [{ url: '/ok-ID1.html', title: 'Keep' }, { url: null, title: 'Drop' }, { url: 'javascript:void(0)', title: 'Drop2' }],
        })}</script>`);
        const r = recipe({ mode: 'json', source: 'nextdata', list: '$.ads[*]', fields: { url: '$.url', title: '$.title' } });
        const out = applyRecipe(r, body);
        if (!isOk(out)) throw new Error('expected ok');
        expect(out.value).toHaveLength(1);
        expect(out.value[0]?.title).toBe('Keep');
    });

    it('routes unrecognized fields into extra', () => {
        const r = recipe({ mode: 'json', source: 'nextdata', list: '$.props.pageProps.ads[*]',
            fields: { url: '$.url', fuel: '$.params.mileage' } });
        const out = applyRecipe(r, NEXT_DATA);
        if (!isOk(out)) throw new Error('expected ok');
        expect(out.value[0]?.extra['fuel']).toBe('142.000 km');
    });
});

// --- response mode (the URL is an API) ----------------------------------------------

describe('json mode over a raw API response', () => {
    it('parses the body as JSON directly', () => {
        const api = page(JSON.stringify({ data: [{ id: 9, name: 'BMW', link: 'https://olx.pt/d/ad-ID9.html', p: '9 500 €' }] }),
            'https://www.olx.pt/api/v1/offers');
        const r = recipe({ mode: 'json', source: 'response', list: '$.data[*]',
            fields: { url: '$.link', title: '$.name', price: '$.p' } });
        const out = applyRecipe(r, api);
        if (!isOk(out)) throw new Error('expected ok');
        expect(out.value[0]?.price).toBe(9500);
        expect(out.value[0]?.url).toBe('https://olx.pt/d/ad-ID9.html');
    });
});

// --- jsonld -------------------------------------------------------------------------

describe('jsonld mode', () => {
    it('reads schema.org offers and survives a malformed sibling block', () => {
        const body = page(`<html><head>
            <script type="application/ld+json">{ this is not json }</script>
            <script type="application/ld+json">${JSON.stringify({
                '@type': 'ItemList',
                itemListElement: [
                    { item: { name: 'BMW 320d', url: 'https://sv.com/a-ID1', offers: { price: '14500', priceCurrency: 'EUR' } } },
                    { item: { name: 'BMW 318d', url: 'https://sv.com/b-ID2', offers: { price: '11250', priceCurrency: 'EUR' } } },
                ],
            })}</script></head><body></body></html>`);
        const r = recipe({ mode: 'jsonld', list: '$..itemListElement[*].item',
            fields: { url: '$.url', title: '$.name', price: '$.offers.price', currency: '$.offers.priceCurrency' } });
        const out = applyRecipe(r, body);
        if (!isOk(out)) throw new Error('expected ok');
        expect(out.value).toHaveLength(2);
        expect(out.value[0]?.price).toBe(14500);
        expect(out.value[1]?.title).toBe('BMW 318d');
    });
});

// --- css ----------------------------------------------------------------------------

describe('css mode', () => {
    const MARKUP = page(`<html><body><main>
        <article class="ad"><h2><a href="/anuncio/a-ID1.html">BMW 320d Touring</a></h2>
            <span data-testid="price">14.500 €</span><span class="loc">Porto</span>
            <img src="https://cdn.sv.com/1.jpg"></article>
        <article class="ad"><h2><a href="/anuncio/b-ID2.html">BMW 318d</a></h2>
            <span data-testid="price">11.250 €</span><span class="loc">Braga</span></article>
    </main></body></html>`);

    it('extracts text and attributes', () => {
        const r = recipe({ mode: 'css', list: 'article.ad',
            fields: {
                url: { sel: 'h2 a', attr: 'href' }, title: 'h2 a',
                price: '[data-testid="price"]', location: '.loc',
                image: { sel: 'img', attr: 'src' },
            } });
        const out = applyRecipe(r, MARKUP);
        if (!isOk(out)) throw new Error('expected ok');
        expect(out.value).toHaveLength(2);
        expect(out.value[0]?.title).toBe('BMW 320d Touring');
        expect(out.value[0]?.price).toBe(14500);
        expect(out.value[0]?.url).toBe('https://standvirtual.com/anuncio/a-ID1.html');
        expect(out.value[0]?.image).toBe('https://cdn.sv.com/1.jpg');
    });

    it('leaves a field null when its selector misses in one record only', () => {
        const r = recipe({ mode: 'css', list: 'article.ad',
            fields: { url: { sel: 'h2 a', attr: 'href' }, image: { sel: 'img', attr: 'src' } } });
        const out = applyRecipe(r, MARKUP);
        if (!isOk(out)) throw new Error('expected ok');
        expect(out.value[0]?.image).toBe('https://cdn.sv.com/1.jpg');
        expect(out.value[1]?.image).toBeNull();
    });
});
