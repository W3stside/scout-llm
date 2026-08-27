/**
 * Seen-set behaviour. The second poll of an unchanged page must produce zero new
 * listings — that property is the entire reason the store exists.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, closeStore, type Store } from './db.ts';
import { consecutiveEmptyRuns, finishRun, recordSeen, selectNew, startRun, addMute, isMuted, statsFor } from './listings.ts';
import { asTargetId, type IdentifiedListing, type TargetId, type Fingerprint, type Verdict } from '../core/types.ts';
import { canonicalizeUrl, fingerprintOf } from '../core/url.ts';
import { isOk } from '../core/result.ts';

const TARGET: TargetId = asTargetId('standvirtual-bmw');

let dir: string;
let store: Store;

function listing(url: string, title: string): IdentifiedListing {
    const canonical = canonicalizeUrl(url);
    if (canonical === null) {
        throw new Error(`test fixture produced an uncanonicalizable url: ${url}`);
    }
    return {
        url: canonical,
        title,
        price: 14500,
        currency: 'EUR',
        year: 2018,
        km: 142000,
        location: 'Porto',
        image: null,
        extra: {},
        fingerprint: fingerprintOf(TARGET, canonical),
        targetId: TARGET,
    };
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scout-test-'));
    const opened = openStore(join(dir, 'test.db'));
    if (!isOk(opened)) {
        throw new Error(`store failed to open: ${opened.error.message}`);
    }
    store = opened.value;
});

afterEach(() => {
    closeStore(store);
    rmSync(dir, { recursive: true, force: true });
});

describe('selectNew', () => {
    it('treats everything as new on the first poll', () => {
        const batch = [listing('https://sv.com/a-ID1', 'A'), listing('https://sv.com/b-ID2', 'B')];
        expect(selectNew(store, TARGET, batch)).toHaveLength(2);
    });

    it('returns ZERO new on an unchanged second poll — the anti-alert-storm property', () => {
        const batch = [listing('https://sv.com/a-ID1', 'A'), listing('https://sv.com/b-ID2', 'B')];
        const first = selectNew(store, TARGET, batch);
        recordSeen(store, first, new Map());

        expect(selectNew(store, TARGET, batch)).toHaveLength(0);
    });

    it('surfaces only the genuinely added listing on a later poll', () => {
        const initial = [listing('https://sv.com/a-ID1', 'A')];
        recordSeen(store, selectNew(store, TARGET, initial), new Map());

        const later = [listing('https://sv.com/a-ID1', 'A'), listing('https://sv.com/c-ID3', 'C')];
        const fresh = selectNew(store, TARGET, later);
        expect(fresh).toHaveLength(1);
        expect(fresh[0]?.title).toBe('C');
    });

    it('does not re-alert when the site rewrites a title but keeps the URL', () => {
        // Real failure mode: the same ad rendered as "BMW 320d Touring" then "BMW 320d".
        // Identity is the URL, so this must stay silent.
        recordSeen(store, selectNew(store, TARGET, [listing('https://sv.com/a-ID1', 'BMW 320d Touring')]), new Map());
        expect(selectNew(store, TARGET, [listing('https://sv.com/a-ID1', 'BMW 320d')])).toHaveLength(0);
    });

    it('does not re-alert when only tracking params change between polls', () => {
        recordSeen(store, selectNew(store, TARGET, [listing('https://sv.com/a-ID1?utm_source=a', 'A')]), new Map());
        expect(selectNew(store, TARGET, [listing('https://sv.com/a-ID1?utm_source=b&position=7', 'A')])).toHaveLength(0);
    });

    it('handles a batch larger than the SQLite variable limit', () => {
        const big = Array.from({ length: 1200 }, (_v, i) => listing(`https://sv.com/x-ID${i}`, `X${i}`));
        recordSeen(store, selectNew(store, TARGET, big), new Map());
        expect(selectNew(store, TARGET, big)).toHaveLength(0);
    });

    it('scopes the seen-set per target', () => {
        const other = asTargetId('olx-bmw');
        recordSeen(store, selectNew(store, TARGET, [listing('https://sv.com/a-ID1', 'A')]), new Map());
        // Same URL, different saved search -> a different question, so it alerts.
        const l = listing('https://sv.com/a-ID1', 'A');
        const forOther: IdentifiedListing = { ...l, targetId: other, fingerprint: fingerprintOf(other, l.url) };
        expect(selectNew(store, other, [forOther])).toHaveLength(1);
    });
});

describe('recordSeen', () => {
    it('persists the verdict alongside the listing', () => {
        const l = listing('https://sv.com/a-ID1', 'A');
        const verdict: Verdict = { score: 0.91, reason: 'matches', priceAssessment: 'bargain', photoNotes: null };
        const verdicts = new Map<Fingerprint, Verdict>([[l.fingerprint, verdict]]);
        recordSeen(store, [l], verdicts);

        const row = store.db.prepare('SELECT score, verdict_json FROM listings WHERE fingerprint = ?').get(l.fingerprint) as
            { score: number; verdict_json: string };
        expect(row.score).toBeCloseTo(0.91);
        expect(JSON.parse(row.verdict_json).priceAssessment).toBe('bargain');
    });
});

describe('mutes', () => {
    it('a global mute applies to every target', () => {
        addMute(store, 'seller', 'StandDodgy', null);
        expect(isMuted(store, 'seller', 'StandDodgy', TARGET)).toBe(true);
        expect(isMuted(store, 'seller', 'StandDodgy', asTargetId('other'))).toBe(true);
    });

    it('a target-scoped mute does not leak to other targets', () => {
        addMute(store, 'seller', 'StandX', TARGET);
        expect(isMuted(store, 'seller', 'StandX', TARGET)).toBe(true);
        expect(isMuted(store, 'seller', 'StandX', asTargetId('other'))).toBe(false);
    });
});

describe('consecutiveEmptyRuns — the healing trigger', () => {
    it('counts back only to the last productive run', () => {
        finishRun(store, startRun(store, TARGET), { status: 'ok', listingCount: 40 });
        finishRun(store, startRun(store, TARGET), { status: 'empty', listingCount: 0 });
        finishRun(store, startRun(store, TARGET), { status: 'empty', listingCount: 0 });
        expect(consecutiveEmptyRuns(store, TARGET)).toBe(2);
    });

    it('resets once extraction works again', () => {
        finishRun(store, startRun(store, TARGET), { status: 'empty', listingCount: 0 });
        finishRun(store, startRun(store, TARGET), { status: 'ok', listingCount: 12 });
        expect(consecutiveEmptyRuns(store, TARGET)).toBe(0);
    });
});

describe('statsFor', () => {
    it('reports totals and the last run for /status', () => {
        recordSeen(store, selectNew(store, TARGET, [listing('https://sv.com/a-ID1', 'A')]), new Map());
        finishRun(store, startRun(store, TARGET), { status: 'ok', listingCount: 1 });
        const s = statsFor(store, TARGET);
        expect(s.total).toBe(1);
        expect(s.lastStatus).toBe('ok');
        expect(s.lastRunAt).not.toBeNull();
    });
});
