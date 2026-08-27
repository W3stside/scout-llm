/**
 * Process configuration, parsed once from the environment.
 *
 * Telegram credentials are deliberately NOT required here. The extraction CLI
 * (`yarn scout run <target>`) is the tool you reach for when a recipe breaks, and
 * demanding a bot token to debug a selector would be a pointless obstacle. The bot
 * validates its own credentials at startup instead — see requireTelegram below.
 */

import { z } from 'zod';
import { resolve } from 'node:path';
import type { Result } from './result.ts';
import { err, ok } from './result.ts';
import { scoutError, type ScoutError } from './types.ts';

const EnvSchema = z.object({
    /**
     * The model lives on the host GPU, never in a container. Inside the dev container
     * this resolves through the host-gateway entry that init-firewall.sh opens; in the
     * compose service it is the bridge gateway address.
     */
    OLLAMA_URL: z.url().default('http://host.docker.internal:11434'),

    /**
     * Baked by scripts/bake-model.sh. Overridable so a run can be pointed at a stock
     * model for comparison without rebaking.
     */
    SCOUT_MODEL: z.string().default('scout'),

    /**
     * Generation is a long, single-shot call over a large condensed page; scoring is
     * short. The generous default is sized for the former on a cold model load, where
     * the first token can be tens of seconds behind the request.
     */
    OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),

    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    /** Only this chat is served. Scout is single-tenant; every other sender is ignored. */
    TELEGRAM_CHAT_ID: z.string().min(1).optional(),

    DATA_DIR: z.string().default('./data'),
    TARGETS_DIR: z.string().default('./targets'),
    RECIPES_DIR: z.string().default('./recipes'),

    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

    /** Politeness floor between requests to the same host, independent of schedule. */
    MIN_HOST_INTERVAL_MS: z.coerce.number().int().nonnegative().default(3_000),
    /** Ignoring robots.txt is opt-in and deliberate, never a silent default. */
    RESPECT_ROBOTS: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
});

export type Config = {
    readonly ollamaUrl: string;
    readonly scoutModel: string;
    readonly ollamaTimeoutMs: number;
    readonly telegramBotToken: string | null;
    readonly telegramChatId: string | null;
    readonly dbPath: string;
    readonly targetsDir: string;
    readonly recipesDir: string;
    readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    readonly minHostIntervalMs: number;
    readonly respectRobots: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Result<Config, ScoutError> {
    const parsed = EnvSchema.safeParse(env);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
        return err(scoutError('config', `invalid environment: ${detail}`));
    }

    const e = parsed.data;
    return ok({
        ollamaUrl: e.OLLAMA_URL.replace(/\/+$/, ''),
        scoutModel: e.SCOUT_MODEL,
        ollamaTimeoutMs: e.OLLAMA_TIMEOUT_MS,
        telegramBotToken: e.TELEGRAM_BOT_TOKEN ?? null,
        telegramChatId: e.TELEGRAM_CHAT_ID ?? null,
        dbPath: resolve(e.DATA_DIR, 'scout.db'),
        targetsDir: resolve(e.TARGETS_DIR),
        recipesDir: resolve(e.RECIPES_DIR),
        logLevel: e.LOG_LEVEL,
        minHostIntervalMs: e.MIN_HOST_INTERVAL_MS,
        respectRobots: e.RESPECT_ROBOTS,
    });
}

/**
 * Narrow a Config to one that provably carries Telegram credentials, so the bot's
 * internals never re-check for null. Called once at bot startup.
 */
export type TelegramConfig = Config & {
    readonly telegramBotToken: string;
    readonly telegramChatId: string;
};

export function requireTelegram(config: Config): Result<TelegramConfig, ScoutError> {
    if (config.telegramBotToken === null || config.telegramChatId === null) {
        return err(
            scoutError(
                'config',
                'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set to run the bot ' +
                    '(the `scout` CLI does not need them)',
            ),
        );
    }
    return ok(config as TelegramConfig);
}
