/**
 * Composition root: the long-running service.
 *
 * Startup deliberately validates everything that can be validated before the first poll —
 * token, model, vision capability, target files. A polling bot's characteristic failure is
 * silence, and silence is indistinguishable from "nothing new". Anything that would cause
 * silence must fail loudly at boot instead.
 */

import { loadConfig, requireTelegram } from './core/config.ts';
import { isErr } from './core/result.ts';
import { closeBrowser } from './fetch/index.ts';
import { loadAllTargets, loadTarget } from './extract/recipe.ts';
import { modelExists, modelSupportsVision, type OllamaOptions } from './llm/ollama.ts';
import { closeStore, openStore } from './store/db.ts';
import { startScheduler } from './schedule/scheduler.ts';
import { createBot, notifyListing, sendText, verifyBot } from './telegram/bot.ts';
import { registerCommands } from './telegram/commands.ts';
import { createConversation } from '@grammyjs/conversations';
import { buildAddConversation } from './telegram/conversation.ts';
import type { PollReport } from './pipeline/poll.ts';
import { escapeHtml } from './telegram/render.ts';

async function main(): Promise<number> {
    const configResult = loadConfig();
    if (isErr(configResult)) {
        process.stderr.write(`config error: ${configResult.error.message}\n`);
        return 1;
    }
    const config = configResult.value;

    const telegramConfig = requireTelegram(config);
    if (isErr(telegramConfig)) {
        process.stderr.write(`${telegramConfig.error.message}\n`);
        return 1;
    }

    const ollama: OllamaOptions = {
        url: config.ollamaUrl,
        model: config.scoutModel,
        timeoutMs: config.ollamaTimeoutMs,
    };

    // --- Preflight ------------------------------------------------------------------
    const exists = await modelExists(ollama);
    if (isErr(exists)) {
        process.stderr.write(`${exists.error.message}\n`);
        return 1;
    }
    if (!exists.value) {
        process.stderr.write(`model '${config.scoutModel}' not found on ${config.ollamaUrl}\n`);
        return 1;
    }

    const vision = await modelSupportsVision(ollama);
    const visionOk = !isErr(vision) && vision.value;

    const store = openStore(config.dbPath);
    if (isErr(store)) {
        process.stderr.write(`${store.error.message}\n`);
        return 1;
    }

    const { targets, errors } = await loadAllTargets(config.targetsDir);
    for (const e of errors) {
        process.stderr.write(`target error: ${e.message}\n`);
    }

    const scout = createBot(telegramConfig.value);
    const identity = await verifyBot(scout);
    if (isErr(identity)) {
        process.stderr.write(`${identity.error.message}\n`);
        closeStore(store.value);
        return 1;
    }

    // photoGrade is honoured only if the model can actually see. Warning here rather than
    // failing per-listing at 3am with an opaque API error.
    const photoTargets = targets.filter((t) => t.notify.photoGrade).map((t) => t.id);
    if (!visionOk && photoTargets.length > 0) {
        process.stderr.write(
            `warning: photoGrade is on for ${photoTargets.join(', ')} but ${config.scoutModel} has no vision capability — photos will be skipped\n`,
        );
    }

    process.stdout.write(
        `scout up as @${identity.value}\n` +
            `  model    ${config.scoutModel}${visionOk ? ' (vision)' : ''}\n` +
            `  targets  ${targets.length} (${targets.filter((t) => t.enabled).length} active)\n` +
            `  db       ${config.dbPath}\n`,
    );

    // --- Wiring ---------------------------------------------------------------------
    const scheduler = startScheduler(targets, {
        config,
        ollama,
        store: store.value,
        onReport: async (report: PollReport) => {
            // Warnings are per-listing failures — a scoring call that errored, an image
            // that would not load. They are individually survivable, which is exactly why
            // they must be surfaced: eleven of thirteen listings silently failing to score
            // reports as a clean "notified 0" and looks identical to a quiet market.
            for (const warning of report.warnings) {
                process.stderr.write(`warn [${report.targetId}]: ${warning}\n`);
            }

            // A minority of failures is noise; a majority means something is broken and
            // the listings are being deferred to the next poll rather than delivered.
            const failedScores = report.warnings.filter((w) => w.startsWith('scoring failed')).length;
            if (failedScores > 0 && failedScores >= report.fresh / 2) {
                await sendText(
                    scout,
                    `⚠️ <b>${escapeHtml(report.targetId)}</b>: ${failedScores} of ${report.fresh} new listings failed to score.\n` +
                        `They are NOT lost — unscored listings stay unrecorded and retry next poll.\n\n` +
                        `<code>${escapeHtml(report.warnings[0]?.slice(0, 300) ?? '')}</code>`,
                );
            }

            for (const notification of report.notifications) {
                const sent = await notifyListing(scout, notification.listing, notification.verdict);
                if (isErr(sent)) {
                    process.stderr.write(`notify failed: ${sent.error.message}\n`);
                    continue;
                }
                store.value.db
                    .prepare('UPDATE listings SET notified_at = ? WHERE fingerprint = ?')
                    .run(Date.now(), notification.listing.fingerprint);
            }

            // Healing is reported even when it succeeds. A scraper that silently rewrites
            // its own extraction logic is not something to find out about from a git diff
            // weeks later — you want to know the site moved, and what it moved to.
            if (report.healed !== null) {
                const icon = report.healed.outcome === 'healed' ? '🔧' : '⚠️';
                await sendText(
                    scout,
                    `${icon} <b>${escapeHtml(report.targetId)}</b> — ${escapeHtml(report.healed.outcome)}\n` +
                        `<code>${escapeHtml(report.healed.message)}</code>` +
                        (report.healed.outcome === 'healed'
                            ? `\n\nThe regenerated recipe is committed to <code>recipes/</code> — review the diff.`
                            : ''),
                );
            } else if (report.extracted === 0) {
                // Empty but no heal attempted: either the streak is too short to be
                // conclusive, or the cooldown is holding. Say which, since "0 listings"
                // alone looks identical to a quiet market.
                await sendText(
                    scout,
                    `⚠️ <b>${escapeHtml(report.targetId)}</b> extracted 0 listings.\n` +
                        (report.warnings.length > 0 ? `${escapeHtml(report.warnings.join('; '))}\n` : '') +
                        `Regenerate now with <code>yarn scout generate ${escapeHtml(report.targetId)}</code>`,
                );
            }
        },
        onError: async (targetId: string, message: string) => {
            process.stderr.write(`poll error [${targetId}]: ${message}\n`);
            await sendText(scout, `⚠️ <b>${escapeHtml(targetId)}</b>: ${escapeHtml(message)}`);
        },
    });

    registerCommands(scout.bot, {
        config,
        store: store.value,
        runNow: async (targetId: string): Promise<string> => {
            const target = await loadTarget(config.targetsDir, targetId);
            if (isErr(target)) {
                return `No such target: ${escapeHtml(targetId)}`;
            }
            const report = await scheduler.runNow(target.value);
            if (report === null) {
                return 'A poll is already running — try again shortly.';
            }
            // `judged` is reported alongside `new` on purpose. Without it, "new 13 ·
            // notified 0" is ambiguous between "nothing matched" and "nothing was
            // evaluated" — and those call for completely different responses.
            const failed = report.fresh - report.judged;
            return (
                `<b>${escapeHtml(report.targetId)}</b>\n` +
                `extracted ${report.extracted} · passed ${report.passedFilters} · ` +
                `new ${report.fresh} · judged ${report.judged} · notified ${report.notifications.length}` +
                (failed > 0
                    ? `\n\n⚠️ ${failed} could not be scored (will retry next poll)\n` +
                      `<code>${escapeHtml(report.warnings[0]?.slice(0, 250) ?? '')}</code>`
                    : '')
            );
        },
    });

    // The wizard must be registered as middleware AND given an entry point; creating the
    // handler alone leaves /add silently inert.
    scout.bot.use(createConversation(buildAddConversation({ config, ollama }), 'add'));
    scout.bot.command('add', async (ctx) => {
        await ctx.conversation.enter('add');
    });

    const shutdown = async (signal: string): Promise<void> => {
        process.stdout.write(`\n${signal} — shutting down\n`);
        scheduler.stop();
        await scout.bot.stop();
        await closeBrowser();
        closeStore(store.value);
        process.exit(0);
    };

    process.once('SIGINT', () => {
        void shutdown('SIGINT');
    });
    process.once('SIGTERM', () => {
        void shutdown('SIGTERM');
    });

    // Long polling: no public URL, no webhook, no inbound port to expose.
    await scout.bot.start({
        onStart: () => {
            process.stdout.write('listening for commands\n');
        },
    });
    return 0;
}

main()
    .then((code) => {
        process.exitCode = code;
    })
    .catch((thrown: unknown) => {
        process.stderr.write(`fatal: ${String(thrown)}\n`);
        process.exitCode = 1;
    });
