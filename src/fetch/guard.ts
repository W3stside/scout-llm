/**
 * SSRF and resource-exhaustion guards for everything that fetches hostile input.
 *
 * Scout's fetch paths request URLs an attacker can influence: the target page itself, the
 * `image` field lifted verbatim off that page, and URLs the model proposes after reading a
 * site's own homepage. The scraper container also has open egress AND a route toward the
 * host (the docker bridge), where an unauthenticated Ollama listens — so "fetch whatever
 * the page said" must never be allowed to mean "connect to 127.0.0.1, the bridge gateway,
 * or the cloud metadata range".
 *
 * The guard runs at CONNECT time, not on the URL string. That placement is load-bearing
 * twice over:
 *
 *   Redirects — every hop of the redirect interceptor opens its own connection, so a
 *   target that 302s to 127.0.0.1 is caught at the hop, not sailed through because only
 *   the first URL was inspected.
 *
 *   DNS rebinding — the socket is pinned to the exact address that passed validation,
 *   because the validated address IS what the lookup hands to net.connect. A hostname
 *   that re-resolves to something private between check and connect has no window to
 *   exploit: there is no separate check-then-resolve.
 *
 * String-level checks still exist (`hostGuardError`) for the two cases a lookup hook
 * cannot see: IP-literal hostnames, which net.connect never passes to lookup, and the
 * browser path, where Chromium does its own resolution and only URL inspection is
 * available.
 */

import { lookup as dnsLookup, promises as dnsPromises } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { buildConnector } from 'undici';
import type { Result } from '../core/result.ts';
import { err, messageOf, ok } from '../core/result.ts';
import { scoutError, type ScoutError } from '../core/types.ts';

// --- Address classification -----------------------------------------------------------

type _V4Range = { readonly base: number; readonly maskBits: number };

function _v4ToInt(octets: readonly number[]): number {
    // >>> 0 keeps the value an unsigned 32-bit int; without it 224.x and up go negative.
    return (((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)) >>> 0;
}

/**
 * Everything that is not the public internet. Broader than "RFC1918": link-local carries
 * cloud metadata (169.254.169.254), CGNAT space appears on the inside of ISP and container
 * networks, and the benchmark/documentation ranges never legitimately serve listings.
 */
const _BLOCKED_V4: readonly _V4Range[] = [
    { base: _v4ToInt([0, 0, 0, 0]), maskBits: 8 }, // "this network"
    { base: _v4ToInt([10, 0, 0, 0]), maskBits: 8 }, // RFC1918
    { base: _v4ToInt([100, 64, 0, 0]), maskBits: 10 }, // CGNAT
    { base: _v4ToInt([127, 0, 0, 0]), maskBits: 8 }, // loopback
    { base: _v4ToInt([169, 254, 0, 0]), maskBits: 16 }, // link-local + cloud metadata
    { base: _v4ToInt([172, 16, 0, 0]), maskBits: 12 }, // RFC1918 — includes the docker bridge
    { base: _v4ToInt([192, 0, 0, 0]), maskBits: 24 }, // IETF protocol assignments
    { base: _v4ToInt([192, 0, 2, 0]), maskBits: 24 }, // documentation
    { base: _v4ToInt([192, 168, 0, 0]), maskBits: 16 }, // RFC1918
    { base: _v4ToInt([198, 18, 0, 0]), maskBits: 15 }, // benchmarking
    { base: _v4ToInt([198, 51, 100, 0]), maskBits: 24 }, // documentation
    { base: _v4ToInt([203, 0, 113, 0]), maskBits: 24 }, // documentation
    { base: _v4ToInt([224, 0, 0, 0]), maskBits: 4 }, // multicast
    { base: _v4ToInt([240, 0, 0, 0]), maskBits: 4 }, // reserved + broadcast
];

function _isPublicV4(ip: string): boolean {
    const octets = ip.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
        return false;
    }
    const value = _v4ToInt(octets);
    return !_BLOCKED_V4.some(({ base, maskBits }) => {
        const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
        return (value & mask) === (base & mask);
    });
}

/** Expand an IPv6 string to its 8 hextets, handling `::` and an embedded dotted quad. */
function _expandV6(ip: string): readonly number[] | null {
    let working = ip;

    // An embedded IPv4 tail (`::ffff:127.0.0.1`) becomes two hextets.
    const dottedMatch = /:(\d+\.\d+\.\d+\.\d+)$/.exec(working);
    if (dottedMatch !== null && dottedMatch[1] !== undefined) {
        const octets = dottedMatch[1].split('.').map((p) => Number.parseInt(p, 10));
        if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o > 255)) {
            return null;
        }
        const high = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
        const low = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
        working = working.slice(0, dottedMatch.index) + `:${high}:${low}`;
    }

    const halves = working.split('::');
    if (halves.length > 2) {
        return null;
    }
    const head = (halves[0] ?? '').length > 0 ? (halves[0] ?? '').split(':') : [];
    const tail = halves.length === 2 && (halves[1] ?? '').length > 0 ? (halves[1] ?? '').split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (halves.length === 2 ? fill < 0 : head.length !== 8) {
        return null;
    }

    const parts = [...head, ...Array.from({ length: halves.length === 2 ? fill : 0 }, () => '0'), ...tail];
    const hextets = parts.map((p) => Number.parseInt(p, 16));
    if (hextets.length !== 8 || hextets.some((h) => Number.isNaN(h) || h < 0 || h > 0xffff)) {
        return null;
    }
    return hextets;
}

function _isPublicV6(ip: string): boolean {
    const hextets = _expandV6(ip);
    if (hextets === null) {
        return false;
    }
    const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = hextets;

    // Unspecified (::) and loopback (::1).
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0 && h6 === 0) {
        if (h7 === 0 || h7 === 1) {
            return false;
        }
    }
    // IPv4-mapped (::ffff:a.b.c.d) — the verdict is the embedded address's verdict.
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
        return _isPublicV4(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`);
    }
    // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) both embed an IPv4 address that could be
    // private; neither is a route a listing site legitimately requires, so block outright.
    if (h0 === 0x64 && h1 === 0xff9b) {
        return false;
    }
    if (h0 === 0x2002) {
        return false;
    }
    // Discard-only (100::/64) and documentation (2001:db8::/32).
    if (h0 === 0x100 && h1 === 0 && h2 === 0 && h3 === 0) {
        return false;
    }
    if (h0 === 0x2001 && h1 === 0xdb8) {
        return false;
    }
    // ULA (fc00::/7), link-local (fe80::/10), deprecated site-local (fec0::/10).
    if ((h0 & 0xfe00) === 0xfc00) {
        return false;
    }
    if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0) {
        return false;
    }
    // Multicast (ff00::/8).
    if ((h0 & 0xff00) === 0xff00) {
        return false;
    }
    return true;
}

/** Whether this address belongs to the public internet rather than anything local. */
export function isPublicAddress(ip: string): boolean {
    // A zone index (fe80::1%eth0) only ever names a local interface.
    if (ip.includes('%')) {
        return false;
    }
    const family = isIP(ip);
    if (family === 4) {
        return _isPublicV4(ip);
    }
    if (family === 6) {
        return _isPublicV6(ip);
    }
    return false;
}

/**
 * Hostnames that name local infrastructure by convention rather than by address.
 * `.internal` covers both `host.docker.internal` and GCP's `metadata.google.internal`.
 */
const _BLOCKED_NAME_SUFFIXES: readonly string[] = ['.localhost', '.internal', '.local', '.home.arpa'];

/**
 * String-level verdict on a hostname: the reason it must not be fetched, or null.
 *
 * This is the only guard available where connect-time hooks are not (Chromium), and the
 * necessary complement to them where they are: net.connect never calls `lookup` for an
 * IP-literal host, so literals must be judged here. Obfuscated literals (decimal,
 * hex, octal) do not need handling — WHATWG URL parsing already normalized them to
 * dotted-quad form before any hostname reaches this function.
 */
export function hostGuardError(hostname: string): string | null {
    const bare = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
    if (bare.length === 0) {
        return 'empty hostname';
    }
    if (isIP(bare) !== 0) {
        return isPublicAddress(bare) ? null : `${bare} is not a public address`;
    }
    if (bare === 'localhost' || _BLOCKED_NAME_SUFFIXES.some((suffix) => bare.endsWith(suffix))) {
        return `${bare} names local infrastructure`;
    }
    return null;
}

// --- Connect-time enforcement ---------------------------------------------------------

type _LookupCallback = (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
) => void;

/**
 * Resolve, filter to public addresses, and hand net.connect ONLY what passed. Node's
 * happy-eyeballs path may try every returned address, so all of them must be valid, not
 * just the first.
 */
function _guardedLookup(hostname: string, options: LookupOptions, callback: _LookupCallback): void {
    dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error !== null) {
            callback(error, options.all === true ? [] : '');
            return;
        }
        const usable = addresses.filter((entry) => isPublicAddress(entry.address));
        if (usable.length === 0) {
            const refusal: NodeJS.ErrnoException = new Error(
                `refusing to connect to ${hostname}: it resolves only to private or internal addresses`,
            );
            refusal.code = 'ERR_SSRF_BLOCKED';
            callback(refusal, options.all === true ? [] : '');
            return;
        }
        if (options.all === true) {
            callback(null, usable);
            return;
        }
        const first = usable[0];
        if (first === undefined) {
            callback(null, '');
            return;
        }
        callback(null, first.address, first.family);
    });
}

/**
 * DNS-level verdict for callers that cannot hook the connect path — i.e. Chromium, which
 * resolves names itself. A hostname passes only when EVERY address it resolves to is
 * public: a mixed public+private answer is the classic rebinding shape, and the browser
 * is free to pick whichever address we did not check.
 *
 * Verdicts are cached briefly so a page with many same-host subresources costs one
 * lookup, not hundreds. The window this leaves open — Chromium re-resolving to a
 * different answer than we saw — is inherent to not owning the browser's resolver, and is
 * why the HTTP path pins the socket at connect time instead of using this.
 */
const _dnsVerdicts = new Map<string, { readonly allPublic: boolean; readonly at: number }>();
const _DNS_VERDICT_TTL_MS = 60_000;

export async function resolvesOnlyPublic(hostname: string): Promise<boolean> {
    if (hostGuardError(hostname) !== null) {
        return false;
    }
    if (isIP(hostname) !== 0) {
        // A literal already passed hostGuardError; there is nothing to resolve.
        return true;
    }

    const cached = _dnsVerdicts.get(hostname);
    if (cached !== undefined && Date.now() - cached.at < _DNS_VERDICT_TTL_MS) {
        return cached.allPublic;
    }

    let allPublic: boolean;
    try {
        const addresses = await dnsPromises.lookup(hostname, { all: true });
        allPublic = addresses.length > 0 && addresses.every((entry) => isPublicAddress(entry.address));
    } catch {
        // Unresolvable is unfetchable either way; refusing is the safe answer.
        allPublic = false;
    }
    // A hostile page can reference unlimited unique hostnames; the cache must not be the
    // memory leak. Wholesale reset is fine — entries expire in a minute anyway.
    if (_dnsVerdicts.size >= 1_000) {
        _dnsVerdicts.clear();
    }
    _dnsVerdicts.set(hostname, { allPublic, at: Date.now() });
    return allPublic;
}

/**
 * A drop-in undici connector that refuses private destinations. Passed as `connect` when
 * building an Agent, it guards every connection that Agent ever opens — including each
 * redirect hop, which re-enters here with the hop's own hostname.
 */
export function guardedConnector(options?: { readonly timeoutMs?: number }): buildConnector.connector {
    const inner = buildConnector({
        timeout: options?.timeoutMs ?? 10_000,
        lookup: _guardedLookup,
    });
    return function connect(connectOptions, callback) {
        const problem = hostGuardError(connectOptions.hostname);
        if (problem !== null) {
            callback(new Error(`refusing to connect: ${problem}`), null);
            return;
        }
        inner(connectOptions, callback);
    };
}

// --- Bounded body reads ---------------------------------------------------------------

/**
 * Read a response body with a hard byte ceiling, aborting the transfer the moment it is
 * crossed. `res.body.text()` buffers the ENTIRE response before any size can be checked,
 * and undici's bodyTimeout is per-chunk — so without this, a host that slow-drips an
 * endless body walks straight past every timeout into the container's memory limit, and
 * `restart: unless-stopped` turns one hostile response into an OOM-kill loop.
 */
export async function readBodyCapped(body: Readable, maxBytes: number): Promise<Result<Buffer, ScoutError>> {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        for await (const chunk of body) {
            const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            total += piece.byteLength;
            if (total > maxBytes) {
                body.destroy();
                return err(scoutError('network', `response body exceeded ${maxBytes} bytes — aborted`));
            }
            chunks.push(piece);
        }
    } catch (thrown: unknown) {
        return err(scoutError('network', `body read failed: ${messageOf(thrown)}`, { cause: thrown }));
    }
    return ok(Buffer.concat(chunks));
}
