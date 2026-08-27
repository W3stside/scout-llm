/**
 * Recipe generation: the model reads a condensed page once and writes the extraction
 * mapping that deterministic code then runs on every poll thereafter.
 *
 * This is the only place a model produces something code-like, so the output schema is
 * kept deliberately narrow. Rather than letting it emit a free-form field map, it fills a
 * fixed set of known keys — which means constrained decoding can guarantee the shape, and
 * a hallucinated field name is structurally impossible rather than something to validate
 * away afterwards.
 */

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import { err, ok } from '../core/result.ts';
import { hostOf } from '../core/url.ts';
import { RecipeSchema, scoutError, type CssField, type Recipe, type ScoutError } from '../core/types.ts';
import { chatStructured, type OllamaOptions } from '../llm/ollama.ts';
import { condensePage, type CondenseResult } from './condense.ts';

/**
 * One extracted field. `attr` is meaningful only for css mode; for the JSON modes the
 * path is the whole story. Modelling it as one shape keeps the schema flat, which
 * constrained decoding handles far more reliably than a discriminated union.
 */
const FieldSpecSchema = z.object({
    path: z.string().describe('JSONPath (json/jsonld modes) or CSS selector (css mode), relative to one record'),
    attr: z
        .string()
        .nullable()
        .describe('css mode only: read this attribute instead of text, e.g. href or src. null for text'),
});

const GeneratedSchema = z.object({
    mode: z.enum(['jsonld', 'json', 'css']),
    source: z
        .enum(['nextdata', 'inline', 'response', 'none'])
        .describe('json mode only: where the payload lives. "none" for css/jsonld modes'),
    list: z.string().describe('path or selector that selects EACH repeating listing record'),
    url: FieldSpecSchema.describe('REQUIRED: the link to the individual listing page'),
    title: FieldSpecSchema.nullable(),
    price: FieldSpecSchema.nullable(),
    currency: FieldSpecSchema.nullable(),
    year: FieldSpecSchema.nullable(),
    km: FieldSpecSchema.nullable(),
    location: FieldSpecSchema.nullable(),
    image: FieldSpecSchema.nullable(),
    notes: z.string().describe('one sentence on why this route was chosen'),
});

type Generated = z.infer<typeof GeneratedSchema>;

const SYSTEM_PROMPT = `You write extraction recipes for classified-listing pages.

You are shown a CONDENSED page. Repeated elements have been reduced to two exemplars and
long values clipped — the real page has many more records of the same shape. Write a
mapping that will work against the FULL page, not just what you can see.

Choose the mode by what the page actually offers, preferring robustness:

1. json + nextdata   — the page has a __NEXT_DATA__ script. STRONGLY PREFERRED when
                       present: it is the same data the site's own components render
                       from, so it survives visual redesigns.
2. json + response   — the fetched document IS a JSON API response.
3. json + inline     — a large inline JSON state blob that is not __NEXT_DATA__.
4. jsonld            — schema.org Product/Offer/ItemList blocks.
5. css               — LAST RESORT. Only when no structured payload exists.

Rules:
- "list" must select each individual listing RECORD. Every field path is then relative
  to ONE record, not to the document root.
- Prefer stable hooks: a data-testid, an itemprop, or a named JSON key. NEVER use
  generated class hashes (css-1a2b3c, sc-eCImPb) or positional nth-child selectors —
  they change on every deploy.
- "url" is mandatory. It is the dedupe key; a recipe without it is useless. In css mode
  this is almost always {path: "<a selector>", attr: "href"}.
- Prices: point at whatever holds the NUMBER. Downstream parsing handles "14.500 €" and
  knows that a dot is a thousands separator here. Do not try to strip formatting.
- Set a field to null when the page genuinely does not carry it. Never invent a path.
- In css mode set "source" to "none". In json/jsonld modes set "attr" to null.`;

export type GenerateInput = {
    readonly url: string;
    readonly body: string;
    readonly contentType: string;
    /** What the user is looking for. Helps disambiguate which list is the results list. */
    readonly criteria?: string;
};

export type GenerateOutput = {
    readonly recipe: Recipe;
    readonly condensed: CondenseResult;
    readonly notes: string;
};

export async function generateRecipe(
    ollama: OllamaOptions,
    input: GenerateInput,
): Promise<Result<GenerateOutput, ScoutError>> {
    const host = hostOf(input.url);
    if (host === null) {
        return err(scoutError('config', `cannot determine host from ${input.url}`));
    }

    const condensed = condensePage(input.body, input.contentType);
    if (condensed.text.trim().length === 0) {
        return err(scoutError('empty-extraction', 'page condensed to nothing — likely a block page'));
    }

    const userPrompt = [
        `URL: ${input.url}`,
        `Condensed via: ${condensed.kind} (${condensed.originalBytes} bytes -> ${condensed.condensedBytes})`,
        input.criteria !== undefined && input.criteria !== null
            ? `\nThe user is looking for:\n${input.criteria}\n\nUse this only to identify WHICH repeating set is the search results — do not encode the criteria into the recipe.`
            : '',
        `\n--- CONDENSED PAGE ---\n${condensed.text}`,
    ].join('\n');

    const response = await chatStructured(
        ollama,
        'extract',
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
        ],
        GeneratedSchema,
    );
    if (!response.ok) {
        return response;
    }

    return _toRecipe(response.value, host, ollama.model, condensed);
}

function _toRecipe(
    generated: Generated,
    host: string,
    model: string,
    condensed: CondenseResult,
): Result<GenerateOutput, ScoutError> {
    const fields: Record<string, CssField> = {};

    const assign = (name: string, spec: Generated['title']): void => {
        if (spec === null || spec.path.trim().length === 0) {
            return;
        }
        // The object form only means something in css mode; carrying a null attr into a
        // JSON recipe would just be noise in the committed file.
        fields[name] =
            generated.mode === 'css' && spec.attr !== null && spec.attr.length > 0
                ? { sel: spec.path, attr: spec.attr }
                : spec.path;
    };

    assign('url', generated.url);
    assign('title', generated.title);
    assign('price', generated.price);
    assign('currency', generated.currency);
    assign('year', generated.year);
    assign('km', generated.km);
    assign('location', generated.location);
    assign('image', generated.image);

    const candidate = {
        generatedBy: model,
        generatedAt: new Date().toISOString(),
        host,
        mode: generated.mode,
        ...(generated.mode === 'json' && generated.source !== 'none' ? { source: generated.source } : {}),
        list: generated.list,
        fields,
        fingerprint: 'url' as const,
    };

    const parsed = RecipeSchema.safeParse(candidate);
    if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return err(scoutError('llm', `generated recipe is invalid: ${detail}`, { cause: candidate }));
    }

    return ok({ recipe: parsed.data, condensed, notes: generated.notes });
}
