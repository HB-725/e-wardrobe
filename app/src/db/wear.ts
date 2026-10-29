import type { WearLog, WearSource } from '@/domain/types';
import { type Db, newId, nowIso } from './db';

interface LogRow {
  id: string;
  date: string;
  outfit_id: string | null;
  source: string;
  photo_uri: string | null;
  created_at: string;
}

async function attachItems(db: Db, rows: LogRow[]): Promise<WearLog[]> {
  if (rows.length === 0) return [];
  const items = await db.getAllAsync<{ log_id: string; item_id: string }>(
    `SELECT log_id, item_id FROM wear_log_items WHERE log_id IN (${rows.map(() => '?').join(', ')})`,
    rows.map((r) => r.id),
  );
  const byLog = new Map<string, string[]>();
  for (const it of items) byLog.set(it.log_id, [...(byLog.get(it.log_id) ?? []), it.item_id]);
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    outfitId: r.outfit_id,
    source: r.source as WearSource,
    photoUri: r.photo_uri,
    itemIds: byLog.get(r.id) ?? [],
    createdAt: r.created_at,
  }));
}

/** One log per day: logging again on the same date replaces that day's record. */
export async function logWear(
  db: Db,
  input: { date: string; itemIds: string[]; outfitId?: string | null; source: WearSource; photoUri?: string | null },
): Promise<WearLog> {
  if (input.itemIds.length === 0) throw new Error('至少选择一件单品');
  const id = newId();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM wear_logs WHERE date = ?', [input.date]);
    await db.runAsync(
      'INSERT INTO wear_logs (id, date, outfit_id, source, photo_uri, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.date, input.outfitId ?? null, input.source, input.photoUri ?? null, nowIso()],
    );
    for (const itemId of new Set(input.itemIds)) {
      await db.runAsync('INSERT INTO wear_log_items (log_id, item_id) VALUES (?, ?)', [id, itemId]);
    }
  });
  return (await getLogByDate(db, input.date))!;
}

export async function getLogByDate(db: Db, date: string): Promise<WearLog | null> {
  const rows = await db.getAllAsync<LogRow>('SELECT * FROM wear_logs WHERE date = ?', [date]);
  return (await attachItems(db, rows))[0] ?? null;
}

export async function deleteLogByDate(db: Db, date: string): Promise<void> {
  await db.runAsync('DELETE FROM wear_logs WHERE date = ?', [date]);
}

export async function listLogs(db: Db, fromDate?: string, toDate?: string): Promise<WearLog[]> {
  const rows = await db.getAllAsync<LogRow>(
    'SELECT * FROM wear_logs WHERE date >= ? AND date <= ? ORDER BY date DESC',
    [fromDate ?? '0000-00-00', toDate ?? '9999-99-99'],
  );
  return attachItems(db, rows);
}
