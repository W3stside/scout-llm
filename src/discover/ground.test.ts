/**
 * Site-map harvesting. The value is filtering: a homepage carries hundreds of links, and
 * only the shallow category paths are candidates for a search URL. Handing the model the
 * raw list would bury the useful paths and blow the context budget.
 */

import { describe, expect, it } from 'vitest';
import { describeExamples, describeSiteMap, exampleUrlsFor, type SiteMap } from './ground.ts';

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

describe('exampleUrlsFor', () => {
    it('matches the host across www and subdomains, and nothing else', () => {
        const urls = [
            'https://www.standvirtual.com/carros?x=1',
            'https://m.standvirtual.com/carros?x=2',
            'https://olx.pt/carros',
            'not a url',
        ];
        expect(exampleUrlsFor('standvirtual.com', urls)).toEqual([
            'https://www.standvirtual.com/carros?x=1',
            'https://m.standvirtual.com/carros?x=2',
        ]);
    });

    it('does not let a lookalike host smuggle its schema in', () => {
        // evil-standvirtual.com ends with the site name but is another operator entirely;
        // its URLs must never be presented as this site's known-good syntax.
        const urls = ['https://evil-standvirtual.com/carros?steal=1'];
        expect(exampleUrlsFor('standvirtual.com', urls)).toEqual([]);
    });
});

describe('describeExamples', () => {
    it('renders matching URLs with the copy-the-syntax instruction', () => {
        const text = describeExamples('standvirtual.com', [
            'https://www.standvirtual.com/carros?search[filter_float_price:to]=20000',
        ]);
        expect(text).toContain('copy their parameter syntax');
        expect(text).toContain('search[filter_float_price:to]=20000');
    });

    it('is empty when no known URL lives on the host, so callers can append blindly', () => {
        expect(describeExamples('coches.net', ['https://olx.pt/carros'])).toBe('');
    });
});
