/**
 * Judging a listing against natural-language criteria.
 *
 * This runs on genuinely-new listings only — never on the whole page. That ordering is
 * what makes local inference affordable: a busy target returns fifty listings a poll but
 * one or two new ones, so the judge sees single digits per run regardless of how large
 * the search is.
 *
 * The judge deliberately has no say in what is *new*. It scores what the store already
 * decided is new, so a model that phrases things differently between runs can change how
 * a listing is described but never manufacture one.
 */

import { Agent, request } from 'undici';
import type { Result } from '../core/result.ts';
import { err, messageOf, ok } from '../core/result.ts';
import { VerdictSchema, scoutError, type Filters, type Listing, type NumericRange, type ScoutError, type Verdict } from '../core/types.ts';
import { chatStructured, type OllamaOptions } from './ollama.ts';
import { guardedConnector, readBodyCapped } from '../fetch/guard.ts';
import { DESKTOP_USER_AGENT } from '../fetch/politeness.ts';

/** Cap on image bytes sent to the model. Thumbnails are ~50-200KB; anything far larger is
 *  a full-resolution photo that costs context without adding judgement value. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * The image URL is taken VERBATIM off a hostile page, which makes this fetch the most
 * directly attacker-steered request in the codebase — a crafted listing could point it at
 * the docker bridge or the metadata range. Same connect-time guard as every other
 * hostile-input fetch.
 */
const _imageDispatcher = new Agent({
    connect: guardedConnector({ timeoutMs: 10_000 }),
    maxResponseSize: MAX_IMAGE_BYTES,
});

const SYSTEM_PROMPT = `You evaluate individual classified listings against a buyer's stated criteria.

Return:
- score: 0..1, how well this listing matches. Be discriminating — 0.9+ means it clearly
  meets everything stated, 0.5 means partial, below 0.3 means it fails a stated
  requirement. Do not cluster everything around 0.7.
- reason: one or two sentences, concrete and specific to THIS listing. The buyer reads
  this verbatim; "matches criteria" is useless, "diesel Touring, 2018, but dealer not
  private" is useful.
- priceAssessment: judge the asking price against the vehicle's age, mileage and market.
  Use "unknown" honestly when you lack grounds — a confident wrong call is worse.
- photoNotes: only when an image is provided. Describe visible condition, damage, or
  whether the body style actually matches what the buyer asked for. null otherwise.

Missing fields are normal. A null price or mileage means the seller omitted it, not that
the listing is bad — say so in the reason rather than penalising heavily.`;

export type ScoreInput = {
    readonly listing: Listing;
    readonly criteria: string;
    /** Fetch and attach the listing photo. Requires a vision-capable model. */
    readonly photoGrade: boolean;
};

export async function scoreListing(
    ollama: OllamaOptions,
    input: ScoreInput,
): Promise<Result<Verdict, ScoutError>> {
    const { listing } = input;

    const facts = [
        `title: ${listing.title ?? '(not stated)'}`,
        `price: ${listing.price !== null ? `${listing.price} ${listing.currency ?? ''}`.trim() : '(not stated)'}`,
        `year: ${listing.year ?? '(not stated)'}`,
        `mileage: ${listing.km !== null ? `${listing.km} km` : '(not stated)'}`,
        `location: ${listing.location ?? '(not stated)'}`,
        ...Object.entries(listing.extra)
            .filter(([, v]) => v !== null)
            .map(([k, v]) => `${k}: ${String(v)}`),
    ].join('\n');

    const images: string[] = [];
    if (input.photoGrade && listing.image !== null) {
        const fetched = await _fetchImageBase64(listing.image);
        // A missing photo degrades the verdict; it must not fail the listing. The prompt
        // already tells the model to return null photoNotes when no image is present.
        if (fetched.ok) {
            images.push(fetched.value);
        }
    }

    const userContent = `BUYER'S CRITERIA:\n${input.criteria}\n\nLISTING:\n${facts}${
        images.length > 0 ? '\n\nA photo of this listing is attached — assess visible condition.' : ''
    }`;

    const scored = await chatStructured(
        ollama,
        'judge',
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent, ...(images.length > 0 ? { images } : {}) },
        ],
        VerdictSchema,
    );

    if (scored.ok || images.length === 0) {
        return scored;
    }

    // The photo is an enhancement, never a prerequisite. If the model refuses the image —
    // a format check can pass while the decoder still balks — score on the text alone
    // rather than discarding a listing that may well be the one worth seeing.
    const textOnly = await chatStructured(
        ollama,
        'judge',
        [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
        ],
        VerdictSchema,
    );
    return textOnly;
}

/**
 * Whether these bytes are a format the model can actually decode.
 *
 * llama.cpp loads images through stb_image, which handles JPEG and PNG but NOT WebP or
 * AVIF. Sending one anyway returns a bare 400 "Failed to load image or audio file" and
 * fails the ENTIRE scoring call — so an undecodable thumbnail took the whole listing down
 * with it. Measured on OLX: 11 of 13 listings lost this way.
 *
 * Checking magic bytes rather than trusting content-type also catches the other case: a
 * CDN returning an HTML error page with status 200, which would otherwise be base64'd and
 * sent as if it were a photo.
 */
export function isDecodableImage(buffer: Buffer): boolean {
    if (buffer.byteLength < 12) {
        return false;
    }
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isPng =
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
    return isJpeg || isPng;
}

async function _fetchImageBase64(url: string): Promise<Result<string, ScoutError>> {
    try {
        const res = await request(url, {
            method: 'GET',
            headers: {
                'user-agent': DESKTOP_USER_AGENT,
                // JPEG and PNG only, deliberately. The browser-like header this replaced
                // advertised avif/webp FIRST, so image CDNs happily served exactly the two
                // formats the model cannot read.
                accept: 'image/jpeg,image/png;q=0.9,*/*;q=0.1',
            },
            dispatcher: _imageDispatcher,
            headersTimeout: 10_000,
            bodyTimeout: 15_000,
            // Wall-clock ceiling — the per-chunk bodyTimeout alone lets a slow drip run forever.
            signal: AbortSignal.timeout(30_000),
        });

        if (res.statusCode !== 200) {
            return err(scoutError('network', `image fetch returned ${res.statusCode}`));
        }

        // Cap enforced DURING the read, not after: arrayBuffer() would buffer an
        // arbitrarily large response before the size check could see it.
        const bodyRead = await readBodyCapped(res.body, MAX_IMAGE_BYTES);
        if (!bodyRead.ok) {
            return bodyRead;
        }
        const buffer = bodyRead.value;
        if (!isDecodableImage(buffer)) {
            const kind = String(res.headers['content-type'] ?? 'unknown');
            return err(scoutError('network', `image is not JPEG or PNG (content-type: ${kind})`));
        }
        // Ollama wants raw base64 with no data: prefix.
        return ok(buffer.toString('base64'));
    } catch (thrown: unknown) {
        return err(scoutError('network', `image fetch failed: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

/**
 * A stated value outside the range rejects. A MISSING value never rejects: sellers omit
 * mileage and price constantly, and silently discarding those would hide real matches
 * behind what looks like a working filter.
 */
function _outOfBounds(value: number | null, range: NumericRange | undefined, label: string): string | null {
    if (value === null || range === undefined) {
        return null;
    }
    if (range.min !== undefined && value < range.min) {
        return `${label} ${value} below min ${range.min}`;
    }
    if (range.max !== undefined && value > range.max) {
        return `${label} ${value} above max ${range.max}`;
    }
    return null;
}

/**
 * Deterministic pre-filters, applied before the judge ever runs.
 *
 * Returns the reason a listing was rejected, or null if it survives. Reasons are strings
 * rather than a boolean so `/status` can report *why* a busy target notified nothing —
 * "38 rejected on price" is actionable, "38 rejected" is not.
 */
export function rejectReason(listing: Listing, filters: Filters): string | null {
    const priceReason = _outOfBounds(listing.price, filters.price, 'price');
    if (priceReason !== null) {
        return priceReason;
    }
    const yearReason = _outOfBounds(listing.year, filters.year, 'year');
    if (yearReason !== null) {
        return yearReason;
    }
    const kmReason = _outOfBounds(listing.km, filters.km, 'km');
    if (kmReason !== null) {
        return kmReason;
    }

    if (listing.title !== null) {
        const haystack = listing.title.toLowerCase();
        for (const needle of filters.excludeTitle) {
            if (needle.length > 0 && haystack.includes(needle.toLowerCase())) {
                return `title contains "${needle}"`;
            }
        }
    }
    return null;
}
