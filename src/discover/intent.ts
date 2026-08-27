/**
 * Turning "BMW estate under 15k, diesel, 2015+" into something machine-checkable.
 *
 * This is the keystone of URL discovery. Extracting the numbers ONCE, up front, does three
 * jobs at the same time:
 *
 *   1. builds the search URL (the model needs to know 15000 is a price cap)
 *   2. verifies the URL worked (results whose prices ignore the cap prove it did not)
 *   3. populates the target's deterministic filters, so you no longer hand-write them
 *
 * Point 2 is the one that matters. A wrong query parameter does not error — the site
 * returns 200 and silently ignores it. Without a structured intent to check the results
 * against, a URL that filtered nothing is indistinguishable from one that worked.
 */

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import { chatStructured, type OllamaOptions } from '../llm/ollama.ts';
import type { ScoutError } from '../core/types.ts';

export const SearchIntentSchema = z.object({
    /** What is being shopped for, in the site's terms: "carros", "bags", "flights". */
    category: z.string(),
    /** Brand/maker if stated, else null. */
    brand: z.string().nullable(),
    /** Model or line if stated, e.g. "3 Series", "Touring". */
    model: z.string().nullable(),

    priceMin: z.number().nullable(),
    priceMax: z.number().nullable(),
    yearMin: z.number().nullable(),
    yearMax: z.number().nullable(),
    kmMax: z.number().nullable(),

    /** Free-form attributes the site may or may not expose as filters. */
    attributes: z.array(z.string()),
    /** City/region if stated. */
    location: z.string().nullable(),

    /**
     * Country the search should target, as a TLD hint ("pt", "uk"). Drives which regional
     * site is chosen; defaults are set by the caller, not guessed silently here.
     */
    country: z.string().nullable(),

    /** Words that should disqualify a listing outright, e.g. "salvage", "para peças". */
    exclude: z.array(z.string()),
});

export type SearchIntent = z.infer<typeof SearchIntentSchema>;

const SYSTEM_PROMPT = `You convert a shopper's plain-English description into structured search intent.

Extract ONLY what the person actually said. Never invent a constraint they did not state —
an imagined price cap silently hides listings they wanted to see.

- Prices: bare numbers in the local currency. "15k" -> 15000, "under 15 thousand" -> 15000.
- Years: four digits. "after 2015" and "2015 or newer" both mean yearMin 2015.
- Mileage: kilometres. "under 200k km" -> 200000.
- attributes: short lowercase terms a site might expose as a filter — body style, fuel,
  transmission, colour, condition. "estate", "diesel", "manual", "private seller".
- exclude: things they said to AVOID. Damage words belong here, not in attributes.
- category: the top-level thing being shopped for, in ordinary words: cars, motorbikes,
  bags, flights, property.
- country: infer from any place they name, as a TLD ("Porto" -> pt, "Manchester" -> uk).
  null if they named no place.

Use null for anything not stated. Empty arrays where nothing applies.`;

export async function parseIntent(
    ollama: OllamaOptions,
    description: string,
): Promise<Result<SearchIntent, ScoutError>> {
    return chatStructured(
        ollama,
        'extract',
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: description },
        ],
        SearchIntentSchema,
    );
}

/**
 * Render the intent back into the target file's deterministic filter block.
 *
 * Only constraints the shopper actually stated become filters. A null stays null rather
 * than becoming a default bound — a filter nobody asked for is worse than no filter,
 * because it silently discards listings while looking deliberate.
 */
export function intentToFilters(intent: SearchIntent): {
    price?: { min?: number; max?: number };
    year?: { min?: number; max?: number };
    km?: { max?: number };
    excludeTitle: string[];
} {
    const filters: ReturnType<typeof intentToFilters> = { excludeTitle: [...intent.exclude] };

    if (intent.priceMin !== null || intent.priceMax !== null) {
        filters.price = {
            ...(intent.priceMin !== null ? { min: intent.priceMin } : {}),
            ...(intent.priceMax !== null ? { max: intent.priceMax } : {}),
        };
    }
    if (intent.yearMin !== null || intent.yearMax !== null) {
        filters.year = {
            ...(intent.yearMin !== null ? { min: intent.yearMin } : {}),
            ...(intent.yearMax !== null ? { max: intent.yearMax } : {}),
        };
    }
    if (intent.kmMax !== null) {
        filters.km = { max: intent.kmMax };
    }
    return filters;
}

/** Compact human summary, shown back so a misread is caught before anything is fetched. */
export function describeIntent(intent: SearchIntent): string {
    const parts: string[] = [];
    if (intent.brand !== null) {
        parts.push(intent.brand + (intent.model !== null ? ` ${intent.model}` : ''));
    }
    parts.push(intent.category);
    if (intent.priceMax !== null) {
        parts.push(`under ${intent.priceMax}`);
    }
    if (intent.priceMin !== null) {
        parts.push(`over ${intent.priceMin}`);
    }
    if (intent.yearMin !== null) {
        parts.push(`${intent.yearMin}+`);
    }
    if (intent.kmMax !== null) {
        parts.push(`under ${intent.kmMax} km`);
    }
    if (intent.attributes.length > 0) {
        parts.push(intent.attributes.join(', '));
    }
    if (intent.location !== null) {
        parts.push(`near ${intent.location}`);
    }
    if (intent.exclude.length > 0) {
        parts.push(`excluding ${intent.exclude.join(', ')}`);
    }
    return parts.join(' · ');
}
