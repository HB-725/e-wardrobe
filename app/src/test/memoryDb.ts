import initSqlJs from 'sql.js';
import type { Db } from '@/db/db';
import { migrate } from '@/db/schema';
import { SqlJsDb } from '@/db/sqljsDb';

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

export async function createTestDb(): Promise<Db> {
  if (!SQL) SQL = await initSqlJs();
  const db = new SqlJsDb(new SQL.Database());
  await migrate(db);
  return db;
}
