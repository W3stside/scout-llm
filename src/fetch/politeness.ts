/**
 * Per-host rate limiting and robots.txt.
 *
 * These are not decorative. Scout polls the same handful of hosts indefinitely, and the
 * realistic failure mode is not a lawsuit but an IP ban that silently breaks every
 * target at once. Spacing requests and honouring robots.txt is what keeps a personal
 * monitor looking like a person.
 *
 * State is process-local and deliberately so — Scout runs as a single container against
 * a handful of targets. A shared limiter would mean coordination for no benefit.
 */

import { request } from 'undici';
import { hostOf } from '../core/url.ts';

const _lastRequestAt = new Map<string, number>();
const _robotsCache = new Map<string, { readonly rules: readonly string[]; readonly fetchedAt: number }>();

const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Block until this host may be hit again, then record the attempt.
 *
 * Jitter is added on top of the floor so successive polls do not land at metronomic
 * intervals — an exactly-3000ms cadence is itself a bot signature.
 */
export async function awaitHostSlot(url: string, minIntervalMs: number): Promise<void> {
    const host = hostOf(url);
    if (host === null) {
        return;
    }

    const last = _lastRequestAt.get(host);
    if (last !== undefined && last !== null) {
        const jitter = Math.floor(Math.random() * (minIntervalMs * 0.4));
        const waitMs = last + minIntervalMs + jitter - Date.now();
        if (waitMs > 0) {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, waitMs);
            });
        }
    }
    _lastRequestAt.set(host, Date.now());
}

/**
 * Whether robots.txt permits fetching this path.
 *
 * Intentionally conservative and simple: it reads Disallow lines under `User-agent: *`
 * and treats them as prefix rules. It does not implement Allow-precedence or wildcard
 * expansion, because erring toward "don't fetch" is the right bias here — a false
 * positive costs one target, a false negative costs the IP.
 *
 * Fails OPEN on a network error: robots.txt being unreachable is not evidence of a
 * prohibition, and failing closed would make an unrelated blip disable every target.
 */
export async function isAllowedByRobots(url: string): Promise<boolean> {
    const host = hostOf(url);
    if (host === null) {
        return false;
    }

    const rules = await _robotsFor(host);
    if (rules === null) {
        return true;
    }

    let path: string;
    try {
        path = new URL(url).pathname;
    } catch {
        return false;
    }

    return !rules.some((rule) => rule.length > 0 && path.startsWith(rule));
}

async function _robotsFor(host: string): Promise<readonly string[] | null> {
    const cached = _robotsCache.get(host);
    if (cached !== undefined && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) {
        return cached.rules;
    }

    try {
        const res = await request(`https://${host}/robots.txt`, {
            method: 'GET',
            headers: { 'user-agent': DESKTOP_USER_AGENT },
            headersTimeout: 8_000,
            bodyTimeout: 8_000,
        });

        if (res.statusCode !== 200) {
            // No robots.txt is an absence of restriction, not a restriction.
            _robotsCache.set(host, { rules: [], fetchedAt: Date.now() });
            return [];
        }

        const body = await res.body.text();
        const rules = _parseWildcardDisallows(body);
        _robotsCache.set(host, { rules, fetchedAt: Date.now() });
        return rules;
    } catch {
        return null;
    }
}

/** Disallow prefixes declared under `User-agent: *`, ignoring other agent blocks. */
function _parseWildcardDisallows(body: string): readonly string[] {
    const rules: string[] = [];
    let inWildcardBlock = false;

    for (const rawLine of body.split('\n')) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (line.length === 0) {
            continue;
        }

        const uaMatch = /^user-agent\s*:\s*(.+)$/i.exec(line);
        if (uaMatch !== null) {
            const agent = uaMatch[1]?.trim();
            inWildcardBlock = agent === '*';
            continue;
        }

        if (!inWildcardBlock) {
            continue;
        }

        const disallowMatch = /^disallow\s*:\s*(.*)$/i.exec(line);
        if (disallowMatch !== null) {
            const rule = disallowMatch[1]?.trim() ?? '';
            if (rule.length > 0) {
                rules.push(rule);
            }
        }
    }
    return rules;
}

/**
 * A current, ordinary desktop Chrome UA. Sending undici's default announces a scripted
 * client and gets a challenge page on most classifieds sites before anything else is
 * considered.
 */
export const DESKTOP_USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/** Header set matching the UA above. Mismatched headers are themselves a bot signal. */
export function browserLikeHeaders(referer?: string): Record<string, string> {
    return {
        'user-agent': DESKTOP_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'pt-PT,pt;q=0.9,en;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
        'sec-ch-ua': '"Chromium";v="139", "Not(A:Brand";v="24", "Google Chrome";v="139"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': referer !== undefined && referer !== null ? 'same-origin' : 'none',
        'sec-fetch-user': '?1',
        'upgrade-insecure-requests': '1',
        ...(referer !== undefined && referer !== null ? { referer } : {}),
    };
}

/** Test seam — the module-level caches would otherwise leak between test cases. */
export function _resetPolitenessState(): void {
    _lastRequestAt.clear();
    _robotsCache.clear();
}
