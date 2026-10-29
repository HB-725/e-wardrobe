import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type { Db, SqlParam } from '@/db/db';
import { migrate } from '@/db/schema';

export const DB_NAME = 'wardrobe.db';

/**
 * expo-sqlite's withTransactionAsync is a plain BEGIN/COMMIT on the shared connection, so two overlapping
 * transactions (the background AI queue and a user action) would collide. Transactions are queued one at a time.
 * They must not nest.
 */
class SerialDb implements Db {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly db: SQLiteDatabase) {}

  execAsync(sql: string) {
    return this.db.execAsync(sql);
  }
  async runAsync(sql: string, params: SqlParam[] = []) {
    const r = await this.db.runAsync(sql, params);
    return { changes: r.changes };
  }
  getAllAsync<T>(sql: string, params: SqlParam[] = []) {
    return this.db.getAllAsync<T>(sql, params);
  }
  getFirstAsync<T>(sql: string, params: SqlParam[] = []) {
    return this.db.getFirstAsync<T>(sql, params);
  }
  withTransactionAsync(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(() => this.db.withTransactionAsync(task));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export async function openAppDb(): Promise<Db> {
  const raw = await openDatabaseAsync(DB_NAME);
  await raw.execAsync('PRAGMA journal_mode = WAL;');
  const db = new SerialDb(raw);
  await migrate(db);
  return db;
}
