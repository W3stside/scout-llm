/**
 * Seen-set, mute-list and run-history queries.
 *
 * The critical operation is `selectNew`: it decides what the model is even allowed to
 * look at, and therefore what can ever produce a notification. It runs before any
 * inference, on nothing but fingerprints, so the answer is a pure function of what the
 * site served — never of how the model happened to phrase a title this time.
 */

import type { Store } from './db.ts';
import type { Fingerprint, IdentifiedListing, TargetId, Verdict } from '../core/types.ts';
import { asFingerprint } from '../core/types.ts';

type SeenRow = { readonly fingerprint: string };

/**
 * Split a freshly-extracted batch into listings never seen for this target and those
 * already on file, touching `last_seen` for the latter so a still-live ad does not look
 * stale. Returns the new ones for scoring.
 */
export function selectNew(
    store: Store,
    targetId: TargetId,
    listings: readonly IdentifiedListing[],
): readonly IdentifiedListing[] {
    if (listings.length === 0) {
        return [];
    }

    const now = Date.now();
    const seen = _seenFingerprints(store, targetId, listings.map((l) => l.fingerprint));

    const touch = store.db.prepare('UPDATE listings SET last_seen = ? WHERE fingerprint = ?');
    const fresh: IdentifiedListing[] = [];

    const run = store.db.transaction((batch: readonly IdentifiedListing[]) => {
        for (const listing of batch) {
            if (seen.has(listing.fingerprint)) {
                touch.run(now, listing.fingerprint);
            } else {
                fresh.push(listing);
            }
        }
    });
    run(listings);

    return fresh;
}

function _seenFingerprints(
    store: Store,
    targetId: TargetId,
    fingerprints: readonly Fingerprint[],
): ReadonlySet<Fingerprint> {
    const out = new Set<Fingerprint>();
    // Chunked to stay clear of SQLite's variable limit (999 by default). A busy target
    // can easily return more listings than that on a first run.
    const CHUNK = 400;
    for (let i = 0; i < fingerprints.length; i += CHUNK) {
        const slice = fingerprints.slice(i, i + CHUNK);
        if (slice.length === 0) {
            continue;
        }
        const placeholders = slice.map(() => '?').join(',');
        const rows = store.db
            .prepare(
                `SELECT fingerprint FROM listings
                 WHERE target_id = ? AND fingerprint IN (${placeholders})`,
            )
            .all(targetId, ...slice) as SeenRow[];
        for (const row of rows) {
            out.add(asFingerprint(row.fingerprint));
        }
    }
    return out;
}

/**
 * Record listings as seen. Called for new listings AFTER scoring, so a crash mid-judge
 * leaves them unseen and they are retried next poll rather than silently swallowed.
 */
export function recordSeen(
    store: Store,
    listings: readonly IdentifiedListing[],
    verdicts: ReadonlyMap<Fingerprint, Verdict>,
): void {
    const now = Date.now();
    const insert = store.db.prepare(
        `INSERT INTO listings
            (fingerprint, target_id, url, title, price, currency, year, km, location,
             image, extra_json, first_seen, last_seen, score, verdict_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(fingerprint) DO UPDATE SET last_seen = excluded.last_seen`,
    );

    const run = store.db.transaction((batch: readonly IdentifiedListing[]) => {
        for (const l of batch) {
            const verdict = verdicts.get(l.fingerprint);
            insert.run(
                l.fingerprint,
                l.targetId,
                l.url,
                l.title,
                l.price,
                l.currency,
                l.year,
                l.km,
                l.location,
                l.image,
                JSON.stringify(l.extra),
                now,
                now,
                verdict?.score ?? null,
                verdict !== undefined ? JSON.stringify(verdict) : null,
            );
        }
    });
    run(listings);
}

export function markNotified(store: Store, fingerprint: Fingerprint): void {
    store.db
        .prepare('UPDATE listings SET notified_at = ? WHERE fingerprint = ?')
        .run(Date.now(), fingerprint);
}

// --- Mutes --------------------------------------------------------------------------

/**
 * `targetId === null` mutes across every saved search — the right default for a dealer
 * you never want to hear from again, regardless of which search surfaced them.
 */
export function addMute(
    store: Store,
    kind: 'seller' | 'listing',
    value: string,
    targetId: TargetId | null,
): void {
    store.db
        .prepare(
            `INSERT OR IGNORE INTO mutes (kind, value, target_id, created_at) VALUES (?,?,?,?)`,
        )
        .run(kind, value, targetId, Date.now());
}

export function isMuted(
    store: Store,
    kind: 'seller' | 'listing',
    value: string,
    targetId: TargetId,
): boolean {
    const row = store.db
        .prepare(
            `SELECT 1 AS hit FROM mutes
             WHERE kind = ? AND value = ? AND (target_id IS NULL OR target_id = ?)
             LIMIT 1`,
        )
        .get(kind, value, targetId);
    return row !== undefined && row !== null;
}

// --- Run history --------------------------------------------------------------------

export function startRun(store: Store, targetId: TargetId): number {
    const info = store.db
        .prepare(`INSERT INTO runs (target_id, started_at, status) VALUES (?,?,'running')`)
        .run(targetId, Date.now());
    return Number(info.lastInsertRowid);
}

export function finishRun(
    store: Store,
    runId: number,
    outcome: {
        readonly status: 'ok' | 'error' | 'empty';
        readonly fetchMode?: string;
        readonly listingCount?: number;
        readonly newCount?: number;
        readonly error?: string;
    },
): void {
    store.db
        .prepare(
            `UPDATE runs SET finished_at = ?, status = ?, fetch_mode = ?,
                    listing_count = ?, new_count = ?, error = ?
             WHERE id = ?`,
        )
        .run(
            Date.now(),
            outcome.status,
            outcome.fetchMode ?? null,
            outcome.listingCount ?? 0,
            outcome.newCount ?? 0,
            outcome.error ?? null,
            runId,
        );
}

/**
 * How many of the most recent finished runs extracted nothing, counting back from now
 * and stopping at the first run that did produce listings.
 *
 * This is the healing trigger. A single empty run is unremarkable — a transient block,
 * a genuinely empty search. A streak means the recipe no longer matches the page.
 */
export function consecutiveEmptyRuns(store: Store, targetId: TargetId): number {
    // Ordered by id, not started_at: two runs can share a millisecond (back-to-back
    // manual /run, or a burst after a restart), and SQLite breaks that tie arbitrarily.
    // id is AUTOINCREMENT and therefore strictly monotonic in insertion order.
    const rows = store.db
        .prepare(
            `SELECT listing_count FROM runs
             WHERE target_id = ? AND finished_at IS NOT NULL
             ORDER BY id DESC LIMIT 10`,
        )
        .all(targetId) as { readonly listing_count: number }[];

    let streak = 0;
    for (const row of rows) {
        if (row.listing_count > 0) {
            break;
        }
        streak += 1;
    }
    return streak;
}

export type TargetStats = {
    readonly total: number;
    readonly notified: number;
    readonly lastRunAt: number | null;
    readonly lastStatus: string | null;
};

export function statsFor(store: Store, targetId: TargetId): TargetStats {
    const counts = store.db
        .prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN notified_at IS NOT NULL THEN 1 ELSE 0 END) AS notified
             FROM listings WHERE target_id = ?`,
        )
        .get(targetId) as { readonly total: number; readonly notified: number | null };

    const last = store.db
        .prepare(
            `SELECT started_at, status FROM runs
             WHERE target_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(targetId) as { readonly started_at: number; readonly status: string } | undefined;

    return {
        total: counts.total,
        notified: counts.notified ?? 0,
        lastRunAt: last?.started_at ?? null,
        lastStatus: last?.status ?? null,
    };
}
