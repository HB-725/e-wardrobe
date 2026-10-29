import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type { Db, SqlParam } from '@/db/db';
import { migrate } from '@/db/schema';

export const DB_NAME = 'wardrobe.db';

/** Statements on the raw connection, used inside a transaction (already holding the queue). */
class DirectDb implements Db {
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
  withTransactionAsync(): Promise<void> {
    return Promise.reject(new Error('transactions must not nest'));
  }
}

/**
 * expo-sqlite's withTransactionAsync is a plain BEGIN/COMMIT on the shared connection: a statement from another
 * flow (the background AI queue, a user action) issued meanwhile would silently become part of that transaction
 * and roll back with it. So every statement goes through one queue; a transaction holds the queue for its whole
 * duration and its body uses the direct `tx` handle.
 */
class SerialDb implements Db {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly direct: DirectDb;
  constructor(private readonly db: SQLiteDatabase) {
    this.direct = new DirectDb(db);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  execAsync(sql: string) {
    return this.enqueue(() => this.direct.execAsync(sql));
  }
  runAsync(sql: string, params: SqlParam[] = []) {
    return this.enqueue(() => this.direct.runAsync(sql, params));
  }
  getAllAsync<T>(sql: string, params: SqlParam[] = []) {
    return this.enqueue(() => this.direct.getAllAsync<T>(sql, params));
  }
  getFirstAsync<T>(sql: string, params: SqlParam[] = []) {
    return this.enqueue(() => this.direct.getFirstAsync<T>(sql, params));
  }
  withTransactionAsync(task: (tx: Db) => Promise<void>): Promise<void> {
    return this.enqueue(() => this.db.withTransactionAsync(() => task(this.direct)));
  }
}

export async function openAppDb(): Promise<Db> {
  const raw = await openDatabaseAsync(DB_NAME);
  await raw.execAsync('PRAGMA journal_mode = WAL;');
  const db = new SerialDb(raw);
  await migrate(db);
  return db;
}
