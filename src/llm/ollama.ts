/**
 * Client for the local Ollama instance.
 *
 * The model runs on the host GPU and is reached over the bridge gateway — never bundled
 * into a container. Two things make this reliable enough to build a pipeline on:
 *
 *   Constrained decoding. Every call passes a JSON Schema in `format`, so the sampler
 *   itself is restricted to tokens that keep the output valid. A malformed response
 *   becomes a transport-level impossibility rather than something to defend against with
 *   regex repair and retries.
 *
 *   Bounded residency. `keep_alive` is deliberately short and never -1. The host pins two
 *   other models (supra-fast, supra-reason) with keep_alive: -1 for an unrelated project;
 *   a long-lived Scout would evict them and keep them evicted. Scout loads, answers, and
 *   gets out of the way.
 */

import { z } from 'zod';
import type { Result } from '../core/result.ts';
import { err, messageOf, ok } from '../core/result.ts';
import { scoutError, type ScoutError } from '../core/types.ts';

/**
 * Call profiles. One baked model, two sampling regimes.
 *
 *   extract — recipe generation. Near-deterministic so that regenerating a recipe for an
 *             unchanged page yields the same mapping, which is what makes a recipe diff
 *             mean "the site changed" rather than "the sampler wandered".
 *   judge   — scoring a listing against natural-language criteria. Slightly warmer, and
 *             thinking enabled: deciding whether 14.5k is fair for a 2018 320d with
 *             142k km benefits from reasoning the extraction path does not need.
 */
export type Profile = 'extract' | 'judge';

const PROFILES: Record<Profile, { readonly temperature: number; readonly think: boolean }> = {
    extract: { temperature: 0.1, think: false },
    judge: { temperature: 0.4, think: true },
};

export type OllamaOptions = {
    readonly url: string;
    readonly model: string;
    readonly timeoutMs: number;
    /**
     * How long the model stays resident after a call. Short by design — see the module
     * note. '0' would unload immediately and pay a full reload per listing scored.
     */
    readonly keepAlive?: string;
};

export type ChatMessage = {
    readonly role: 'system' | 'user' | 'assistant';
    readonly content: string;
    /** Base64-encoded images, for the vision path. No data: prefix — raw base64 only. */
    readonly images?: readonly string[];
};

/**
 * Ask the model for a value matching `schema`.
 *
 * The schema does double duty: it constrains generation, and it validates what comes
 * back. The second is not redundant — constrained decoding guarantees well-formed JSON of
 * the right shape, but not that a number lands inside a `.min(0).max(1)` refinement.
 */
export async function chatStructured<T>(
    options: OllamaOptions,
    profile: Profile,
    messages: readonly ChatMessage[],
    schema: z.ZodType<T>,
): Promise<Result<T, ScoutError>> {
    // Ollama wants a bare JSON Schema; the $schema declaration zod emits is noise here.
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    delete jsonSchema['$schema'];

    const settings = PROFILES[profile];

    const body = {
        model: options.model,
        messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
            ...(m.images !== undefined && m.images.length > 0 ? { images: m.images } : {}),
        })),
        stream: false,
        format: jsonSchema,
        think: settings.think,
        keep_alive: options.keepAlive ?? '10m',
        options: { temperature: settings.temperature },
    };

    const raw = await _post(options, '/api/chat', body);
    if (!raw.ok) {
        return raw;
    }

    const content = _messageContent(raw.value);
    if (content === null) {
        return err(scoutError('llm', 'ollama response contained no message content'));
    }

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(content);
    } catch (thrown: unknown) {
        return err(
            scoutError('llm', `model emitted non-JSON despite constrained decoding: ${messageOf(thrown)}`, {
                cause: content.slice(0, 400),
            }),
        );
    }

    const validated = schema.safeParse(parsedJson);
    if (!validated.success) {
        const detail = validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        return err(scoutError('llm', `model output failed validation: ${detail}`, { cause: parsedJson }));
    }
    return ok(validated.data);
}

function _messageContent(payload: unknown): string | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const message = (payload as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null) {
        return null;
    }
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string' && content.trim().length > 0 ? content : null;
}

async function _post(
    options: OllamaOptions,
    path: string,
    body: unknown,
): Promise<Result<unknown, ScoutError>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort();
    }, options.timeoutMs);

    try {
        const res = await fetch(`${options.url}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            return err(scoutError('llm', `ollama ${path} returned ${res.status}: ${text.slice(0, 300)}`));
        }
        return ok(await res.json());
    } catch (thrown: unknown) {
        if (thrown instanceof Error && thrown.name === 'AbortError') {
            return err(
                scoutError('llm', `ollama ${path} timed out after ${options.timeoutMs}ms — a cold model load can exceed this`),
            );
        }
        return err(scoutError('llm', `ollama ${path} failed: ${messageOf(thrown)}`, { cause: thrown }));
    } finally {
        clearTimeout(timer);
    }
}

// --- Introspection ------------------------------------------------------------------

const TagsSchema = z.object({
    models: z.array(z.object({ name: z.string() })).default([]),
});

/** Whether the configured model exists on the host. Checked at startup so a typo fails loudly. */
export async function modelExists(options: OllamaOptions): Promise<Result<boolean, ScoutError>> {
    try {
        const res = await fetch(`${options.url}/api/tags`, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
            return err(scoutError('llm', `ollama /api/tags returned ${res.status}`));
        }
        const parsed = TagsSchema.safeParse(await res.json());
        if (!parsed.success) {
            return err(scoutError('llm', 'unexpected /api/tags payload'));
        }
        const wanted = options.model;
        return ok(
            parsed.data.models.some((m) => m.name === wanted || m.name === `${wanted}:latest`),
        );
    } catch (thrown: unknown) {
        return err(scoutError('llm', `cannot reach ollama at ${options.url}: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

const ShowSchema = z.object({
    capabilities: z.array(z.string()).default([]),
});

/**
 * Whether the model can accept images. Gates photo grading rather than assuming it:
 * pointing SCOUT_MODEL at a text-only model should silently skip photo analysis, not
 * fail every poll with a confusing API error.
 */
export async function modelSupportsVision(options: OllamaOptions): Promise<Result<boolean, ScoutError>> {
    try {
        const res = await fetch(`${options.url}/api/show`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: options.model }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
            return err(scoutError('llm', `ollama /api/show returned ${res.status}`));
        }
        const parsed = ShowSchema.safeParse(await res.json());
        if (!parsed.success) {
            return ok(false);
        }
        return ok(parsed.data.capabilities.includes('vision'));
    } catch (thrown: unknown) {
        return err(scoutError('llm', `cannot inspect model: ${messageOf(thrown)}`, { cause: thrown }));
    }
}
