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
  /** Queue a fresh run even if one is running now (its inputs changed, e.g. a new photo). */
  opts: { evenIfRunning?: boolean } = {},
): Promise<Job> {
  const existing = await db.getFirstAsync<JobRow>(
    `SELECT * FROM jobs WHERE type = ? AND ref_id = ? AND status IN (${opts.evenIfRunning ? "'queued'" : "'queued', 'running'"})`,
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
  await db.withTransactionAsync(async (tx) => {
    const row = await tx.getFirstAsync<JobRow>(
      "SELECT * FROM jobs WHERE status = 'queued' AND next_run_at <= ? ORDER BY created_at LIMIT 1",
      [now.toISOString()],
    );
    if (!row) return;
    await tx.runAsync("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?", [
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

/** Recorded as last_error of jobs waiting for a connection (so only those are woken on returning to the app). */
export const OFFLINE_REASON = '网络连接失败，联网后会自动继续';
/** About an hour of tries while the app is open; after that (e.g. OpenAI blocked in the user's region) the job fails as usual. */
export const MAX_NETWORK_WAITS = 60;

/**
 * Offline: try again in a minute (or on returning to the app) without using up an attempt. Returns false once the
 * job has waited MAX_NETWORK_WAITS times; the caller then fails it the normal way.
 */
export async function waitForNetwork(db: Db, job: Job, now = new Date()): Promise<boolean> {
  const waits = Number(job.payload.netWaits ?? 0) + 1;
  if (waits > MAX_NETWORK_WAITS) return false;
  await db.runAsync(
    "UPDATE jobs SET status = 'queued', attempts = MAX(0, attempts - 1), payload = ?, last_error = ?, next_run_at = ?, updated_at = ? WHERE id = ?",
    [JSON.stringify({ ...job.payload, netWaits: waits }), OFFLINE_REASON, new Date(now.getTime() + 60_000).toISOString(), nowIso(), job.id],
  );
  return true;
}

/** Jobs waiting for a connection become due now (the app came back to the foreground, possibly online again). Other backoffs are kept. */
export async function wakeWaitingJobs(db: Db, now = new Date()): Promise<void> {
  await db.runAsync("UPDATE jobs SET next_run_at = ? WHERE status = 'queued' AND last_error = ? AND next_run_at > ?", [now.toISOString(), OFFLINE_REASON, now.toISOString()]);
}

/**
 * Jobs interrupted by an app kill are re-queued on next launch, unless they already used all attempts (a job that
 * crashes the app every time must not be paid for again and again). Returns the jobs given up on.
 */
export async function recoverRunningJobs(db: Db): Promise<Job[]> {
  const exhausted = (await db.getAllAsync<JobRow>("SELECT * FROM jobs WHERE status = 'running' AND attempts >= ?", [MAX_ATTEMPTS])).map(fromRow);
  await db.runAsync("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE status = 'running' AND attempts >= ?", [
    '多次中断，已停止重试',
    nowIso(),
    MAX_ATTEMPTS,
  ]);
  await db.runAsync("UPDATE jobs SET status = 'queued', updated_at = ? WHERE status = 'running'", [nowIso()]);
  return exhausted;
}

/** A later job for the same subject is waiting or running (it supersedes this one). */
export async function hasNewerJob(db: Db, job: Pick<Job, 'id' | 'type' | 'refId'>): Promise<boolean> {
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE type = ? AND ref_id = ? AND id != ? AND status IN ('queued', 'running') AND rowid > (SELECT rowid FROM jobs WHERE id = ?)",
    [job.type, job.refId, job.id, job.id],
  );
  return (row?.n ?? 0) > 0;
}

/** Remember paid-for intermediate results (generated files) so a retry continues instead of paying again. */
export async function updateJobPayload(db: Db, id: string, payload: Record<string, unknown>): Promise<void> {
  await db.runAsync('UPDATE jobs SET payload = ?, updated_at = ? WHERE id = ?', [JSON.stringify(payload), nowIso(), id]);
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

/** When the earliest waiting job becomes due, so the runner can sleep until then. */
export async function nextDueAt(db: Db): Promise<string | null> {
  const row = await db.getFirstAsync<{ t: string | null }>("SELECT MIN(next_run_at) AS t FROM jobs WHERE status = 'queued'");
  return row?.t ?? null;
}

export async function countActiveJobs(db: Db): Promise<Record<JobType, number>> {
  const rows = await db.getAllAsync<{ type: string; n: number }>(
    "SELECT type, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY type",
  );
  const out: Record<JobType, number> = { catalog: 0, autofill: 0, avatar: 0, tryon: 0, mirror: 0 };
  for (const r of rows) out[r.type as JobType] = r.n;
  return out;
}
