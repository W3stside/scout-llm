/**
 * Site-map harvesting. The value is filtering: a homepage carries hundreds of links, and
 * only the shallow category paths are candidates for a search URL. Handing the model the
 * raw list would bury the useful paths and blow the context budget.
 */

import { describe, expect, it } from 'vitest';
import { describeSiteMap, type SiteMap } from './ground.ts';

describe('describeSiteMap', () => {
    it('tells the model to choose rather than invent', () => {
        const map: SiteMap = {
            host: 'olx.pt',
            paths: ['/carros-motos-e-barcos', '/carros-motos-e-barcos/carros'],
            queryParams: ['search[filter_float_price:to]', 'page'],
        };
        const text = describeSiteMap(map);
        expect(text).toContain('do not invent');
        expect(text).toContain('/carros-motos-e-barcos/carros');
        expect(text).toContain('search[filter_float_price:to]');
    });

    it('says so explicitly when no query parameters were observed', () => {
        // Silence here would read as "no filters exist"; the model needs to know it is
        // guessing parameter names rather than choosing from known ones.
        const map: SiteMap = { host: 'x.com', paths: ['/cars'], queryParams: [] };
        expect(describeSiteMap(map)).toContain('no query parameters observed');
    });
});
