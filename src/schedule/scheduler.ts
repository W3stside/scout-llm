/**
 * Per-target cron scheduling.
 *
 * Two behaviours matter more than the cron parsing itself:
 *
 * Jitter. Targets configured `*​/15 * * * *` would otherwise all fire on the same second,
 * producing a burst of simultaneous requests — the most obviously non-human traffic
 * pattern there is, and the fastest route to an IP ban. Each firing waits a random slice
 * of a minute first.
 *
 * Serialization. Polls never overlap, even across targets. The model is a single GPU-bound
 * resource; two concurrent judge calls do not go twice as fast, they queue inside Ollama
 * while holding two browsers open. A target already running is skipped rather than
 * queued — on a 15-minute cadence, the next tick is a better time than immediately after.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { Config } from '../core/config.ts';
import { isErr } from '../core/result.ts';
import type { Target } from '../core/types.ts';
import type { PollReport } from '../pipeline/poll.ts';
import { pollTarget } from '../pipeline/poll.ts';
import type { OllamaOptions } from '../llm/ollama.ts';
import type { Store } from '../store/db.ts';

export type SchedulerDeps = {
    readonly config: Config;
    readonly ollama: OllamaOptions;
    readonly store: Store;
    readonly onReport: (report: PollReport) => Promise<void>;
    readonly onError: (targetId: string, message: string) => Promise<void>;
};

export type Scheduler = {
    readonly tasks: readonly ScheduledTask[];
    readonly runNow: (target: Target) => Promise<PollReport | null>;
    readonly stop: () => void;
};

/** Guards against overlapping polls. Module-scoped because the constraint is the GPU, which is global. */
let _pollInFlight = false;

const MAX_JITTER_MS = 60_000;

function _jitter(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.floor(Math.random() * MAX_JITTER_MS));
    });
}

export function startScheduler(targets: readonly Target[], deps: SchedulerDeps): Scheduler {
    const runNow = async (target: Target): Promise<PollReport | null> => {
        if (_pollInFlight) {
            return null;
        }
        _pollInFlight = true;
        try {
            const result = await pollTarget(target, {
                config: deps.config,
                ollama: deps.ollama,
                store: deps.store,
            });
            if (isErr(result)) {
                await deps.onError(target.id, result.error.message);
                return null;
            }
            await deps.onReport(result.value);
            return result.value;
        } catch (thrown: unknown) {
            // A scheduled callback that throws would otherwise take down the process and
            // stop every other target with it.
            await deps.onError(target.id, thrown instanceof Error ? thrown.message : String(thrown));
            return null;
        } finally {
            _pollInFlight = false;
        }
    };

    const tasks: ScheduledTask[] = [];
    for (const target of targets) {
        if (!target.enabled) {
            continue;
        }
        if (!cron.validate(target.schedule)) {
            void deps.onError(target.id, `invalid cron expression: ${target.schedule}`);
            continue;
        }

        const task = cron.schedule(target.schedule, async () => {
            await _jitter();
            await runNow(target);
        });
        tasks.push(task);
    }

    return {
        tasks,
        runNow,
        stop: () => {
            for (const task of tasks) {
                void task.stop();
            }
        },
    };
}
