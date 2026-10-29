import type { Job } from '@/domain/types';
import { claimNextJob, completeJob, deferJob, failJob, nextDueAt, recoverRunningJobs } from '@/db/jobs';
import { AiError, describeAiError } from './client';
import { setAiBlocked } from './config';
import { type AiDeps, markJobFailed, runJob } from './engine';

/** Simple async mutex: expo-sqlite transactions are not exclusive across concurrent awaits, so claims are serialised. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface RunnerOptions {
  /** Parallel AI requests; each catalog job takes ~20 s, so two halves a batch import. */
  concurrency?: number;
  onChange?: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Background queue worker. Jobs survive app restarts (they live in SQLite); `start()` re-queues anything that was
 * running when the app was killed. Work that needs the user (no key, no credit, spend cap) pauses the whole queue
 * until `kick()` is called again, e.g. after the key is saved.
 */
export class JobRunner {
  private readonly claim = new Mutex();
  private active = 0;
  private paused = false;
  private timer: unknown = null;
  private readonly concurrency: number;

  constructor(
    private readonly deps: AiDeps,
    private readonly opts: RunnerOptions = {},
  ) {
    this.concurrency = opts.concurrency ?? 2;
  }

  async start(): Promise<void> {
    await recoverRunningJobs(this.deps.db);
    this.kick();
  }

  /** Start workers if there is capacity; safe to call any time. */
  kick(): void {
    this.paused = false;
    while (this.active < this.concurrency) {
      this.active += 1;
      void this.worker().finally(() => {
        this.active -= 1;
        if (this.active === 0) void this.scheduleWake();
      });
    }
  }

  /** Resolves when all workers are idle (used by tests). */
  async idle(): Promise<void> {
    while (this.active > 0) await new Promise((r) => setTimeout(r, 5));
  }

  stop(): void {
    this.paused = true;
    if (this.timer != null) (this.opts.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }

  private async worker(): Promise<void> {
    const { db } = this.deps;
    while (!this.paused) {
      let job: Job | null;
      try {
        job = await this.claim.run(() => claimNextJob(db, this.deps.now?.() ?? new Date()));
      } catch (e) {
        console.warn('claim failed', e);
        return;
      }
      if (!job) return;
      await this.handle(job);
    }
  }

  private async handle(job: Job): Promise<void> {
    const { db } = this.deps;
    try {
      await runJob(this.deps, job);
      await completeJob(db, job.id);
      // Another worker may have just paused the queue (e.g. spend cap); keep its message.
      if (!this.paused) await setAiBlocked(db, null);
    } catch (e) {
      const message = describeAiError(e);
      if (e instanceof AiError && e.needsUser) {
        await deferJob(db, job, message);
        await setAiBlocked(db, e.kind);
        this.paused = true;
      } else {
        const retryable = e instanceof AiError ? e.retryable : false;
        const status = await failJob(db, job, message, { retryable, now: this.deps.now?.() });
        if (status === 'failed') await markJobFailed(this.deps, job, message);
      }
    } finally {
      this.opts.onChange?.();
    }
  }

  private async scheduleWake(): Promise<void> {
    if (this.paused) return;
    const due = await nextDueAt(this.deps.db);
    if (!due) return;
    const ms = Math.max(1000, new Date(due).getTime() - (this.deps.now?.() ?? new Date()).getTime());
    if (this.timer != null) (this.opts.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = (this.opts.setTimer ?? setTimeout)(() => {
      this.timer = null;
      this.kick();
    }, ms);
  }
}
