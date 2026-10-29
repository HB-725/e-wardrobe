import type { Avatar, TryonView, UsageEntry } from '@/domain/types';
import { type Db, newId, nowIso, parseJson } from './db';

// ---------- settings ----------

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

// ---------- avatar (single row) ----------

interface AvatarRow {
  front_uri: string | null;
  back_uri: string | null;
  source_uris: string;
  height_cm: number | null;
  weight_kg: number | null;
  build: string | null;
  status: string;
  error: string | null;
  updated_at: string | null;
}

export const EMPTY_AVATAR: Avatar = {
  frontUri: null,
  backUri: null,
  sourceUris: [],
  heightCm: null,
  weightKg: null,
  build: null,
  status: 'none',
  error: null,
  updatedAt: null,
};

export async function getAvatar(db: Db): Promise<Avatar> {
  const r = await db.getFirstAsync<AvatarRow>('SELECT * FROM avatar WHERE id = 1');
  if (!r) return EMPTY_AVATAR;
  return {
    frontUri: r.front_uri,
    backUri: r.back_uri,
    sourceUris: parseJson<string[]>(r.source_uris, []),
    heightCm: r.height_cm,
    weightKg: r.weight_kg,
    build: r.build,
    status: r.status as Avatar['status'],
    error: r.error,
    updatedAt: r.updated_at,
  };
}

export async function saveAvatar(db: Db, patch: Partial<Avatar>): Promise<Avatar> {
  const next = { ...(await getAvatar(db)), ...patch, updatedAt: nowIso() };
  await db.runAsync(
    `INSERT INTO avatar (id, front_uri, back_uri, source_uris, height_cm, weight_kg, build, status, error, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET front_uri = excluded.front_uri, back_uri = excluded.back_uri,
       source_uris = excluded.source_uris, height_cm = excluded.height_cm, weight_kg = excluded.weight_kg,
       build = excluded.build, status = excluded.status, error = excluded.error, updated_at = excluded.updated_at`,
    [
      next.frontUri,
      next.backUri,
      JSON.stringify(next.sourceUris),
      next.heightCm,
      next.weightKg,
      next.build,
      next.status,
      next.error,
      next.updatedAt,
    ],
  );
  return next;
}

/** Try-on images belong to one avatar; regenerating the avatar invalidates them via this version. */
export function avatarVersion(a: Avatar): string {
  return a.frontUri ?? 'none';
}

// ---------- try-on cache ----------

export async function getTryon(db: Db, key: string, view: TryonView, version: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ uri: string }>(
    'SELECT uri FROM tryon_cache WHERE key = ? AND view = ? AND avatar_version = ?',
    [key, view, version],
  );
  return row?.uri ?? null;
}

export async function putTryon(db: Db, key: string, view: TryonView, version: string, uri: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO tryon_cache (key, view, uri, avatar_version, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key, view) DO UPDATE SET uri = excluded.uri, avatar_version = excluded.avatar_version, created_at = excluded.created_at`,
    [key, view, uri, version, nowIso()],
  );
}

export async function listTryonUris(db: Db): Promise<string[]> {
  return (await db.getAllAsync<{ uri: string }>('SELECT uri FROM tryon_cache')).map((r) => r.uri);
}

// ---------- AI usage / spend ----------

export async function addUsage(db: Db, entry: Omit<UsageEntry, 'id' | 'createdAt'>): Promise<void> {
  await db.runAsync('INSERT INTO usage (id, kind, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)', [
    newId(),
    entry.kind,
    entry.model,
    entry.costUsd,
    nowIso(),
  ]);
}

export interface SpendSummary {
  totalUsd: number;
  byKind: Record<string, { count: number; usd: number }>;
}

/** Spend within the calendar month containing `ref` (ISO timestamps compare lexically). */
export async function monthSpend(db: Db, ref: Date = new Date()): Promise<SpendSummary> {
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1).toISOString();
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 1).toISOString();
  const rows = await db.getAllAsync<{ kind: string; n: number; usd: number }>(
    'SELECT kind, COUNT(*) AS n, SUM(cost_usd) AS usd FROM usage WHERE created_at >= ? AND created_at < ? GROUP BY kind',
    [start, end],
  );
  const byKind: SpendSummary['byKind'] = {};
  let totalUsd = 0;
  for (const r of rows) {
    byKind[r.kind] = { count: r.n, usd: r.usd };
    totalUsd += r.usd;
  }
  return { totalUsd, byKind };
}

// ---------- wipe ----------

export async function wipeAll(db: Db): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (const t of ['wear_log_items', 'wear_logs', 'outfit_items', 'outfits', 'tryon_cache', 'jobs', 'usage', 'avatar', 'items', 'settings']) {
      await db.execAsync(`DELETE FROM ${t}`);
    }
  });
}
