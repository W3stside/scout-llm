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
import { TargetSchema, type Target } from '../core/types.ts';
import { fetchPage, closeBrowser } from '../fetch/index.ts';
import { generateRecipe } from '../extract/generate.ts';
import { applyRecipe } from '../extract/selectors.ts';
import { saveRecipe, saveTarget } from '../extract/recipe.ts';
import type { OllamaOptions } from '../llm/ollama.ts';
import { escapeHtml } from './render.ts';

export type ScoutContext = ConversationFlavor<Context>;
export type ScoutConversation = Conversation<ScoutContext, ScoutContext>;

export type AddDeps = {
    readonly config: Config;
    readonly ollama: OllamaOptions;
};

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
            'Send me the URL of a <b>search results page</b> — already filtered the way you want it.\n\n' +
                'The more the site itself narrows things down, the less noise you get.\n\n' +
                'Send /cancel to stop.',
            { parse_mode: 'HTML' },
        );

        const urlCtx = await conversation.waitFor('message:text');
        const url = urlCtx.message.text.trim();
        if (url === '/cancel') {
            await ctx.reply('Cancelled.');
            return;
        }
        if (!/^https?:\/\//i.test(url)) {
            await ctx.reply('That does not look like a URL. Start over with /add.');
            return;
        }

        await ctx.reply(
            'Now describe what you are looking for, in plain words.\n\n' +
                'Include the things a price filter cannot express — condition, seller type, ' +
                'trim, anything you would tell a friend who was looking on your behalf.',
        );

        const criteriaCtx = await conversation.waitFor('message:text');
        const criteria = criteriaCtx.message.text.trim();
        if (criteria === '/cancel') {
            await ctx.reply('Cancelled.');
            return;
        }

        await ctx.reply('Fetching the page…');

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

            return {
                kind: 'ok' as const,
                recipe: generated.value.recipe,
                notes: generated.value.notes,
                listings: extracted.value.slice(0, 3),
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

        const preview = outcome.listings
            .map((l) => {
                const price = l.price !== null ? `${l.price} ${l.currency ?? ''}`.trim() : 'no price';
                return `• <b>${escapeHtml(l.title ?? 'untitled')}</b> — ${escapeHtml(price)}`;
            })
            .join('\n');

        await ctx.reply(
            `Found <b>${outcome.count}</b> listings via ${outcome.via}.\n\n${preview}\n\n` +
                `Look right? Send a short <b>name</b> for this search (letters, numbers, hyphens), ` +
                `or /cancel.`,
            { parse_mode: 'HTML' },
        );

        const nameCtx = await conversation.waitFor('message:text');
        const rawName = nameCtx.message.text.trim();
        if (rawName === '/cancel') {
            await ctx.reply('Cancelled — nothing saved.');
            return;
        }

        const id = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || _suggestId(url);

        const candidate = TargetSchema.safeParse({ id, url, criteria });
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
