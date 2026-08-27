/**
 * Heal gating.
 *
 * The decision is separated from the attempt precisely so these rules can be tested
 * without loading a 17GB model. They matter more than the regeneration itself: healing too
 * eagerly re-scrapes a site that is already refusing us, and healing too reluctantly is
 * indistinguishable from the silent breakage it exists to catch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, closeStore, type Store } from '../store/db.ts';
import { finishRun, recordHeal, startRun, lastHealAt } from '../store/listings.ts';
import { asTargetId, TargetSchema, type Target } from '../core/types.ts';
import { EMPTY_RUNS_BEFORE_HEAL, HEAL_COOLDOWN_MS, shouldHeal } from './heal.ts';
import { isOk } from '../core/result.ts';

const TARGET: Target = TargetSchema.parse({
    id: 'standvirtual-bmw',
    url: 'https://www.standvirtual.com/carros/bmw',
    criteria: 'BMW Touring, diesel',
});

let dir: string;
let store: Store;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scout-heal-'));
    const opened = openStore(join(dir, 'test.db'));
    if (!isOk(opened)) {
        throw new Error(opened.error.message);
    }
    store = opened.value;
});

afterEach(() => {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true });
});

function emptyRuns(count: number): void {
    for (let i = 0; i < count; i += 1) {
        finishRun(store, startRun(store, asTargetId(TARGET.id)), { status: 'empty', listingCount: 0 });
    }
}

describe('shouldHeal', () => {
    it('never heals while extraction is working', () => {
        emptyRuns(10);
        const decision = shouldHeal(store, TARGET, 40);
        expect(decision.kind).toBe('skip');
    });

    it('does not heal on a single empty run — that is unremarkable', () => {
        emptyRuns(1);
        const decision = shouldHeal(store, TARGET, 0);
        expect(decision.kind).toBe('skip');
        if (decision.kind !== 'skip') return;
        expect(decision.reason).toContain('not stale yet');
    });

    it('heals once the streak reaches the threshold', () => {
        emptyRuns(EMPTY_RUNS_BEFORE_HEAL);
        expect(shouldHeal(store, TARGET, 0).kind).toBe('attempt');
    });

    it('resets the streak after a productive run, so an old outage does not trigger later', () => {
        emptyRuns(EMPTY_RUNS_BEFORE_HEAL);
        finishRun(store, startRun(store, asTargetId(TARGET.id)), { status: 'ok', listingCount: 32 });
        emptyRuns(1);
        expect(shouldHeal(store, TARGET, 0).kind).toBe('skip');
    });

    it('honours the cooldown after a successful heal', () => {
        emptyRuns(EMPTY_RUNS_BEFORE_HEAL);
        recordHeal(store, asTargetId(TARGET.id), 'healed', { listingsAfter: 30 });
        const decision = shouldHeal(store, TARGET, 0);
        expect(decision.kind).toBe('skip');
        if (decision.kind !== 'skip') return;
        expect(decision.reason).toContain('healed recently');
    });

    it('honours the cooldown after a FAILED heal too', () => {
        // The important case: a site that is down would otherwise be re-scraped and
        // re-generated on every poll, turning a temporary block into a permanent one.
        emptyRuns(EMPTY_RUNS_BEFORE_HEAL);
        recordHeal(store, asTargetId(TARGET.id), 'failed', { error: 'blocked' });
        expect(shouldHeal(store, TARGET, 0).kind).toBe('skip');
    });

    it('allows another attempt once the cooldown has elapsed', () => {
        emptyRuns(EMPTY_RUNS_BEFORE_HEAL);
        recordHeal(store, asTargetId(TARGET.id), 'no-improvement', {});
        // Backdate the attempt past the cooldown.
        store.db
            .prepare('UPDATE heals SET attempted_at = ?')
            .run(Date.now() - HEAL_COOLDOWN_MS - 1000);
        expect(shouldHeal(store, TARGET, 0).kind).toBe('attempt');
    });

    it('scopes heal history per target', () => {
        emptyRuns(EMPTY_RUNS_BEFORE_HEAL);
        recordHeal(store, asTargetId('other-target'), 'healed', {});
        // Another target's recent heal must not suppress this one.
        expect(shouldHeal(store, TARGET, 0).kind).toBe('attempt');
        expect(lastHealAt(store, asTargetId(TARGET.id))).toBeNull();
    });
});

describe('recordHeal', () => {
    it('stores what moved, so the alert can show it without a diff', () => {
        recordHeal(store, asTargetId(TARGET.id), 'healed', {
            beforeList: '$.props.old[*]',
            afterList: '$..advertSearch.edges[*].node',
            listingsAfter: 32,
        });
        const row = store.db
            .prepare('SELECT outcome, before_list, after_list, listings_after FROM heals')
            .get() as { outcome: string; before_list: string; after_list: string; listings_after: number };
        expect(row.outcome).toBe('healed');
        expect(row.before_list).toBe('$.props.old[*]');
        expect(row.after_list).toContain('advertSearch');
        expect(row.listings_after).toBe(32);
    });
});
