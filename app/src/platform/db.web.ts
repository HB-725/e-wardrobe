import type { Db } from '@/db/db';
import { migrate } from '@/db/schema';
import { SqlJsDb } from '@/db/sqljsDb';

export const DB_NAME = 'wardrobe.db';

/** Web preview: in-memory sql.js (asm.js build, no wasm file to serve). Data resets on reload. */
export async function openAppDb(): Promise<Db> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const initSqlJs = require('sql.js/dist/sql-asm.js') as typeof import('sql.js').default;
  const SQL = await initSqlJs();
  const db = new SqlJsDb(new SQL.Database());
  await migrate(db);
  const demo = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('demo') : null;
  if (demo) {
    const { seedDemo } = await import('@/dev/seedDemo');
    await seedDemo(db, demo);
  }
  return db;
}
