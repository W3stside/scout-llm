/**
 * Turning a verdict into a message.
 *
 * The design constraint is that you read these on a phone, mid-scroll, deciding in about
 * two seconds whether to tap through. So the model's reason goes near the top rather than
 * buried under specs — the specs are visible in the listing itself, the reason is the only
 * thing Scout adds that the site cannot tell you.
 *
 * All user-supplied and model-supplied text is HTML-escaped. A seller who names their car
 * "<b>PERFECT</b>" would otherwise either break the parse or inject formatting into your
 * feed, and Telegram rejects the whole message on malformed HTML — so an unescaped title
 * means a silently dropped notification.
 */

import type { IdentifiedListing, Verdict } from '../core/types.ts';

const PRICE_BADGE: Record<Verdict['priceAssessment'], string> = {
    bargain: '🟢 bargain',
    fair: '⚪ fair price',
    high: '🔴 above market',
    unknown: '',
};

export function escapeHtml(raw: string): string {
    return raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** Thousands separators matching the locale the listings are written in. */
function _formatPrice(amount: number | null, currency: string | null): string {
    if (amount === null) {
        return 'price on request';
    }
    const formatted = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 }).format(amount);
    return currency !== null ? `${formatted} ${currency}` : formatted;
}

function _formatKm(km: number | null): string | null {
    if (km === null) {
        return null;
    }
    return `${new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 }).format(km)} km`;
}

export function renderListing(listing: IdentifiedListing, verdict: Verdict): string {
    const title = escapeHtml(listing.title ?? 'Untitled listing');
    const price = escapeHtml(_formatPrice(listing.price, listing.currency));
    const badge = PRICE_BADGE[verdict.priceAssessment];

    // Only the facts the seller actually stated. Printing "? km" for every omitted field
    // makes a sparse listing look broken rather than merely sparse.
    const specs = [
        listing.year !== null ? String(listing.year) : null,
        _formatKm(listing.km),
        listing.location,
    ]
        .filter((s): s is string => s !== null && s.length > 0)
        .map(escapeHtml)
        .join(' · ');

    const lines = [
        `<b>${title}</b>`,
        `<b>${price}</b>${badge.length > 0 ? `  ${badge}` : ''}`,
        specs.length > 0 ? specs : null,
        '',
        `<i>${escapeHtml(verdict.reason)}</i>`,
        verdict.photoNotes !== null && verdict.photoNotes.length > 0
            ? `📷 <i>${escapeHtml(verdict.photoNotes)}</i>`
            : null,
        '',
        `<a href="${escapeHtml(listing.url)}">Open listing</a>  ·  match ${Math.round(verdict.score * 100)}%`,
    ];

    return lines.filter((l): l is string => l !== null).join('\n');
}

/**
 * Callback payloads are capped by Telegram at 64 bytes, and a fingerprint is 32 hex
 * characters — so an action tag plus a fingerprint fits with room to spare, while a URL
 * would not. That cap is the reason fingerprints are truncated to 32 chars upstream.
 */
export type CallbackAction = 'mute-seller' | 'hide' | 'save';

export function encodeCallback(action: CallbackAction, fingerprint: string): string {
    const encoded = `${action}:${fingerprint}`;
    if (Buffer.byteLength(encoded) > 64) {
        // Truncating would produce a fingerprint that matches nothing; better to hand back
        // a payload the handler will reject loudly.
        return `invalid:${action}`;
    }
    return encoded;
}

export function decodeCallback(data: string): { action: CallbackAction; fingerprint: string } | null {
    const separator = data.indexOf(':');
    if (separator < 0) {
        return null;
    }
    const action = data.slice(0, separator);
    const fingerprint = data.slice(separator + 1);
    if (fingerprint.length === 0) {
        return null;
    }
    if (action !== 'mute-seller' && action !== 'hide' && action !== 'save') {
        return null;
    }
    return { action, fingerprint };
}

/** Compact status line for /list and /status. */
export function renderTargetStatus(input: {
    readonly id: string;
    readonly enabled: boolean;
    readonly url: string;
    readonly total: number;
    readonly notified: number;
    readonly lastRunAt: number | null;
    readonly lastStatus: string | null;
}): string {
    const when =
        input.lastRunAt !== null
            ? `${Math.round((Date.now() - input.lastRunAt) / 60_000)}m ago`
            : 'never run';
    const status = input.lastStatus ?? '—';
    return (
        `${input.enabled ? '▶️' : '⏸'} <b>${escapeHtml(input.id)}</b>\n` +
        `   seen ${input.total} · notified ${input.notified}\n` +
        `   last: ${escapeHtml(status)} ${when}`
    );
}
