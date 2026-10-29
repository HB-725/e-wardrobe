import type { ImageStore } from '@/ai/imageStore';
import { tryonRef } from '@/ai/engine';
import type { Db } from '@/db/db';
import { createItem, deleteItem, getItem, updateItem } from '@/db/items';
import { deleteJobsFor, enqueueJob, latestJobFor, retryJob } from '@/db/jobs';
import { createOutfit, deleteOutfit, findOutfitByItems, getOutfit, updateOutfit } from '@/db/outfits';
import { avatarVersion, dropTryonsWithItem, getAvatar, getTryon, listTryonUris, referencedImages, saveAvatar, wipeAll } from '@/db/misc';
import { deleteLogByDate, getLogByDate, logWear } from '@/db/wear';
import { outfitKey } from '@/domain/outfit';
import type { Avatar, Item, Outfit, TryonView, WearSource } from '@/domain/types';

export interface Ctx {
  db: Db;
  images: ImageStore;
  runner: { kick(): void };
}

// ---------- garments ----------

/** Each photo becomes one item that the AI turns into a catalog image; tag photo is optional (single capture only). */
export async function addGarments(ctx: Ctx, photos: { uri: string; tagUri?: string | null }[]): Promise<Item[]> {
  const created: Item[] = [];
  for (const p of photos) {
    const originalUri = await ctx.images.importPhoto(p.uri, 'original');
    const tagUri = p.tagUri ? await ctx.images.importPhoto(p.tagUri, 'tag') : null;
    const item = await createItem(ctx.db, { name: '新衣服', slot: 'top', status: 'processing', originalUri, tagUri });
    await enqueueJob(ctx.db, 'catalog', item.id);
    created.push(item);
  }
  ctx.runner.kick();
  return created;
}

/**
 * Accept the review: `candidate` is the chosen generated image, or null to keep only the original photo.
 * Unchosen candidates are deleted.
 */
export async function confirmItem(ctx: Ctx, id: string, candidate: number | null, fields: Partial<Item> = {}): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item) return;
  const chosen = candidate === null ? null : (item.candidates[candidate] ?? null);
  if (candidate !== null && !chosen) throw new Error('candidate out of range');
  for (const c of item.candidates) if (c !== chosen) await ctx.images.remove(c);
  if (item.catalogUri && item.catalogUri !== chosen) await ctx.images.remove(item.catalogUri);
  // Try-ons were drawn from the old picture (or category).
  if (chosen !== item.catalogUri || (fields.slot && fields.slot !== item.slot)) await dropTryons(ctx, id);
  await updateItem(ctx.db, id, { ...fields, catalogUri: chosen, candidates: [], checks: [], status: item.status === 'archived' ? 'archived' : 'active', error: null });
}

/** Dismiss regenerated candidates and keep the current standard image. */
export async function keepCurrent(ctx: Ctx, id: string, fields: Partial<Item> = {}): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item) return;
  for (const c of item.candidates) if (c !== item.catalogUri) await ctx.images.remove(c);
  await updateItem(ctx.db, id, { ...fields, candidates: [], checks: [] });
}

/** Items waiting for the user: new garments in review, or wardrobe items with freshly regenerated candidates. */
export function needsReview(it: Pick<Item, 'status' | 'candidates'>): boolean {
  return it.status === 'review' || ((it.status === 'active' || it.status === 'archived') && it.candidates.length > 0);
}

/** New candidates for an item. A wardrobe item stays usable meanwhile; the result shows up in review. */
export async function regenerateItem(ctx: Ctx, id: string): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item) return;
  if (item.status !== 'active' && item.status !== 'archived') await updateItem(ctx.db, id, { status: 'processing', error: null });
  await enqueueJob(ctx.db, 'catalog', id, { regenerate: true });
  ctx.runner.kick();
}

/** Re-run a failed item from scratch (attempts reset). */
export async function retryItem(ctx: Ctx, id: string): Promise<void> {
  const job = await latestJobFor(ctx.db, 'catalog', id);
  await updateItem(ctx.db, id, { status: 'processing', error: null });
  if (job && job.status === 'failed') await retryJob(ctx.db, job.id);
  else await enqueueJob(ctx.db, 'catalog', id);
  ctx.runner.kick();
}

/** Give up on the AI image and keep the photo as is. */
export async function keepOriginal(ctx: Ctx, id: string, fields: Partial<Item> = {}): Promise<void> {
  await deleteJobsFor(ctx.db, id);
  await confirmItem(ctx, id, null, fields);
}

export async function removeItem(ctx: Ctx, id: string): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item) return;
  await deleteJobsFor(ctx.db, id);
  for (const uri of [item.originalUri, item.tagUri, item.catalogUri, ...item.candidates]) await ctx.images.remove(uri);
  await dropTryons(ctx, id);
  await deleteItem(ctx.db, id);
  // Outfits / days that only consisted of this item would be left empty.
  const orphanPhotos = await ctx.db.getAllAsync<{ photo_uri: string | null }>(
    'SELECT photo_uri FROM wear_logs WHERE id NOT IN (SELECT log_id FROM wear_log_items)',
  );
  for (const r of orphanPhotos) await ctx.images.remove(r.photo_uri);
  await ctx.db.runAsync('DELETE FROM outfits WHERE id NOT IN (SELECT outfit_id FROM outfit_items)');
  await ctx.db.runAsync('DELETE FROM wear_logs WHERE id NOT IN (SELECT log_id FROM wear_log_items)');
}

export async function setArchived(ctx: Ctx, id: string, archived: boolean): Promise<void> {
  await updateItem(ctx.db, id, { status: archived ? 'archived' : 'active' });
}

async function dropTryons(ctx: Ctx, itemId: string): Promise<void> {
  for (const uri of await dropTryonsWithItem(ctx.db, itemId)) await ctx.images.remove(uri);
}

/** Saves edits from the detail page; a category change invalidates that item's try-ons. */
export async function saveItemEdits(ctx: Ctx, id: string, patch: Partial<Item>): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item) return;
  if (patch.slot && patch.slot !== item.slot) await dropTryons(ctx, id);
  await updateItem(ctx.db, id, patch);
}

/**
 * Deletes image files nothing points at any more (left by an app kill mid-import, an interrupted restore, …).
 * Recent files are skipped: they may belong to an import that has not been saved to the database yet.
 */
export async function cleanOrphanImages(ctx: Ctx, now = Date.now()): Promise<number> {
  if (!ctx.images.listAll) return 0;
  const used = await referencedImages(ctx.db);
  let removed = 0;
  for (const f of await ctx.images.listAll()) {
    if (used.has(f.uri) || now - f.modified < 60 * 60 * 1000) continue;
    await ctx.images.remove(f.uri);
    removed += 1;
  }
  return removed;
}

export function displayUri(item: Pick<Item, 'catalogUri' | 'originalUri' | 'candidates'>): string | null {
  return item.catalogUri ?? item.candidates[0] ?? item.originalUri;
}

// ---------- outfits & wear ----------

export async function saveOutfit(ctx: Ctx, input: { name: string; occasions: string[]; itemIds: string[] }): Promise<Outfit> {
  const existing = await findOutfitByItems(ctx.db, input.itemIds);
  if (existing) {
    await updateOutfit(ctx.db, existing.id, { name: input.name.trim() || existing.name, occasions: input.occasions });
    return (await getOutfit(ctx.db, existing.id))!;
  }
  return createOutfit(ctx.db, input);
}

export async function removeOutfit(ctx: Ctx, id: string): Promise<void> {
  await deleteOutfit(ctx.db, id);
}

/** Records what was worn on a day (one record per day; logging again replaces it). Links to a saved outfit if one matches. */
export async function recordWear(
  ctx: Ctx,
  input: { date: string; itemIds: string[]; source: WearSource; photoUri?: string | null; outfitId?: string | null },
): Promise<void> {
  const outfitId = input.outfitId ?? (await findOutfitByItems(ctx.db, input.itemIds))?.id ?? null;
  const prev = await getLogByDate(ctx.db, input.date);
  // Adding garments to a day keeps its mirror photo; replacing the outfit drops it.
  const extendsPrev = !!prev && input.photoUri === undefined && prev.itemIds.every((id) => input.itemIds.includes(id));
  const photoUri = extendsPrev ? prev!.photoUri : (input.photoUri ?? null);
  const source = extendsPrev && prev!.source === 'mirror' ? 'mirror' : input.source;
  if (prev?.photoUri && prev.photoUri !== photoUri) await ctx.images.remove(prev.photoUri);
  await logWear(ctx.db, { ...input, outfitId, photoUri, source });
}

export async function undoWear(ctx: Ctx, date: string): Promise<void> {
  const prev = await getLogByDate(ctx.db, date);
  if (prev?.photoUri) await ctx.images.remove(prev.photoUri);
  await deleteLogByDate(ctx.db, date);
}

/** Appends a dated fit note from a mirror photo, keeping what the user wrote before. */
export async function addFitNote(ctx: Ctx, id: string, note: string, dateLabel: string): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item || !note.trim()) return;
  const line = `${note.trim()}（${dateLabel} 镜子照片）`;
  if (item.fitNotes?.includes(note.trim())) return;
  await updateItem(ctx.db, id, { fitNotes: item.fitNotes ? `${item.fitNotes}\n${line}` : line });
}

// ---------- avatar & try-on ----------

export async function startAvatar(ctx: Ctx, input: { photos: string[]; body: Pick<Avatar, 'heightCm' | 'weightKg' | 'build'> }): Promise<void> {
  const prev = await getAvatar(ctx.db);
  const kept = new Set(input.photos);
  for (const old of prev.sourceUris) if (!kept.has(old)) await ctx.images.remove(old);
  await saveAvatar(ctx.db, { ...input.body, sourceUris: input.photos, status: 'processing', error: null });
  await enqueueJob(ctx.db, 'avatar', 'me');
  ctx.runner.kick();
}

export interface TryonState {
  uri: string | null;
  status: 'none' | 'queued' | 'failed';
  error: string | null;
}

export async function tryonState(db: Db, itemIds: string[], view: TryonView): Promise<TryonState> {
  if (itemIds.length === 0) return { uri: null, status: 'none', error: null };
  const avatar = await getAvatar(db);
  const key = outfitKey(itemIds);
  const uri = await getTryon(db, key, view, avatarVersion(avatar));
  const job = await latestJobFor(db, 'tryon', tryonRef(key, view));
  // A cached image stays on screen while a regeneration runs.
  if (job && (job.status === 'queued' || job.status === 'running')) return { uri, status: 'queued', error: job.lastError };
  if (uri) return { uri, status: 'none', error: null };
  if (job && job.status === 'failed') return { uri: null, status: 'failed', error: job.lastError };
  return { uri: null, status: 'none', error: null };
}

export async function requestTryon(ctx: Ctx, itemIds: string[], view: TryonView): Promise<void> {
  const key = outfitKey(itemIds);
  const ref = tryonRef(key, view);
  const job = await latestJobFor(ctx.db, 'tryon', ref);
  if (job?.status === 'failed') await retryJob(ctx.db, job.id);
  else await enqueueJob(ctx.db, 'tryon', ref, { itemIds });
  ctx.runner.kick();
}

// ---------- privacy ----------

/** Callers must stop the runner and wait for it to go idle first, or a running job writes data back. */
export async function wipeEverything(ctx: Ctx): Promise<void> {
  // Collect file uris first in case the store cannot wipe its folder (web).
  for (const uri of await listTryonUris(ctx.db)) await ctx.images.remove(uri);
  await ctx.images.wipe();
  await wipeAll(ctx.db);
}

/** Adds or replaces the photo of an item (e.g. one imported from Excel) and generates its catalog image. */
export async function setItemPhoto(ctx: Ctx, id: string, uri: string): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item) return;
  const originalUri = await ctx.images.importPhoto(uri, 'original');
  await ctx.images.remove(item.originalUri);
  // A wardrobe item stays usable; the new standard image waits in review. Others go back to generating.
  const keep = item.status === 'active' || item.status === 'archived';
  await updateItem(ctx.db, id, { originalUri, ...(keep ? {} : { status: 'processing' as const }), error: null });
  await deleteJobsFor(ctx.db, id);
  // A job still running uses the old photo; it notices the change and drops its result, this one redoes it.
  await enqueueJob(ctx.db, 'catalog', id, {}, { evenIfRunning: true });
  ctx.runner.kick();
}

/** Fields present in an import row count as typed by the user, so the AI never overwrites them. */
export function userSources(fields: Partial<Item>): Item['fieldSources'] {
  const out: Item['fieldSources'] = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) out[k as keyof Item] = 'user';
  }
  return out;
}
