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

            // A target that suddenly extracts nothing has almost certainly had its recipe
            // invalidated by a redesign. Reported rather than logged, because the whole
            // symptom is an absence of messages — which looks exactly like a quiet market.
            if (report.extracted === 0) {
                await sendText(
                    scout,
                    `⚠️ <b>${escapeHtml(report.targetId)}</b> extracted 0 listings.\n` +
                        `The recipe may be stale — regenerate with <code>yarn scout generate ${escapeHtml(report.targetId)}</code>`,
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
            return (
                `<b>${escapeHtml(report.targetId)}</b>\n` +
                `extracted ${report.extracted} · passed ${report.passedFilters} · ` +
                `new ${report.fresh} · notified ${report.notifications.length}`
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
