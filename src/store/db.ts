/**
 * SQLite connection and schema migrations.
 *
 * `new Database(...)` is unavoidable library instantiation. It is confined to this file
 * and never escapes: the rest of the codebase receives the `Store` handle below and
 * calls free functions against it, so no domain module holds a class or uses `this`.
 *
 * Durability matters more than it might seem for a polling bot. The whole value of the
 * seen-set is that it survives restarts — a lost database means every listing on every
 * target looks new at once, and you get a hundred-message burst. Hence WAL plus
 * synchronous=NORMAL: crash-safe against process death, which is the realistic risk in
 * a restart-policy container.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Result } from '../core/result.ts';
import { attempt, err, isErr, ok } from '../core/result.ts';
import { messageOf } from '../core/result.ts';
import { scoutError, type ScoutError } from '../core/types.ts';

export type Store = {
    readonly db: Database.Database;
};

/**
 * Ordered, append-only. Each entry runs once; `user_version` records how far we got, so
 * adding a migration later never re-runs the earlier ones against live data.
 */
const MIGRATIONS: readonly string[] = [
    // 1 — core tables
    `
    CREATE TABLE listings (
        fingerprint  TEXT PRIMARY KEY,
        target_id    TEXT NOT NULL,
        url          TEXT NOT NULL,
        title        TEXT,
        price        REAL,
        currency     TEXT,
        year         INTEGER,
        km           INTEGER,
        location     TEXT,
        image        TEXT,
        extra_json   TEXT NOT NULL DEFAULT '{}',
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        -- Null until judged. Distinguishes "scored below threshold" from "never scored",
        -- which matters when a target's minScore is lowered later.
        score        REAL,
        verdict_json TEXT,
        notified_at  INTEGER
    );
    CREATE INDEX idx_listings_target ON listings(target_id, last_seen);

    CREATE TABLE mutes (
        kind       TEXT NOT NULL CHECK (kind IN ('seller', 'listing')),
        value      TEXT NOT NULL,
        target_id  TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (kind, value, target_id)
    );

    -- Run history drives /status and, more importantly, the healing trigger: N
    -- consecutive zero-extraction runs is what says a recipe has gone stale.
    CREATE TABLE runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        target_id     TEXT NOT NULL,
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER,
        status        TEXT NOT NULL,
        fetch_mode    TEXT,
        listing_count INTEGER NOT NULL DEFAULT 0,
        new_count     INTEGER NOT NULL DEFAULT 0,
        error         TEXT
    );
    CREATE INDEX idx_runs_target ON runs(target_id, started_at DESC);
    `,
];

export function openStore(dbPath: string): Result<Store, ScoutError> {
    const prepared = attempt(() => {
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = new Database(dbPath);
        // WAL lets a read (the Telegram /list handler) proceed while a poll writes.
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('foreign_keys = ON');
        return db;
    });

    if (isErr(prepared)) {
        return err(scoutError('store', `cannot open ${dbPath}: ${messageOf(prepared.error)}`));
    }

    const migrated = _migrate(prepared.value);
    if (isErr(migrated)) {
        return migrated;
    }
    return ok({ db: prepared.value });
}

function _migrate(db: Database.Database): Result<null, ScoutError> {
    const applied = attempt(() => {
        const row = db.pragma('user_version', { simple: true });
        const current = typeof row === 'number' ? row : 0;

        for (let version = current; version < MIGRATIONS.length; version += 1) {
            const sql = MIGRATIONS[version];
            if (sql === undefined) {
                continue;
            }
            // Each migration is one transaction: a failure halfway leaves user_version
            // untouched, so the next start retries from a clean point rather than
            // resuming into a half-built schema.
            db.exec('BEGIN');
            try {
                db.exec(sql);
                db.pragma(`user_version = ${version + 1}`);
                db.exec('COMMIT');
            } catch (thrown: unknown) {
                db.exec('ROLLBACK');
                throw thrown;
            }
        }
        return null;
    });

    if (isErr(applied)) {
        return err(scoutError('store', `migration failed: ${messageOf(applied.error)}`));
    }
    return ok(null);
}

export function closeStore(store: Store): void {
    store.db.close();
}
