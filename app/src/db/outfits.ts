import type { Outfit, Styling } from '@/domain/types';
import { type Db, newId, nowIso, parseJson } from './db';

interface OutfitRow {
  id: string;
  name: string;
  occasions: string;
  makeup: string | null;
  created_at: string;
}

interface Garments {
  itemIds: string[];
  styling: Record<string, Styling>;
}

/** Garments per outfit in the order they were saved (upper-body layers innermost first; older rows by insertion). */
async function itemIdsFor(db: Db, outfitIds: string[]): Promise<Map<string, Garments>> {
  const map = new Map<string, Garments>();
  if (outfitIds.length === 0) return map;
  const rows = await db.getAllAsync<{ outfit_id: string; item_id: string; styling: string | null }>(
    `SELECT outfit_id, item_id, styling FROM outfit_items WHERE outfit_id IN (${outfitIds.map(() => '?').join(', ')}) ORDER BY position, rowid`,
    outfitIds,
  );
  for (const r of rows) {
    const g = map.get(r.outfit_id) ?? { itemIds: [], styling: {} };
    g.itemIds.push(r.item_id);
    const st = r.styling ? parseJson<Styling>(r.styling, {}) : null;
    if (st && Object.keys(st).length) g.styling[r.item_id] = st;
    map.set(r.outfit_id, g);
  }
  return map;
}

function fromRow(r: OutfitRow, g: Garments = { itemIds: [], styling: {} }): Outfit {
  return {
    id: r.id,
    name: r.name,
    occasions: parseJson<string[]>(r.occasions, []),
    itemIds: g.itemIds,
    styling: g.styling,
    makeup: r.makeup ?? null,
    createdAt: r.created_at,
  };
}

export async function createOutfit(
  db: Db,
  input: { name: string; occasions: string[]; itemIds: string[]; styling?: Record<string, Styling>; makeup?: string | null },
): Promise<Outfit> {
  if (input.itemIds.length === 0) throw new Error('穿搭至少需要一件单品');
  const id = newId();
  await db.withTransactionAsync(async (tx) => {
    await tx.runAsync('INSERT INTO outfits (id, name, occasions, makeup, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      input.name.trim() || '新穿搭',
      JSON.stringify(input.occasions),
      input.makeup ?? null,
      nowIso(),
    ]);
    let position = 0;
    for (const itemId of new Set(input.itemIds)) {
      const st = input.styling?.[itemId];
      await tx.runAsync('INSERT INTO outfit_items (outfit_id, item_id, position, styling) VALUES (?, ?, ?, ?)', [
        id,
        itemId,
        position++,
        st && Object.keys(st).length ? JSON.stringify(st) : null,
      ]);
    }
  });
  return (await getOutfit(db, id))!;
}

export async function getOutfit(db: Db, id: string): Promise<Outfit | null> {
  const row = await db.getFirstAsync<OutfitRow>('SELECT * FROM outfits WHERE id = ?', [id]);
  if (!row) return null;
  const ids = await itemIdsFor(db, [id]);
  return fromRow(row, ids.get(id));
}

export async function listOutfits(db: Db): Promise<Outfit[]> {
  const rows = await db.getAllAsync<OutfitRow>('SELECT * FROM outfits ORDER BY created_at DESC');
  const ids = await itemIdsFor(db, rows.map((r) => r.id));
  return rows.map((r) => fromRow(r, ids.get(r.id)));
}

/** Finds a saved outfit with exactly these garments, so saving the same look twice doesn't duplicate it. */
export async function findOutfitByItems(db: Db, itemIds: string[]): Promise<Outfit | null> {
  const want = [...new Set(itemIds)].sort().join('+');
  for (const o of await listOutfits(db)) {
    if ([...o.itemIds].sort().join('+') === want) return o;
  }
  return null;
}

export async function updateOutfit(db: Db, id: string, patch: { name?: string; occasions?: string[] }): Promise<void> {
  if (patch.name !== undefined) await db.runAsync('UPDATE outfits SET name = ? WHERE id = ?', [patch.name, id]);
  if (patch.occasions !== undefined)
    await db.runAsync('UPDATE outfits SET occasions = ? WHERE id = ?', [JSON.stringify(patch.occasions), id]);
}

export async function deleteOutfit(db: Db, id: string): Promise<void> {
  await db.runAsync('DELETE FROM outfits WHERE id = ?', [id]);
}

export async function outfitsContaining(db: Db, itemId: string): Promise<Outfit[]> {
  const rows = await db.getAllAsync<{ outfit_id: string }>('SELECT outfit_id FROM outfit_items WHERE item_id = ?', [itemId]);
  const set = new Set(rows.map((r) => r.outfit_id));
  return (await listOutfits(db)).filter((o) => set.has(o.id));
}
