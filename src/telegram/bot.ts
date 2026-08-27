/**
 * The Telegram adapter.
 *
 * `new Bot()` is unavoidable library instantiation; it is confined to this file and never
 * escapes. Everything outside receives the `ScoutBot` handle and calls free functions
 * against it, so no domain module holds a class or uses `this`.
 *
 * Scout is single-tenant by construction. Exactly one chat id is served and every other
 * sender is ignored without reply — a bot token is a bearer credential that anyone who
 * finds it can message, and a scraper that answers strangers is a scraper that scrapes on
 * their behalf. Silence rather than "unauthorized" is deliberate: a refusal confirms the
 * bot exists and is live.
 */

import { Bot, GrammyError, HttpError, InlineKeyboard } from 'grammy';
import { conversations } from '@grammyjs/conversations';
import type { ScoutContext } from './conversation.ts';
import type { TelegramConfig } from '../core/config.ts';
import type { Result } from '../core/result.ts';
import { err, messageOf, ok } from '../core/result.ts';
import { scoutError, type IdentifiedListing, type ScoutError, type Verdict } from '../core/types.ts';
import { encodeCallback, renderListing } from './render.ts';

export type ScoutBot = {
    readonly bot: Bot<ScoutContext>;
    readonly chatId: string;
};

export function createBot(config: TelegramConfig): ScoutBot {
    const bot = new Bot<ScoutContext>(config.telegramBotToken);

    // Ignore everything from anyone else, silently. Registered before any handler so no
    // downstream middleware can be reached by an unauthorized sender.
    bot.use(async (ctx, next) => {
        const from = ctx.chat?.id ?? ctx.from?.id;
        if (from === undefined || String(from) !== config.telegramChatId) {
            return;
        }
        await next();
    });

    // Installed after the auth guard so an unauthorized sender can never allocate
    // conversation state — otherwise a stranger spamming /add would grow memory unbounded.
    bot.use(conversations());

    // A handler that throws must not kill the long-polling loop — the bot has to survive
    // a malformed listing or a transient Telegram fault and keep serving.
    bot.catch((botError) => {
        const cause = botError.error;
        if (cause instanceof GrammyError) {
            process.stderr.write(`telegram api error: ${cause.description}\n`);
        } else if (cause instanceof HttpError) {
            process.stderr.write(`telegram unreachable: ${messageOf(cause)}\n`);
        } else {
            process.stderr.write(`bot handler failed: ${messageOf(cause)}\n`);
        }
    });

    return { bot, chatId: config.telegramChatId };
}

/**
 * Telegram's limits, which differ by message kind. Exceeding either is a hard API
 * rejection, not a truncation — so a long model reason would drop the notification
 * entirely rather than arrive clipped.
 */
const CAPTION_LIMIT = 1024;
const MESSAGE_LIMIT = 4096;

export async function notifyListing(
    scout: ScoutBot,
    listing: IdentifiedListing,
    verdict: Verdict,
): Promise<Result<null, ScoutError>> {
    const text = renderListing(listing, verdict);

    const keyboard = new InlineKeyboard()
        .text('🔇 Mute seller', encodeCallback('mute-seller', listing.fingerprint))
        .text('🚫 Hide', encodeCallback('hide', listing.fingerprint))
        .text('⭐ Save', encodeCallback('save', listing.fingerprint));

    try {
        // A photo makes the notification scannable, but only if the caption fits. Falling
        // back to a text message is better than dropping the photo AND the detail.
        if (listing.image !== null && text.length <= CAPTION_LIMIT) {
            await scout.bot.api.sendPhoto(scout.chatId, listing.image, {
                caption: text,
                parse_mode: 'HTML',
                reply_markup: keyboard,
            });
            return ok(null);
        }

        await scout.bot.api.sendMessage(scout.chatId, text.slice(0, MESSAGE_LIMIT), {
            parse_mode: 'HTML',
            reply_markup: keyboard,
            link_preview_options: { is_disabled: false },
        });
        return ok(null);
    } catch (thrown: unknown) {
        // A broken image URL is common and must not lose the listing — retry as text once.
        if (listing.image !== null) {
            try {
                await scout.bot.api.sendMessage(scout.chatId, text.slice(0, MESSAGE_LIMIT), {
                    parse_mode: 'HTML',
                    reply_markup: keyboard,
                });
                return ok(null);
            } catch (retryThrown: unknown) {
                return err(scoutError('network', `telegram send failed: ${messageOf(retryThrown)}`, { cause: retryThrown }));
            }
        }
        return err(scoutError('network', `telegram send failed: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

export async function sendText(scout: ScoutBot, text: string): Promise<Result<null, ScoutError>> {
    try {
        await scout.bot.api.sendMessage(scout.chatId, text.slice(0, MESSAGE_LIMIT), { parse_mode: 'HTML' });
        return ok(null);
    } catch (thrown: unknown) {
        return err(scoutError('network', `telegram send failed: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

/**
 * Chat ids that have recently messaged this bot.
 *
 * "chat not found" is ambiguous — a wrong id and a conversation you have never opened look
 * identical, and Telegram will not let a bot message someone who has not written to it
 * first. getUpdates resolves which it is: if your message is there, the id it reports is
 * the one to configure; if nothing is there, you have not messaged the bot yet.
 *
 * Only the ids and names are returned. Message text is deliberately not surfaced.
 */
export async function recentChats(
    scout: ScoutBot,
): Promise<Result<readonly { id: string; label: string }[], ScoutError>> {
    try {
        const updates = await scout.bot.api.getUpdates({ limit: 20, timeout: 0 });
        const seen = new Map<string, string>();
        for (const update of updates) {
            const chat = update.message?.chat ?? update.channel_post?.chat;
            if (chat === undefined) {
                continue;
            }
            const label =
                'username' in chat && chat.username !== undefined
                    ? `@${chat.username}`
                    : 'title' in chat && chat.title !== undefined
                      ? chat.title
                      : `${chat.type} chat`;
            seen.set(String(chat.id), label);
        }
        return ok([...seen].map(([id, label]) => ({ id, label })));
    } catch (thrown: unknown) {
        return err(scoutError('config', `could not read updates: ${messageOf(thrown)}`, { cause: thrown }));
    }
}

/**
 * Confirm the token works and report who we are.
 *
 * Called at startup so a bad token fails immediately and loudly, rather than as a silent
 * no-op fifteen minutes later when the first listing is ready to send.
 */
export async function verifyBot(scout: ScoutBot): Promise<Result<string, ScoutError>> {
    try {
        const me = await scout.bot.api.getMe();
        return ok(me.username);
    } catch (thrown: unknown) {
        return err(scoutError('config', `telegram token rejected: ${messageOf(thrown)}`, { cause: thrown }));
    }
}
