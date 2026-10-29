import type { Job, JobStatus, JobType } from '@/domain/types';
import { type Db, newId, nowIso, parseJson } from './db';

interface JobRow {
  id: string;
  type: string;
  ref_id: string;
  payload: string;
  status: string;
  attempts: number;
  last_error: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

export const MAX_ATTEMPTS = 3;

function fromRow(r: JobRow): Job {
  return {
    id: r.id,
    type: r.type as JobType,
    refId: r.ref_id,
    payload: parseJson<Record<string, unknown>>(r.payload, {}),
    status: r.status as JobStatus,
    attempts: r.attempts,
    lastError: r.last_error,
    nextRunAt: r.next_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Enqueue unless an identical job (same type + ref) is already waiting or running. */
export async function enqueueJob(
  db: Db,
  type: JobType,
  refId: string,
  payload: Record<string, unknown> = {},
): Promise<Job> {
  const existing = await db.getFirstAsync<JobRow>(
    "SELECT * FROM jobs WHERE type = ? AND ref_id = ? AND status IN ('queued', 'running')",
    [type, refId],
  );
  if (existing) return fromRow(existing);
  const id = newId();
  const now = nowIso();
  await db.runAsync(
    'INSERT INTO jobs (id, type, ref_id, payload, status, attempts, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)',
    [id, type, refId, JSON.stringify(payload), 'queued', now, now, now],
  );
  return fromRow((await db.getFirstAsync<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]))!);
}

/** Atomically claims the next due job, or returns null. */
export async function claimNextJob(db: Db, now: Date = new Date()): Promise<Job | null> {
  let claimed: Job | null = null;
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<JobRow>(
      "SELECT * FROM jobs WHERE status = 'queued' AND next_run_at <= ? ORDER BY created_at LIMIT 1",
      [now.toISOString()],
    );
    if (!row) return;
    await db.runAsync("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", [
      nowIso(),
      row.id,
    ]);
    claimed = fromRow({ ...row, status: 'running', attempts: row.attempts + 1 });
  });
  return claimed;
}

export async function completeJob(db: Db, id: string): Promise<void> {
  await db.runAsync("UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?", [nowIso(), id]);
}

/** Exponential backoff: 15s, 60s, 240s ... until MAX_ATTEMPTS, then the job is failed for good. */
export function backoffMs(attempts: number): number {
  return 15_000 * Math.pow(4, Math.max(0, attempts - 1));
}

export async function failJob(
  db: Db,
  job: Job,
  error: string,
  opts: { retryable: boolean; now?: Date },
): Promise<JobStatus> {
  const now = opts.now ?? new Date();
  const giveUp = !opts.retryable || job.attempts >= MAX_ATTEMPTS;
  const status: JobStatus = giveUp ? 'failed' : 'queued';
  const next = new Date(now.getTime() + backoffMs(job.attempts)).toISOString();
  await db.runAsync('UPDATE jobs SET status = ?, last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?', [
    status,
    error,
    next,
    nowIso(),
    job.id,
  ]);
  return status;
}

/** Puts a job that will not succeed without user action (e.g. missing API key) back to waiting without burning an attempt. */
export async function deferJob(db: Db, job: Job, reason: string): Promise<void> {
  await db.runAsync(
    "UPDATE jobs SET status = 'queued', attempts = MAX(0, attempts - 1), last_error = ?, updated_at = ? WHERE id = ?",
    [reason, nowIso(), job.id],
  );
}

/** Jobs interrupted by an app kill are re-queued on next launch. */
export async function recoverRunningJobs(db: Db): Promise<number> {
  const res = await db.runAsync("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'", [nowIso()]);
  return res.changes;
}

export async function retryJob(db: Db, id: string): Promise<void> {
  await db.runAsync(
    "UPDATE jobs SET status = 'queued', attempts = 0, next_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
    [nowIso(), nowIso(), id],
  );
}

export async function listJobs(db: Db, statuses: JobStatus[]): Promise<Job[]> {
  const rows = await db.getAllAsync<JobRow>(
    `SELECT * FROM jobs WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at`,
    statuses,
  );
  return rows.map(fromRow);
}

export async function latestJobFor(db: Db, type: JobType, refId: string): Promise<Job | null> {
  const row = await db.getFirstAsync<JobRow>(
    'SELECT * FROM jobs WHERE type = ? AND ref_id = ? ORDER BY created_at DESC LIMIT 1',
    [type, refId],
  );
  return row ? fromRow(row) : null;
}

export async function deleteJobsFor(db: Db, refId: string): Promise<void> {
  await db.runAsync("DELETE FROM jobs WHERE ref_id = ? AND status != 'running'", [refId]);
}
