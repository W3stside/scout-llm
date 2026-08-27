/**
 * The /add wizard.
 *
 * This is the feature that makes Scout site-agnostic in practice rather than in principle:
 * you paste a URL for a bag, a flight, a car — anything with a results page — describe
 * what you want in plain words, and the model works out how to read that page. No code
 * change, no selector writing.
 *
 * The wizard deliberately generates and previews the recipe BEFORE saving the target. A
 * saved target whose recipe does not work is worse than no target: it sits in the
 * scheduler quietly extracting nothing, and the only symptom is silence — which is
 * indistinguishable from "no new listings".
 */

import { type Conversation, type ConversationFlavor } from '@grammyjs/conversations';
import type { Context } from 'grammy';
import type { Config } from '../core/config.ts';
import { isErr } from '../core/result.ts';
import { TargetSchema, type Filters, type Listing, type Target, type Verdict } from '../core/types.ts';
import { fetchPage, closeBrowser } from '../fetch/index.ts';
import { generateRecipe } from '../extract/generate.ts';
import { applyRecipe } from '../extract/selectors.ts';
import { saveRecipe, saveTarget } from '../extract/recipe.ts';
import { rejectReason, scoreListing } from '../llm/score.ts';
import type { OllamaOptions } from '../llm/ollama.ts';
import { describeIntent, intentToFilters, parseIntent } from '../discover/intent.ts';
import { discoverSearchUrl } from '../discover/search.ts';
import { escapeHtml } from './render.ts';

export type ScoutContext = ConversationFlavor<Context>;
export type ScoutConversation = Conversation<ScoutContext, ScoutContext>;

export type AddDeps = {
    readonly config: Config;
    readonly ollama: OllamaOptions;
};

type DiscoveryResult =
    | { readonly kind: 'failed'; readonly message: string }
    | {
          readonly kind: 'ok';
          readonly url: string;
          readonly site: string;
          readonly understood: string;
          readonly verification: string;
          readonly filtersApplied: boolean;
          /**
           * Deterministic filters derived from the same parse that built the URL.
           *
           * This is the quiet payoff of structured intent: the numbers were extracted once
           * to construct the search, so the target's filters come for free rather than
           * being hand-written afterwards — and they enforce the limits even when the
           * site's own search ignored them.
           */
          readonly filters: ReturnType<typeof intentToFilters>;
      };

/**
 * Parse the description and hunt for a search URL.
 *
 * Extracted to a plain function so the conversation handler stays readable, and — more
 * importantly — so the whole thing sits inside a single conversation.external(). The
 * conversations plugin replays the handler from the top on every update; an unwrapped
 * discovery would re-run several minutes of fetching and inference on each message.
 */
async function _discover(deps: AddDeps, description: string): Promise<DiscoveryResult> {
    const intent = await parseIntent(deps.ollama, description);
    if (isErr(intent)) {
        return { kind: 'failed', message: intent.error.message };
    }

    const outcome = await discoverSearchUrl(
        {
            ollama: deps.ollama,
            minHostIntervalMs: deps.config.minHostIntervalMs,
            respectRobots: deps.config.respectRobots,
        },
        intent.value,
    );
    await closeBrowser();

    if (isErr(outcome)) {
        return { kind: 'failed', message: outcome.error.message };
    }
    const best = outcome.value.best;
    if (best === null) {
        const tried = outcome.value.attempts
            .map((a) => `${a.candidate.site}: ${a.failure ?? 'filters not applied'}`)
            .join('; ');
        return { kind: 'failed', message: `tried ${outcome.value.attempts.length} site(s) — ${tried}` };
    }

    return {
        kind: 'ok',
        url: best.candidate.url,
        site: best.candidate.site,
        understood: describeIntent(outcome.value.intent),
        verification: best.verification?.summary ?? '',
        filtersApplied: best.verification?.looksFiltered === true,
        filters: intentToFilters(outcome.value.intent),
    };
}

/** How many surviving listings the wizard judges and shows. Kept small because each one
 *  is a local-inference call made while the user waits. */
const PREVIEW_COUNT = 3;

type PreviewEntry = {
    readonly listing: Listing;
    /** Null when scoring failed — the listing is still shown, just without a verdict. */
    readonly verdict: Verdict | null;
};

type PreviewOutcome = {
    /** Listings that survive the deterministic filters. */
    readonly passed: number;
    /** "12 on price, 3 on km" — null when nothing was rejected. */
    readonly rejectedSummary: string | null;
    readonly entries: readonly PreviewEntry[];
};

/**
 * Run extracted listings through the SAME gates a scheduled poll applies — deterministic
 * filters first, then the judge on the few that will be shown.
 *
 * The preview exists to answer "will this target notify me of the right things?", and raw
 * scrape output cannot answer that: a discovery URL whose site ignored the price cap
 * previews a €397k supercar against a €20k budget and looks broken even though poll-time
 * filtering would have caught it. Filtering here makes the preview show what the target
 * will actually do, not what the page happened to contain.
 */
async function _previewThroughPipeline(
    ollama: OllamaOptions,
    listings: readonly Listing[],
    filters: Filters,
    criteria: string,
): Promise<PreviewOutcome> {
    const rejections = new Map<string, number>();
    const survivors: Listing[] = [];
    for (const listing of listings) {
        const reason = rejectReason(listing, filters);
        if (reason === null) {
            survivors.push(listing);
        } else {
            // First word of the reason is its field label ("price 397500 above max
            // 20000" -> "price"), which is exactly the granularity a summary needs.
            const label = reason.split(' ')[0] ?? 'other';
            rejections.set(label, (rejections.get(label) ?? 0) + 1);
        }
    }

    const entries: PreviewEntry[] = [];
    for (const listing of survivors.slice(0, PREVIEW_COUNT)) {
        // photoGrade off deliberately: the wizard preview is interactive, and an image
        // fetch plus vision pass per listing would stretch the wait for marginal signal.
        const scored = await scoreListing(ollama, { listing, criteria, photoGrade: false });
        entries.push({ listing, verdict: scored.ok ? scored.value : null });
    }

    const rejectedSummary =
        rejections.size > 0
            ? [...rejections.entries()].map(([label, n]) => `${n} on ${label}`).join(', ')
            : null;

    return { passed: survivors.length, rejectedSummary, entries };
}

/** One preview bullet: linked title, price, and the verdict when scoring produced one. */
function _previewLine(entry: PreviewEntry): string {
    const listing = entry.listing;
    const price =
        listing.price !== null
            ? `${listing.price} ${listing.currency ?? ''}`.trim()
            : 'no price';
    const line = `• <a href="${escapeHtml(listing.url)}">${escapeHtml(listing.title ?? 'untitled')}</a> — ${escapeHtml(price)}`;
    if (entry.verdict === null) {
        return line;
    }
    return `${line}\n  <i>${entry.verdict.score.toFixed(2)} — ${escapeHtml(entry.verdict.reason)}</i>`;
}

/** Derive a filename-safe id from a URL, since asking for one is a step nobody enjoys. */
function _suggestId(url: string): string {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '').split('.')[0] ?? 'target';
        const suffix = Math.random().toString(36).slice(2, 6);
        return `${host}-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    } catch {
        return `target-${Math.random().toString(36).slice(2, 6)}`;
    }
}

export function buildAddConversation(deps: AddDeps) {
    return async function addTarget(conversation: ScoutConversation, ctx: ScoutContext): Promise<void> {
        await ctx.reply(
            'Describe what you are looking for, in plain words.\n\n' +
                'Include the numbers (price, year, mileage) and the things a filter cannot ' +
                'express — condition, seller type, body style.\n\n' +
                '<i>You can paste a search URL instead if you already have one.</i>\n\n' +
                'Send /cancel to stop.',
            { parse_mode: 'HTML' },
        );

        const firstCtx = await conversation.waitFor('message:text');
        const first = firstCtx.message.text.trim();
        if (first === '/cancel') {
            await ctx.reply('Cancelled.');
            return;
        }

        // A pasted URL skips discovery entirely. Keeping that path is not just backwards
        // compatibility — when discovery cannot work out a site, pasting the URL is the
        // fallback, so it must stay first-class.
        const pastedUrl = /^https?:\/\//i.test(first) ? first : null;

        let url: string;
        let criteria: string;
        // Null on the pasted-URL path: nothing parsed the description into numbers there,
        // so the target keeps the schema defaults and you set filters by hand.
        let discoveredFilters: ReturnType<typeof intentToFilters> | null = null;

        if (pastedUrl !== null) {
            url = pastedUrl;
            await ctx.reply(
                'Got the URL. Now describe what you are looking for, in plain words — ' +
                    'including the things a filter cannot express.',
            );
            const criteriaCtx = await conversation.waitFor('message:text');
            criteria = criteriaCtx.message.text.trim();
            if (criteria === '/cancel') {
                await ctx.reply('Cancelled.');
                return;
            }
        } else {
            criteria = first;

            const discovered = await conversation.external(() =>
                _discover(deps, criteria),
            );

            if (discovered.kind === 'failed') {
                await ctx.reply(
                    `I could not work out where to search.\n\n<code>${escapeHtml(discovered.message)}</code>\n\n` +
                        'Run the search on the site yourself and send me that URL with /add.',
                    { parse_mode: 'HTML' },
                );
                return;
            }

            url = discovered.url;
            discoveredFilters = discovered.filters;
            await ctx.reply(
                `Understood: <i>${escapeHtml(discovered.understood)}</i>\n\n` +
                    `Searching <b>${escapeHtml(discovered.site)}</b>\n` +
                    `<code>${escapeHtml(discovered.url)}</code>\n\n` +
                    `${escapeHtml(discovered.verification)}` +
                    (discovered.filtersApplied
                        ? ''
                        : `\n\n⚠️ Some of your limits were <b>not</b> applied by the site's own search. ` +
                          `Scout's filters will still enforce them, but you will get more listings ` +
                          `fetched per poll than necessary.`),
                { parse_mode: 'HTML' },
            );
        }

        await ctx.reply('Reading the page and test-scoring a few listings against your criteria…');

        // conversation.external wraps every side effect: the conversations plugin replays
        // the handler from the top on each update, and an unwrapped fetch would re-run the
        // whole scrape-and-generate on every message the user sends.
        const outcome = await conversation.external(async () => {
            const fetched = await fetchPage(url, {
                mode: 'auto',
                minHostIntervalMs: deps.config.minHostIntervalMs,
                respectRobots: deps.config.respectRobots,
            });
            await closeBrowser();
            if (isErr(fetched)) {
                return { kind: 'fetch-failed' as const, message: fetched.error.message };
            }

            const generated = await generateRecipe(deps.ollama, {
                url,
                body: fetched.value.page.body,
                contentType: fetched.value.page.contentType,
                criteria,
            });
            if (isErr(generated)) {
                return { kind: 'generate-failed' as const, message: generated.error.message };
            }

            // Prove the recipe works against the page it was written from, before anything
            // is persisted. This is the check that stops a silently-dead target existing.
            const extracted = applyRecipe(generated.value.recipe, fetched.value.page);
            if (isErr(extracted)) {
                return { kind: 'extract-failed' as const, message: extracted.error.message };
            }

            // On the pasted-URL path nothing parsed the description into numbers, so the
            // deterministic pass is a no-op there and the judge carries the preview alone.
            const filters: Filters = discoveredFilters ?? { excludeTitle: [] };
            const preview = await _previewThroughPipeline(deps.ollama, extracted.value, filters, criteria);

            return {
                kind: 'ok' as const,
                recipe: generated.value.recipe,
                notes: generated.value.notes,
                preview,
                count: extracted.value.length,
                via: fetched.value.page.via,
            };
        });

        if (outcome.kind !== 'ok') {
            await ctx.reply(
                `Could not read that page.\n\n<code>${escapeHtml(outcome.message)}</code>\n\n` +
                    'Sites that need a login, or that block automation hard, will fail here.',
                { parse_mode: 'HTML' },
            );
            return;
        }

        if (outcome.count === 0) {
            await ctx.reply(
                'I reached the page but could not find any listings on it.\n\n' +
                    'That usually means the URL is a landing page rather than search results. ' +
                    'Try running the search on the site first, then send me that URL.',
            );
            return;
        }

        const rejectedNote =
            outcome.preview.rejectedSummary !== null
                ? ` (${outcome.count - outcome.preview.passed} rejected: ${escapeHtml(outcome.preview.rejectedSummary)})`
                : '';
        const headline =
            `Found <b>${outcome.count}</b> listings via ${outcome.via} — ` +
            `<b>${outcome.preview.passed}</b> pass your limits${rejectedNote}.`;

        if (outcome.preview.passed === 0) {
            // Every listing on the page fails the deterministic filters. That usually means
            // the site's own search ignored the query parameters — worth flagging loudly,
            // but not worth blocking the save: poll-time filtering still enforces the
            // limits, and new listings that DO fit will get through.
            await ctx.reply(
                `${headline}\n\n` +
                    `⚠️ Nothing on this page survives your limits — the site's search is ` +
                    `probably ignoring them. Scout will still enforce your filters on every ` +
                    `poll, but check the URL above looks like the right search.\n\n` +
                    `Send a short <b>name</b> to save anyway (letters, numbers, hyphens), or /cancel.`,
                { parse_mode: 'HTML' },
            );
        } else {
            // The target is not built until the name step, so its notify.minScore is not
            // available yet — derive the schema default rather than hardcoding a second 0.7.
            const minScore = TargetSchema.shape.notify.parse(undefined).minScore;

            // Annotated rather than inferred. The type flows through conversation.external,
            // whose return is only as good as the plugin's own types — when those failed to
            // resolve in the container build, this silently degraded to an implicit any and
            // was the only thing standing between a missing dependency and a shipped image.
            const recommended = outcome.preview.entries.filter(
                (entry: PreviewEntry) => entry.verdict !== null && entry.verdict.score >= minScore,
            );
            // Includes verdict === null: a listing whose scoring failed cannot be recommended.
            const rest = outcome.preview.entries.filter(
                (entry: PreviewEntry) => entry.verdict === null || entry.verdict.score < minScore,
            );

            const sections: string[] = [];
            if (recommended.length > 0) {
                sections.push(`🎯 <b>Recommended</b>\n${recommended.map(_previewLine).join('\n')}`);
            }
            if (rest.length > 0) {
                sections.push(`<b>Also found</b>\n${rest.map(_previewLine).join('\n')}`);
            }
            const bullets = sections.join('\n\n');

            await ctx.reply(
                `${headline}\n\n${bullets}\n\n` +
                    `Scores are the judge's read against your criteria — only listings at or ` +
                    `above your threshold will notify.\n\n` +
                    `Look right? Send a short <b>name</b> for this search (letters, numbers, hyphens), ` +
                    `or /cancel.`,
                { parse_mode: 'HTML' },
            );
        }

        const nameCtx = await conversation.waitFor('message:text');
        const rawName = nameCtx.message.text.trim();
        if (rawName === '/cancel') {
            await ctx.reply('Cancelled — nothing saved.');
            return;
        }

        const id = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || _suggestId(url);

        // Filters come from the discovery parse when there was one. They are the same
        // numbers that built the URL, so they enforce your limits even where the site's own
        // search ignored them — which is exactly the case the verification step flagged.
        const candidate = TargetSchema.safeParse({
            id,
            url,
            criteria,
            ...(discoveredFilters !== null ? { filters: discoveredFilters } : {}),
        });
        if (!candidate.success) {
            await ctx.reply(`That name will not work: ${escapeHtml(candidate.error.issues[0]?.message ?? 'invalid')}`, {
                parse_mode: 'HTML',
            });
            return;
        }
        const target: Target = candidate.data;

        const saved = await conversation.external(async () => {
            const recipeSaved = await saveRecipe(deps.config.recipesDir, id, outcome.recipe);
            if (isErr(recipeSaved)) {
                return { ok: false as const, message: recipeSaved.error.message };
            }
            const targetSaved = await saveTarget(deps.config.targetsDir, target);
            if (isErr(targetSaved)) {
                return { ok: false as const, message: targetSaved.error.message };
            }
            return { ok: true as const };
        });

        if (!saved.ok) {
            await ctx.reply(`Could not save: ${escapeHtml(saved.message)}`, { parse_mode: 'HTML' });
            return;
        }

        await ctx.reply(
            `✅ Watching <b>${escapeHtml(id)}</b>, checking every 15 minutes.\n\n` +
                `Filters default to none and match threshold to 0.7 — edit ` +
                `<code>targets/${escapeHtml(id)}.yaml</code> to narrow it down.\n\n` +
                `<i>Note: the dev container only reaches hosts listed in targets/, so a new ` +
                `host needs a firewall refresh before it will poll from inside there.</i>`,
            { parse_mode: 'HTML' },
        );
    };
}
