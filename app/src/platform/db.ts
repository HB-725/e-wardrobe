import { openDatabaseAsync } from 'expo-sqlite';
import type { Db } from '@/db/db';
import { migrate } from '@/db/schema';

export const DB_NAME = 'wardrobe.db';

export async function openAppDb(): Promise<Db> {
  const db = await openDatabaseAsync(DB_NAME);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  const wrapped = db as unknown as Db;
  await migrate(wrapped);
  return wrapped;
}
