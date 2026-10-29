import type { FidelityCheck, FieldSource, Item, ItemStatus, Season, Slot } from '@/domain/types';
import { type Db, newId, nowIso, parseJson, type SqlParam } from './db';

interface ItemRow {
  id: string;
  name: string;
  slot: string;
  subcategory: string | null;
  color_name: string | null;
  color_hex: string | null;
  seasons: string;
  brand: string | null;
  size: string | null;
  material: string | null;
  price_cents: number | null;
  purchased_on: string | null;
  channel: string | null;
  location: string | null;
  fit_notes: string | null;
  status: string;
  original_uri: string | null;
  catalog_uri: string | null;
  tag_uri: string | null;
  candidates: string;
  checks: string;
  field_sources: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function fromRow(r: ItemRow): Item {
  return {
    id: r.id,
    name: r.name,
    slot: r.slot as Slot,
    subcategory: r.subcategory,
    colorName: r.color_name,
    colorHex: r.color_hex,
    seasons: parseJson<Season[]>(r.seasons, []),
    brand: r.brand,
    size: r.size,
    material: r.material,
    priceCents: r.price_cents,
    purchasedOn: r.purchased_on,
    channel: r.channel,
    location: r.location,
    fitNotes: r.fit_notes,
    status: r.status as ItemStatus,
    originalUri: r.original_uri,
    catalogUri: r.catalog_uri,
    tagUri: r.tag_uri,
    candidates: parseJson<string[]>(r.candidates, []),
    checks: parseJson<FidelityCheck[][]>(r.checks, []),
    fieldSources: parseJson<Partial<Record<keyof Item, FieldSource>>>(r.field_sources, {}),
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Item field -> column. Only these are writable through `updateItem`. */
const COLUMNS: Partial<Record<keyof Item, string>> = {
  name: 'name',
  slot: 'slot',
  subcategory: 'subcategory',
  colorName: 'color_name',
  colorHex: 'color_hex',
  seasons: 'seasons',
  brand: 'brand',
  size: 'size',
  material: 'material',
  priceCents: 'price_cents',
  purchasedOn: 'purchased_on',
  channel: 'channel',
  location: 'location',
  fitNotes: 'fit_notes',
  status: 'status',
  originalUri: 'original_uri',
  catalogUri: 'catalog_uri',
  tagUri: 'tag_uri',
  candidates: 'candidates',
  checks: 'checks',
  fieldSources: 'field_sources',
  error: 'error',
};

const JSON_ARRAYS: (keyof Item)[] = ['seasons', 'candidates', 'checks'];

function toParam(key: keyof Item, value: unknown): SqlParam {
  if (JSON_ARRAYS.includes(key)) return JSON.stringify(value ?? []);
  if (key === 'fieldSources') return JSON.stringify(value ?? {});
  if (value === undefined) return null;
  return value as SqlParam;
}

export type NewItem = Partial<Omit<Item, 'id' | 'createdAt' | 'updatedAt'>> & Pick<Item, 'name' | 'slot' | 'status'>;

export async function createItem(db: Db, input: NewItem): Promise<Item> {
  const id = newId();
  const now = nowIso();
  const keys = Object.keys(COLUMNS) as (keyof Item)[];
  const cols = ['id', 'created_at', 'updated_at', ...keys.map((k) => COLUMNS[k]!)];
  const values: SqlParam[] = [id, now, now, ...keys.map((k) => toParam(k, (input as Partial<Item>)[k]))];
  await db.runAsync(
    `INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    values,
  );
  return (await getItem(db, id))!;
}

export async function getItem(db: Db, id: string): Promise<Item | null> {
  const row = await db.getFirstAsync<ItemRow>('SELECT * FROM items WHERE id = ?', [id]);
  return row ? fromRow(row) : null;
}

export async function listItems(db: Db, statuses?: ItemStatus[]): Promise<Item[]> {
  const rows = statuses?.length
    ? await db.getAllAsync<ItemRow>(
        `SELECT * FROM items WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at DESC, rowid DESC`,
        statuses,
      )
    : await db.getAllAsync<ItemRow>('SELECT * FROM items ORDER BY created_at DESC, rowid DESC');
  return rows.map(fromRow);
}

export async function updateItem(db: Db, id: string, patch: Partial<Item>): Promise<Item | null> {
  const keys = (Object.keys(patch) as (keyof Item)[]).filter((k) => COLUMNS[k]);
  if (keys.length === 0) return getItem(db, id);
  const sets = keys.map((k) => `${COLUMNS[k]} = ?`);
  const values = keys.map((k) => toParam(k, patch[k]));
  await db.runAsync(`UPDATE items SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [
    ...values,
    nowIso(),
    id,
  ]);
  return getItem(db, id);
}

/** Set a field the user typed, marking its source so the UI stops showing the AI badge. */
export async function setUserField<K extends keyof Item>(db: Db, id: string, key: K, value: Item[K]): Promise<Item | null> {
  const item = await getItem(db, id);
  if (!item) return null;
  return updateItem(db, id, { [key]: value, fieldSources: { ...item.fieldSources, [key]: 'user' } } as Partial<Item>);
}

export async function deleteItem(db: Db, id: string): Promise<void> {
  await db.runAsync('DELETE FROM items WHERE id = ?', [id]);
}

export async function countByStatus(db: Db): Promise<Record<ItemStatus, number>> {
  const rows = await db.getAllAsync<{ status: string; n: number }>(
    'SELECT status, COUNT(*) AS n FROM items GROUP BY status',
  );
  const out: Record<ItemStatus, number> = { processing: 0, review: 0, active: 0, failed: 0, archived: 0 };
  for (const r of rows) out[r.status as ItemStatus] = r.n;
  return out;
}
