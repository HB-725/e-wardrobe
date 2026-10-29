import type { Database } from 'sql.js';
import type { Db, SqlParam } from './db';

/** Db backed by sql.js; used by tests (Node) and the web preview build. */
export class SqlJsDb implements Db {
  private depth = 0;
  constructor(private readonly db: Database) {}

  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async runAsync(sql: string, params: SqlParam[] = []): Promise<{ changes: number }> {
    this.db.run(sql, params);
    return { changes: this.db.getRowsModified() };
  }

  async getAllAsync<T>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    stmt.free();
    return rows;
  }

  async getFirstAsync<T>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    return (await this.getAllAsync<T>(sql, params))[0] ?? null;
  }

  async withTransactionAsync(task: (tx: Db) => Promise<void>): Promise<void> {
    // Mirror expo-sqlite: nested calls join the outer transaction.
    if (this.depth > 0) {
      await task(this);
      return;
    }
    this.depth += 1;
    this.db.exec('BEGIN');
    try {
      await task(this);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth -= 1;
    }
  }
}
