/**
 * Command handlers.
 *
 * Every command that changes what Scout watches writes to targets/*.yaml — the same files
 * you hand-edit and commit. Chat and git stay one source of truth rather than two, so
 * `/add` from your phone produces a reviewable diff, and editing the YAML directly is
 * picked up without any sync step.
 */

import type { Bot, Context } from 'grammy';
import type { ScoutContext } from './conversation.ts';
import type { Config } from '../core/config.ts';
import { isErr, isOk } from '../core/result.ts';
import { asTargetId, type Target } from '../core/types.ts';
import { loadAllTargets, loadTarget, saveTarget } from '../extract/recipe.ts';
import { addMute, statsFor } from '../store/listings.ts';
import type { Store } from '../store/db.ts';
import { decodeCallback, escapeHtml, renderTargetStatus } from './render.ts';

export type CommandDeps = {
    readonly config: Config;
    readonly store: Store;
    /** Runs a target immediately, out of schedule. Injected to avoid a cycle with the scheduler. */
    readonly runNow: (targetId: string) => Promise<string>;
};

export function registerCommands(bot: Bot<ScoutContext>, deps: CommandDeps): void {
    bot.command('start', async (ctx) => {
        await ctx.reply(
            'Scout is watching.\n\n' +
                '/list — targets and their state\n' +
                '/status — health and last run\n' +
                '/run &lt;id&gt; — poll now\n' +
                '/pause &lt;id&gt; · /resume &lt;id&gt;\n' +
                '/add — watch a new search\n' +
                '/remove &lt;id&gt;',
            { parse_mode: 'HTML' },
        );
    });

    bot.command('list', async (ctx) => {
        const { targets, errors } = await loadAllTargets(deps.config.targetsDir);
        if (targets.length === 0 && errors.length === 0) {
            await ctx.reply('No targets configured. Send /add to start watching a search.');
            return;
        }

        const blocks = targets.map((t) => {
            const stats = statsFor(deps.store, asTargetId(t.id));
            return renderTargetStatus({
                id: t.id,
                enabled: t.enabled,
                url: t.url,
                total: stats.total,
                notified: stats.notified,
                lastRunAt: stats.lastRunAt,
                lastStatus: stats.lastStatus,
            });
        });

        // Broken files are surfaced rather than silently omitted — a target that vanished
        // from /list because its YAML is malformed is worse than one shown as broken.
        for (const e of errors) {
            blocks.push(`⚠️ ${escapeHtml(e.message)}`);
        }
        await ctx.reply(blocks.join('\n\n'), { parse_mode: 'HTML' });
    });

    bot.command('status', async (ctx) => {
        const { targets, errors } = await loadAllTargets(deps.config.targetsDir);
        const enabled = targets.filter((t) => t.enabled).length;
        await ctx.reply(
            `<b>Scout</b>\n` +
                `targets: ${targets.length} (${enabled} active)\n` +
                `model: ${escapeHtml(deps.config.scoutModel)}\n` +
                `robots.txt: ${deps.config.respectRobots ? 'respected' : 'IGNORED'}\n` +
                (errors.length > 0 ? `\n⚠️ ${errors.length} unreadable target file(s)` : ''),
            { parse_mode: 'HTML' },
        );
    });

    bot.command('run', async (ctx) => {
        const id = _argOf(ctx.match);
        if (id === null) {
            await ctx.reply('Usage: /run <id>');
            return;
        }
        await ctx.reply(`Polling ${escapeHtml(id)}…`, { parse_mode: 'HTML' });
        const summary = await deps.runNow(id);
        await ctx.reply(summary, { parse_mode: 'HTML' });
    });

    bot.command('pause', async (ctx) => {
        await _setEnabled(ctx, deps, _argOf(ctx.match), false);
    });

    bot.command('resume', async (ctx) => {
        await _setEnabled(ctx, deps, _argOf(ctx.match), true);
    });

    bot.command('remove', async (ctx) => {
        const id = _argOf(ctx.match);
        if (id === null) {
            await ctx.reply('Usage: /remove <id>');
            return;
        }
        // Disabled rather than deleted. The seen-set is the expensive thing here — losing
        // it means every listing looks new if you ever re-add the search, and you get a
        // hundred-message burst for cars you already rejected.
        await _setEnabled(ctx, deps, id, false);
        await ctx.reply(
            `Paused <b>${escapeHtml(id)}</b>. Its history is kept, so resuming will not re-alert.\n` +
                `Delete targets/${escapeHtml(id)}.yaml to remove it permanently.`,
            { parse_mode: 'HTML' },
        );
    });

    bot.on('callback_query:data', async (ctx) => {
        await _handleCallback(ctx, deps);
    });
}

function _argOf(match: unknown): string | null {
    if (typeof match !== 'string') {
        return null;
    }
    const trimmed = match.trim();
    return trimmed.length > 0 ? trimmed : null;
}

async function _setEnabled(
    ctx: Context,
    deps: CommandDeps,
    id: string | null,
    enabled: boolean,
): Promise<void> {
    if (id === null) {
        await ctx.reply(`Usage: /${enabled ? 'resume' : 'pause'} <id>`);
        return;
    }

    const loaded = await loadTarget(deps.config.targetsDir, id);
    if (isErr(loaded)) {
        await ctx.reply(`No such target: ${escapeHtml(id)}`, { parse_mode: 'HTML' });
        return;
    }

    const updated: Target = { ...loaded.value, enabled };
    const saved = await saveTarget(deps.config.targetsDir, updated);
    if (isErr(saved)) {
        await ctx.reply(`Could not save: ${escapeHtml(saved.error.message)}`, { parse_mode: 'HTML' });
        return;
    }
    await ctx.reply(`${enabled ? '▶️ Resumed' : '⏸ Paused'} <b>${escapeHtml(id)}</b>`, { parse_mode: 'HTML' });
}

/**
 * Only the surface the handler actually touches.
 *
 * grammY's own CallbackQueryContext generic does not compose with
 * exactOptionalPropertyTypes, and loosening that compiler flag repo-wide to satisfy one
 * signature would be the wrong trade — a structural type costs nothing and keeps the
 * handler independent of grammY's context generics.
 */
type CallbackCtx = {
    readonly callbackQuery: { readonly data: string };
    readonly answerCallbackQuery: (options?: { text?: string; show_alert?: boolean }) => Promise<unknown>;
};

async function _handleCallback(ctx: CallbackCtx, deps: CommandDeps): Promise<void> {
    const decoded = decodeCallback(ctx.callbackQuery.data);
    if (decoded === null) {
        await ctx.answerCallbackQuery({ text: 'Unrecognised action' });
        return;
    }

    const row = deps.store.db
        .prepare('SELECT target_id, url, extra_json FROM listings WHERE fingerprint = ?')
        .get(decoded.fingerprint) as
        { readonly target_id: string; readonly url: string; readonly extra_json: string } | undefined;

    if (row === undefined) {
        await ctx.answerCallbackQuery({ text: 'That listing is no longer on file' });
        return;
    }

    const targetId = asTargetId(row.target_id);

    switch (decoded.action) {
        case 'hide':
            addMute(deps.store, 'listing', row.url, targetId);
            await ctx.answerCallbackQuery({ text: 'Hidden' });
            break;

        case 'mute-seller': {
            const seller = _sellerOf(row.extra_json);
            if (seller === null) {
                // Honest failure: the recipe did not capture a seller, so there is nothing
                // to mute. Silently muting the listing instead would look like it worked.
                await ctx.answerCallbackQuery({
                    text: 'No seller captured for this listing — hiding it instead',
                    show_alert: true,
                });
                addMute(deps.store, 'listing', row.url, targetId);
                break;
            }
            // Muted across every target: a dealer you never want to hear from is not
            // specific to the search that happened to surface them.
            addMute(deps.store, 'seller', seller, null);
            await ctx.answerCallbackQuery({ text: `Muted ${seller}` });
            break;
        }

        case 'save':
            deps.store.db
                .prepare('UPDATE listings SET notified_at = COALESCE(notified_at, ?) WHERE fingerprint = ?')
                .run(Date.now(), decoded.fingerprint);
            await ctx.answerCallbackQuery({ text: 'Saved' });
            break;
    }
}

function _sellerOf(extraJson: string): string | null {
    try {
        const parsed: unknown = JSON.parse(extraJson);
        if (typeof parsed !== 'object' || parsed === null) {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        for (const key of ['seller', 'dealer', 'sellerName']) {
            const value = record[key];
            if (typeof value === 'string' && value.trim().length > 0) {
                return value.trim();
            }
        }
        return null;
    } catch {
        return null;
    }
}

export { isOk };
