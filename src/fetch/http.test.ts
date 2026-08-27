/**
 * Block detection. The value here is catching the 200-with-a-challenge-page case:
 * a status code alone would call that success, the extractor would find nothing, and
 * the poll would report "0 listings" instead of falling back to the browser.
 */

import { describe, expect, it } from 'vitest';
import { classifyResponse } from './http.ts';

const REAL_PAGE = `<!doctype html><html><head><title>BMW</title></head><body>${'<div class="listing">car</div>'.repeat(200)}</body></html>`;

describe('classifyResponse', () => {
    it('accepts a substantial 200', () => {
        expect(classifyResponse(200, REAL_PAGE)).toBe('ok');
    });

    it('flags hard block status codes', () => {
        expect(classifyResponse(403, REAL_PAGE)).toBe('blocked');
        expect(classifyResponse(429, REAL_PAGE)).toBe('blocked');
    });

    it('flags a 200 Cloudflare interstitial — the silent failure that matters most', () => {
        const challenge = `<html><head><title>Just a moment...</title></head>
            <body><div class="cf-browser-verification">${'x'.repeat(5000)}</div></body></html>`;
        expect(classifyResponse(200, challenge)).toBe('blocked');
    });

    it('flags DataDome and PerimeterX interstitials', () => {
        expect(classifyResponse(200, `<html><body>datadome${'x'.repeat(5000)}</body></html>`)).toBe('blocked');
        expect(classifyResponse(200, `<html><body>px-captcha${'x'.repeat(5000)}</body></html>`)).toBe('blocked');
    });

    it('flags a thin JS-only shell', () => {
        expect(classifyResponse(200, '<html><body><div id="root"></div></body></html>')).toBe('blocked');
    });

    it('does NOT flag a short but legitimate JSON API response', () => {
        // A compact JSON payload is genuinely under the size floor; treating it as a
        // block would break every `mode: response` recipe.
        expect(classifyResponse(200, '{"results":[{"id":1,"title":"BMW 320d"}]}')).toBe('ok');
        expect(classifyResponse(200, '[{"id":1}]')).toBe('ok');
    });

    it('separates not-found from blocked so healing is not triggered by a dead URL', () => {
        expect(classifyResponse(404, '')).toBe('not-found');
        expect(classifyResponse(503, '')).toBe('server-error');
    });
});
