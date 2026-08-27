/**
 * Domain types and their runtime schemas.
 *
 * Everything entering the process is `unknown` until it passes through one of these:
 * YAML off disk, JSON off a scraped page, JSON out of the model, rows out of SQLite.
 * Parsing at the boundary is what lets the rest of the codebase hold `any` at zero —
 * the schemas below are the only place where untrusted shape becomes typed value.
 *
 * Two-file split, mirrored here:
 *   Target — intent. Hand-written, stable, says WHAT you want.
 *   Recipe — mechanism. Model-generated, regenerable, says HOW to get it off the page.
 * Keeping them apart is what makes a site redesign a recipe regeneration rather than
 * an edit to your saved search.
 */

import { z } from 'zod';

// --- Branded ids -------------------------------------------------------------------
// Brands stop a fingerprint being passed where a target id belongs. Both are strings at
// runtime; the tag exists only at compile time and costs nothing.

declare const _brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [_brand]: B };

export type TargetId = Brand<string, 'TargetId'>;
export type Fingerprint = Brand<string, 'Fingerprint'>;

export function asTargetId(raw: string): TargetId {
    return raw as TargetId;
}

export function asFingerprint(raw: string): Fingerprint {
    return raw as Fingerprint;
}

// --- Extraction recipe --------------------------------------------------------------

/**
 * How to pull records off a page, in descending order of robustness:
 *   jsonld   — schema.org Product/Offer blocks. Standardized, survives redesigns best.
 *   json     — JSONPath into an embedded payload (__NEXT_DATA__) or an XHR response.
 *              The workhorse for Next.js sites like StandVirtual and OLX.
 *   css      — cheerio selectors over rendered DOM. Last resort; breaks most easily.
 */
export const ExtractModeSchema = z.enum(['jsonld', 'json', 'css']);
export type ExtractMode = z.infer<typeof ExtractModeSchema>;

/** Where the structured payload lives, when mode is `json`. */
export const JsonSourceSchema = z.enum([
    'nextdata', // <script id="__NEXT_DATA__">
    'inline', // any other inline <script> holding JSON
    'response', // the fetched document IS the JSON (an API endpoint)
]);
export type JsonSource = z.infer<typeof JsonSourceSchema>;

/**
 * A CSS field can read an attribute rather than text — `href` for links, `src`/`data-src`
 * for lazy-loaded images. The bare-string form is sugar for "take the text content".
 */
export const CssFieldSchema = z.union([
    z.string(),
    z.object({
        sel: z.string(),
        attr: z.string().optional(),
    }),
]);
export type CssField = z.infer<typeof CssFieldSchema>;

export const RecipeSchema = z.object({
    /** Model that produced this, e.g. "scout". Recorded so a bad batch is traceable. */
    generatedBy: z.string(),
    generatedAt: z.string(),
    /** Host this was generated against. Guards against applying a recipe to the wrong site. */
    host: z.string(),

    mode: ExtractModeSchema,
    source: JsonSourceSchema.optional(),

    /**
     * JSONPaths whose values are themselves JSON *strings*, to be parsed in place before
     * `list` runs.
     *
     * Not a hypothetical: StandVirtual is a urql app, and its __NEXT_DATA__ holds
     * `urqlState['<query-hash>'].data` as a 175KB serialized string, not a nested object.
     * Without this the listings are plainly visible in the payload yet unreachable by any
     * path expression.
     *
     * It also defuses the query-hash key. Unwrapping with a wildcard (`urqlState.*.data`)
     * lets `list` use a recursive descent that does not name the hash at all — which
     * matters because that hash changes whenever the site's GraphQL query changes.
     */
    unwrap: z.array(z.string()).default([]),

    /** Path/selector selecting the repeating record node. */
    list: z.string(),

    /**
     * Field name -> path (json/jsonld) or selector (css). `url` is required: it is the
     * dedupe key, and a recipe that cannot produce one is useless regardless of what
     * else it captures.
     */
    fields: z.record(z.string(), CssFieldSchema).refine(
        (f) => f['url'] !== undefined && f['url'] !== null,
        { message: 'recipe.fields must define `url` — it is the dedupe key' },
    ),

    /** Reserved for future alternate keys; today always the canonicalized URL. */
    fingerprint: z.literal('url').default('url'),
});
export type Recipe = z.infer<typeof RecipeSchema>;

// --- Target (saved search) ----------------------------------------------------------

export const NumericRangeSchema = z
    .object({
        min: z.number().optional(),
        max: z.number().optional(),
    })
    .refine(
        (r) =>
            r.min === undefined ||
            r.max === undefined ||
            r.min <= r.max,
        { message: 'min must not exceed max' },
    );
export type NumericRange = z.infer<typeof NumericRangeSchema>;

export const TargetSchema = z.object({
    id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, {
        message: 'id must be kebab-case: it becomes a filename and a Telegram callback token',
    }),
    url: z.url(),
    /** Standard 5-field cron. Jittered at schedule time so targets do not fire in lockstep. */
    schedule: z.string().default('*/15 * * * *'),
    enabled: z.boolean().default(true),

    /**
     * Plain-English description of what you actually want. Deterministic filters cannot
     * express "no accident history, private seller preferred"; this is what the judge
     * profile scores each new listing against.
     */
    criteria: z.string().min(1),

    /**
     * Cheap, exact predicates applied BEFORE the model ever runs. Two reasons this comes
     * first: it is free, and it keeps the model's attention on candidates that already
     * clear the hard constraints.
     */
    filters: z
        .object({
            price: NumericRangeSchema.optional(),
            year: NumericRangeSchema.optional(),
            km: NumericRangeSchema.optional(),
            /** Substrings that disqualify a title outright, e.g. "salvage", "para peças". */
            excludeTitle: z.array(z.string()).default([]),
        })
        .default({ excludeTitle: [] }),

    notify: z
        .object({
            /** 0..1. Below this the listing is recorded as seen but stays silent. */
            minScore: z.number().min(0).max(1).default(0.7),
            /** Send the listing photo to the vision model for a condition read. */
            photoGrade: z.boolean().default(false),
        })
        .default({ minScore: 0.7, photoGrade: false }),

    /** Force the browser path for a site known to challenge plain HTTP. */
    fetchMode: z.enum(['auto', 'http', 'browser']).default('auto'),
});
export type Target = z.infer<typeof TargetSchema>;

/**
 * Derived rather than restated, so a filter added to the schema cannot silently go
 * unhandled by the code that applies them.
 */
export type Filters = Target['filters'];

// --- Listing ------------------------------------------------------------------------

/**
 * One extracted record. Everything except `url` is optional because recipes are written
 * against real pages, where a seller routinely omits mileage or year — and a missing
 * field must degrade that one listing, never fail the batch.
 */
export const ListingSchema = z.object({
    url: z.string(),
    title: z.string().nullable().default(null),
    price: z.number().nullable().default(null),
    currency: z.string().nullable().default(null),
    year: z.number().nullable().default(null),
    km: z.number().nullable().default(null),
    location: z.string().nullable().default(null),
    image: z.string().nullable().default(null),
    /** Anything else the recipe captured. Kept for the judge's benefit, not indexed. */
    extra: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
});
export type Listing = z.infer<typeof ListingSchema>;

/** A listing plus the identity the store dedupes on. */
export type IdentifiedListing = Listing & {
    readonly fingerprint: Fingerprint;
    readonly targetId: TargetId;
};

// --- Judge verdict ------------------------------------------------------------------

/**
 * The model's read on a single new listing. Constrained by JSON schema at the decode
 * level, so a malformed verdict is a transport failure rather than a parse gamble.
 */
export const VerdictSchema = z.object({
    /** 0..1 match against the target's natural-language criteria. */
    score: z.number().min(0).max(1),
    /** One or two sentences. Shown verbatim in the Telegram message. */
    reason: z.string(),
    /** Set when the model believes the asking price is notably off market. */
    priceAssessment: z.enum(['bargain', 'fair', 'high', 'unknown']).default('unknown'),
    /** Populated only when photoGrade ran. */
    photoNotes: z.string().nullable().default(null),
});
export type Verdict = z.infer<typeof VerdictSchema>;

// --- Errors -------------------------------------------------------------------------

/**
 * A closed set, so the poll loop can decide per-kind what to do: `blocked` warrants the
 * browser fallback, `empty-extraction` triggers recipe healing, `network` is retried
 * with backoff, `config` is fatal and must reach the operator.
 */
export type ScoutErrorKind =
    | 'network'
    | 'blocked'
    | 'parse'
    | 'empty-extraction'
    | 'llm'
    | 'config'
    | 'store';

export type ScoutError = {
    readonly kind: ScoutErrorKind;
    readonly message: string;
    readonly targetId?: TargetId;
    readonly cause?: unknown;
};

export function scoutError(
    kind: ScoutErrorKind,
    message: string,
    extra?: { targetId?: TargetId; cause?: unknown },
): ScoutError {
    return {
        kind,
        message,
        ...(extra?.targetId !== undefined ? { targetId: extra.targetId } : {}),
        ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
    };
}
