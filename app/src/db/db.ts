export type SqlParam = string | number | null;

/** The subset of expo-sqlite's SQLiteDatabase the app relies on; tests provide an in-memory implementation. */
export interface Db {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  getAllAsync<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: SqlParam[]): Promise<T | null>;
  /**
   * Runs `task` in a transaction. Statements inside must go through `tx`; the shared connection queues everything
   * else until the transaction ends, so another flow's statement never lands inside it. Do not nest.
   */
  withTransactionAsync(task: (tx: Db) => Promise<void>): Promise<void>;
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
