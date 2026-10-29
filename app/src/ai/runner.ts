import type { Db } from '@/db/db';
import { claimNextJob, completeJob, failJob, recoverRunningJobs } from '@/db/jobs';
import { getSetting, monthSpend } from '@/db/misc';
import { type AiDeps, errorMessage, isRetryable, markJobFailed, runJob } from './pipeline';

export type RunnerBlock = 'no-key' | 'over-budget' | null;

export const BUDGET_SETTING = 'monthly_cap_usd';
export const DEFAULT_BUDGET_USD = 10;

export async function monthlyBudget(db: Db): Promise<number> {
  const raw = await getSetting(db, BUDGET_SETTING);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_USD;
}

/**
 * Processes queued AI jobs while the app is open. Jobs survive restarts in SQLite;
 * `kick()` is called after enqueueing, after the key changes, and when the app returns to the foreground.
 */
export class JobRunner {
  private active = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  block: RunnerBlock = null;

  constructor(
    private readonly db: Db,
    private readonly getDeps: () => Promise<AiDeps | null>,
    private readonly onChange: () => void,
    private readonly concurrency = 2,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await recoverRunningJobs(this.db);
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  kick(): void {
    if (this.stopped) return;
    while (this.active < this.concurrency) {
      this.active += 1;
      void this.worker()
        .catch(() => this.schedule(15_000))
        .finally(() => {
          this.active -= 1;
        });
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, ms);
  }

  private async setBlock(block: RunnerBlock): Promise<void> {
    if (this.block !== block) {
      this.block = block;
      this.onChange();
    }
  }

  private async worker(): Promise<void> {
    while (!this.stopped) {
      const deps = await this.getDeps();
      if (!deps) {
        await this.setBlock('no-key');
        return;
      }
      const spent = (await monthSpend(this.db)).totalUsd;
      if (spent >= (await monthlyBudget(this.db))) {
        await this.setBlock('over-budget');
        return;
      }
      await this.setBlock(null);
      const job = await claimNextJob(this.db);
      if (!job) {
        // Re-check for jobs whose backoff expires later.
        this.schedule(15_000);
        return;
      }
      this.onChange();
      try {
        await runJob(deps, job);
        await completeJob(this.db, job.id);
      } catch (e) {
        const message = errorMessage(e);
        const status = await failJob(this.db, job, message, { retryable: isRetryable(e) });
        if (status === 'failed') await markJobFailed(this.db, job, message);
      }
      this.onChange();
    }
  }
}
