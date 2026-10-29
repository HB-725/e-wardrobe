/**
 * Full backup / restore: every table plus every image, so a new phone gets the wardrobe back exactly.
 * The backup is a folder with `backup.json` and an `images/` set of files; storage is abstracted so the
 * logic is testable and the Android side can write into a user-picked folder (Storage Access Framework).
 */
import type { ImageFolder, ImageStore } from '@/ai/imageStore';
import type { Db, SqlParam } from '@/db/db';
import { parseJson } from '@/db/db';
import { SCHEMA_VERSION } from '@/db/schema';

export const BACKUP_FORMAT = 'e-wardrobe-backup';

/** Where the backup's own files live. */
export interface BackupStorage {
  writeText(name: string, text: string): Promise<void>;
  readText(name: string): Promise<string>;
  /** Copy an app image into the backup under `name`. */
  putImage(name: string, sourceUri: string): Promise<void>;
  /** Copy `name` from the backup into app storage; returns the new uri. */
  getImage(name: string, folder: ImageFolder): Promise<string>;
}

type Row = Record<string, SqlParam>;

/** Tables in insert order (parents first). Jobs are not backed up: unfinished work is re-run on demand. */
const TABLES = ['items', 'outfits', 'outfit_items', 'wear_logs', 'wear_log_items', 'avatar', 'tryon_cache', 'usage', 'settings'] as const;
type Table = (typeof TABLES)[number];

/** Columns holding one image uri, and which app folder the image belongs in. */
const URI_COLUMNS: Partial<Record<Table, Record<string, ImageFolder>>> = {
  items: { original_uri: 'original', catalog_uri: 'catalog', tag_uri: 'tag' },
  wear_logs: { photo_uri: 'mirror' },
  avatar: { front_uri: 'avatar', back_uri: 'avatar' },
  tryon_cache: { uri: 'tryon', avatar_version: 'avatar' },
};
/** Columns holding a JSON array of image uris. */
const URI_LIST_COLUMNS: Partial<Record<Table, Record<string, ImageFolder>>> = {
  items: { candidates: 'catalog' },
  avatar: { source_uris: 'body' },
};
/** Settings that describe this phone (its key, its queue) rather than the user's data; never backed up or replaced. */
const DEVICE_SETTINGS = ['ai.blocked', 'ai.keyLast4'];

interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schema: number;
  createdAt: string;
  tables: Record<Table, Row[]>;
  /** backup image name -> app folder */
  images: Record<string, ImageFolder>;
}

const isImageUri = (v: SqlParam): v is string => typeof v === 'string' && v.length > 0 && v !== 'none';

function imageName(uri: string, i: number): string {
  const ext = /\.(webp|png)$/i.exec(uri)?.[1]?.toLowerCase() ?? 'jpg';
  return `images/${String(i).padStart(5, '0')}.${ext}`;
}

export async function createBackup(db: Db, storage: BackupStorage, onProgress?: (done: number, total: number) => void): Promise<{ items: number; images: number }> {
  const tables = {} as Record<Table, Row[]>;
  for (const t of TABLES) tables[t] = await db.getAllAsync<Row>(`SELECT * FROM ${t}`);
  tables.settings = tables.settings.filter((r) => !DEVICE_SETTINGS.includes(String(r.key)));
  // Unfinished garments come back as "failed" so the user can retry or keep the photo.
  tables.items = tables.items.map((r) => (r.status === 'processing' ? { ...r, status: 'failed', error: '从备份恢复，请重新生成' } : r));

  const names = new Map<string, string>();
  const folders: Record<string, ImageFolder> = {};
  const nameFor = (uri: string, folder: ImageFolder) => {
    let n = names.get(uri);
    if (!n) {
      n = imageName(uri, names.size);
      names.set(uri, n);
      folders[n] = folder;
    }
    return n;
  };
  for (const t of TABLES) {
    const single = URI_COLUMNS[t] ?? {};
    const lists = URI_LIST_COLUMNS[t] ?? {};
    tables[t] = tables[t].map((r) => {
      const out: Row = { ...r };
      for (const [col, folder] of Object.entries(single)) if (isImageUri(r[col])) out[col] = nameFor(r[col] as string, folder);
      for (const [col, folder] of Object.entries(lists)) {
        out[col] = JSON.stringify(parseJson<string[]>(r[col] as string, []).filter(isImageUri).map((u) => nameFor(u, folder)));
      }
      return out;
    });
  }

  let done = 0;
  const total = names.size;
  let copied = 0;
  for (const [uri, name] of names) {
    try {
      await storage.putImage(name, uri);
      copied += 1;
    } catch {
      // A file that went missing is skipped; its row is restored without the picture.
      delete folders[name];
    }
    onProgress?.(++done, total);
  }
  const file: BackupFile = { format: BACKUP_FORMAT, schema: SCHEMA_VERSION, createdAt: new Date().toISOString(), tables, images: folders };
  await storage.writeText('backup.json', JSON.stringify(file));
  return { items: tables.items.length, images: copied };
}

export class BackupError extends Error {}

export async function readBackupInfo(storage: BackupStorage): Promise<{ createdAt: string; items: number; outfits: number; images: number }> {
  const f = await load(storage);
  return { createdAt: f.createdAt, items: f.tables.items.length, outfits: f.tables.outfits.length, images: Object.keys(f.images).length };
}

async function load(storage: BackupStorage): Promise<BackupFile> {
  let f: BackupFile;
  try {
    f = JSON.parse(await storage.readText('backup.json')) as BackupFile;
  } catch {
    throw new BackupError('这个文件夹里没有可用的衣橱备份（backup.json）');
  }
  if (f.format !== BACKUP_FORMAT || !f.tables) throw new BackupError('不是衣橱的备份文件');
  if (f.schema > SCHEMA_VERSION) throw new BackupError('这个备份来自更新版本的 App，请先升级');
  return f;
}

/**
 * Replaces everything in the app with the backup. Images are copied first; the database is only touched once
 * all copies succeeded, so a failure leaves the current data as it was.
 */
export async function restoreBackup(
  db: Db,
  images: ImageStore,
  storage: BackupStorage,
  onProgress?: (done: number, total: number) => void,
): Promise<{ items: number; images: number }> {
  const f = await load(storage);
  const mapping = new Map<string, string>();
  const entries = Object.entries(f.images);
  let done = 0;
  try {
    for (const [name, folder] of entries) {
      mapping.set(name, await storage.getImage(name, folder));
      onProgress?.(++done, entries.length);
    }
  } catch (e) {
    for (const uri of mapping.values()) await images.remove(uri);
    throw e;
  }
  const map = (v: SqlParam): SqlParam => (typeof v === 'string' && mapping.has(v) ? mapping.get(v)! : typeof v === 'string' && v.startsWith('images/') ? null : v);

  const oldUris: string[] = [];
  for (const t of TABLES) {
    const rows = await db.getAllAsync<Row>(`SELECT * FROM ${t}`);
    for (const r of rows) {
      for (const c of Object.keys(URI_COLUMNS[t] ?? {})) if (isImageUri(r[c])) oldUris.push(r[c] as string);
      for (const c of Object.keys(URI_LIST_COLUMNS[t] ?? {})) oldUris.push(...parseJson<string[]>(r[c] as string, []));
    }
  }
  await db.withTransactionAsync(async () => {
    for (const t of [...TABLES].reverse()) {
      if (t === 'settings') await db.runAsync(`DELETE FROM settings WHERE key NOT IN (${DEVICE_SETTINGS.map(() => '?').join(', ')})`, DEVICE_SETTINGS);
      else await db.execAsync(`DELETE FROM ${t}`);
    }
    await db.execAsync('DELETE FROM jobs');
    for (const t of TABLES) {
      const single = Object.keys(URI_COLUMNS[t] ?? {});
      const lists = Object.keys(URI_LIST_COLUMNS[t] ?? {});
      for (const r of f.tables[t] ?? []) {
        if (t === 'settings' && DEVICE_SETTINGS.includes(String(r.key))) continue;
        const row: Row = { ...r };
        for (const c of single) row[c] = map(row[c]);
        for (const c of lists) row[c] = JSON.stringify(parseJson<string[]>(row[c] as string, []).map((x) => map(x)).filter(Boolean));
        if (t === 'tryon_cache' && !row.uri) continue;
        if (t === 'tryon_cache' && !row.avatar_version) row.avatar_version = 'none';
        const cols = Object.keys(row);
        await db.runAsync(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
      }
    }
  });
  // The previous data's pictures are no longer referenced.
  const kept = new Set(mapping.values());
  for (const u of new Set(oldUris)) if (!kept.has(u)) await images.remove(u);
  return { items: f.tables.items.length, images: mapping.size };
}
