import { saveAiSettings } from '@/ai/config';
import type { Route } from '@/ai/catalog';
import type { ImageStore } from '@/ai/imageStore';
import { getRoutes, saveRoutes } from '@/ai/keys';
import { layerRef, tryonRef } from '@/ai/engine';
import type { Db } from '@/db/db';
import { createItem, deleteItem, getItem, listItems, updateItem } from '@/db/items';
import { deleteJobsFor, enqueueJob, latestJobFor, listJobs, retryJob, updateJobPayload } from '@/db/jobs';
import { createOutfit, deleteOutfit, findOutfitByItems, getOutfit, listOutfits, updateOutfit } from '@/db/outfits';
import { avatarUsable, avatarVersion, dropLayersOf, dropTryonsWithItem, getAvatar, getTryon, listLayers, listTryonUris, referencedImages, saveAvatar, wipeAll } from '@/db/misc';
import { deleteLogByDate, getLogByDate, logWear } from '@/db/wear';
import { maskBox, wantsOpen } from '@/domain/layers';
import type { Box } from '@/domain/crop';
import { type Look, lookKey } from '@/domain/look';
import type { Avatar, Item, Outfit, Slot, Styling, TryonView, WearSource } from '@/domain/types';

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
  // The fitting room's layers were painted from the old picture.
  if (chosen !== item.catalogUri) for (const uri of await dropLayersOf(ctx.db, id)) await ctx.images.remove(uri);
}

/**
 * Queues the layers the fitting room still lacks for this avatar (closed for every garment with a picture, open too
 * for what opens, front and back), the garments being worn first. Returns how many were queued.
 */
export async function ensureLayers(ctx: Ctx, priorityIds: string[] = []): Promise<number> {
  const avatar = await getAvatar(ctx.db);
  if (!avatarUsable(avatar) || !avatar.greenFrontUri) return 0;
  const version = avatarVersion(avatar);
  const items = await listItems(ctx.db, ['active']);
  const ordered = [...items.filter((i) => priorityIds.includes(i.id)), ...items.filter((i) => !priorityIds.includes(i.id))];
  const have = new Set((await listLayers(ctx.db, items.map((i) => i.id), version)).map((l) => `${l.itemId}:${l.view}:${l.variant}`));
  const queued = new Set((await listJobs(ctx.db, ['queued', 'running'])).filter((j) => j.type === 'layer').map((j) => j.refId));
  let n = 0;
  for (const it of ordered) {
    if (!it.catalogUri || !maskBox(it.slot)) continue;
    for (const view of ['front', 'back'] as const) {
      if (view === 'back' && !avatar.greenBackUri) continue;
      for (const variant of wantsOpen(it) ? (['closed', 'open'] as const) : (['closed'] as const)) {
        const ref = layerRef(it.id, view, variant);
        if (have.has(`${it.id}:${view}:${variant}`) || queued.has(ref)) continue;
        await enqueueJob(ctx.db, 'layer', ref, { view, variant });
        n += 1;
      }
    }
  }
  return n;
}

/** Dismiss regenerated candidates and keep the current standard image. */
export async function keepCurrent(ctx: Ctx, id: string, fields: Partial<Item> = {}): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item) return;
  for (const c of item.candidates) if (c !== item.catalogUri) await ctx.images.remove(c);
  await updateItem(ctx.db, id, { ...fields, candidates: [], checks: [] });
}

/** Items waiting for the user: new garments in review, photos to pick garments from, or wardrobe items with freshly regenerated candidates. */
export function needsReview(it: Pick<Item, 'status' | 'candidates'>): boolean {
  return it.status === 'review' || it.status === 'pick' || ((it.status === 'active' || it.status === 'archived') && it.candidates.length > 0);
}

/** Deletes an image unless another item still uses it (the whole photo several garments were cut from). */
async function removeUnshared(ctx: Ctx, uri: string | null, exceptId: string): Promise<void> {
  if (!uri) return;
  const r = await ctx.db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM items WHERE id != ? AND (source_uri = ? OR original_uri = ?)', [exceptId, uri, uri]);
  if (!r?.n) await ctx.images.remove(uri);
}

const AI_FIELDS = ['name', 'slot', 'subcategory', 'colorName', 'colorHex', 'seasons', 'brand', 'size', 'material'] as const;

/** Turns the chosen garments of a photo into items that each generate from their own crop; the photo's row goes. */
export async function confirmPicks(ctx: Ctx, id: string): Promise<Item[]> {
  const pick = await getItem(ctx.db, id);
  if (!pick || pick.status !== 'pick' || !pick.originalUri) return [];
  const chosen = pick.detections.filter((d) => d.selected);
  if (chosen.length === 0) throw new Error('还没有选中衣服');
  const created: Item[] = [];
  for (const d of chosen) {
    const { box, selected: _s, manual, edited, printText, ...fields } = d;
    const originalUri = await ctx.images.crop(pick.originalUri, box, 'original');
    const fieldSources = manual ? {} : Object.fromEntries(AI_FIELDS.filter((k) => fields[k] != null).map((k) => [k, 'ai' as const]));
    const item = await createItem(ctx.db, { ...fields, status: 'processing', originalUri, sourceUri: pick.originalUri, crop: box, fieldSources });
    // A box the user drew or moved far may hold a different garment than the AI described: recognise the crop.
    await enqueueJob(ctx.db, 'catalog', item.id, { autofill: manual || edited ? 'crop' : 'skip', printText: printText ?? undefined });
    created.push(item);
  }
  await deleteJobsFor(ctx.db, id);
  await deleteItem(ctx.db, id); // the photo file stays: the new items' sourceUri
  ctx.runner.kick();
  return created;
}

/** Saves which garments of a photo are chosen and where their boxes are. */
export async function setDetections(ctx: Ctx, id: string, detections: Item['detections']): Promise<void> {
  await updateItem(ctx.db, id, { detections });
}

/** Re-cuts an item from its whole photo (or from its own photo if it was never cut); the next generation uses it. */
export async function cropItem(ctx: Ctx, id: string, box: Box): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item?.originalUri) return;
  const source = item.sourceUri ?? item.originalUri;
  const originalUri = await ctx.images.crop(source, box, 'original');
  if (item.originalUri !== source) await ctx.images.remove(item.originalUri); // the previous crop, only ever this item's
  await updateItem(ctx.db, id, { sourceUri: source, crop: box, originalUri });
}

export interface RegenerateOptions {
  /** A model for this time only (or for good with `makeDefault`). */
  model?: Route;
  quality?: 'low' | 'medium' | 'high';
  /** The owner's notes for the AI, this time only. */
  hint?: string;
  makeDefault?: boolean;
}

/** Saves what the user changed in the form first, so the new picture follows it (e.g. a corrected category). */
export async function regenerateWith(ctx: Ctx, id: string, fields: Partial<Item>, opts: RegenerateOptions): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item) return;
  // The measured colour code describes the old colour name.
  const colorChanged = fields.colorName !== undefined && fields.colorName !== item.colorName;
  if (Object.keys(fields).length) await updateItem(ctx.db, id, colorChanged ? { ...fields, colorHex: null } : fields);
  if (opts.makeDefault) {
    if (opts.model) await saveRoutes(ctx.db, { ...(await getRoutes(ctx.db)), catalog: opts.model });
    if (opts.quality) await saveAiSettings(ctx.db, { catalogQuality: opts.quality });
  }
  await regenerateItem(ctx, id, { model: opts.model, quality: opts.quality, hint: opts.hint?.trim() || undefined });
}

/** New candidates for an item. A wardrobe item stays usable meanwhile; the result shows up in review. */
export async function regenerateItem(ctx: Ctx, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const item = await getItem(ctx.db, id);
  if (!item) return;
  if (item.status !== 'active' && item.status !== 'archived') await updateItem(ctx.db, id, { status: 'processing', error: null });
  await enqueueJob(ctx.db, 'catalog', id, { regenerate: true, ...extra });
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
  for (const uri of [item.tagUri, item.catalogUri, ...item.candidates]) await ctx.images.remove(uri);
  for (const uri of [item.originalUri, item.sourceUri]) await removeUnshared(ctx, uri, id);
  await dropTryons(ctx, id);
  for (const uri of await dropLayersOf(ctx.db, id)) await ctx.images.remove(uri);
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

/** Categories of these garments, to tell upper-body layers from the rest. */
async function slotsOf(db: Db, ids: string[]): Promise<(id: string) => Slot | undefined> {
  const items = await Promise.all([...new Set(ids)].map((id) => getItem(db, id)));
  const map = new Map(items.filter((x): x is Item => !!x).map((i) => [i.id, i.slot]));
  return (id) => map.get(id);
}

/** Saving the same look twice updates it; the same garments layered, worn or made up differently are another outfit. */
export async function saveOutfit(
  ctx: Ctx,
  input: { name: string; occasions: string[]; itemIds: string[]; styling?: Record<string, Styling>; makeup?: string | null },
): Promise<Outfit> {
  const styling = input.styling ?? {};
  const slotOf = await slotsOf(ctx.db, input.itemIds);
  const key = lookKey(input.itemIds, styling, slotOf, input.makeup);
  const existing = (await listOutfits(ctx.db)).find((o) => lookKey(o.itemIds, o.styling, slotOf, o.makeup) === key);
  if (existing) {
    await updateOutfit(ctx.db, existing.id, { name: input.name.trim() || existing.name, occasions: input.occasions });
    return (await getOutfit(ctx.db, existing.id))!;
  }
  return createOutfit(ctx.db, { ...input, styling });
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

export async function startAvatar(ctx: Ctx, input: { photos: string[]; body: Pick<Avatar, 'heightCm' | 'weightKg' | 'build'> & Partial<Pick<Avatar, 'shoulderCm' | 'chestCm' | 'waistCm'>> }): Promise<void> {
  const prev = await getAvatar(ctx.db);
  const kept = new Set(input.photos);
  for (const old of prev.sourceUris) if (!kept.has(old)) await ctx.images.remove(old);
  await saveAvatar(ctx.db, { ...input.body, sourceUris: input.photos, status: 'processing', error: null });
  await enqueueJob(ctx.db, 'avatar', 'me');
  ctx.runner.kick();
}

export interface TryonState {
  /** With makeup chosen but not drawn yet, the same outfit without it (`missingMakeup`). */
  uri: string | null;
  status: 'none' | 'queued' | 'failed';
  error: string | null;
  missingMakeup: boolean;
}

/** Makeup is drawn on the front only; from behind the look is the one without it. */
const asSeen = (look: Look, view: TryonView): Look => (view === 'back' && look.makeup ? { ids: look.ids, styling: look.styling } : look);

export async function tryonState(db: Db, look: Look, view: TryonView): Promise<TryonState> {
  const lk = asSeen(look, view);
  if (lk.ids.length === 0 && !lk.makeup) return { uri: null, status: 'none', error: null, missingMakeup: false };
  const avatar = await getAvatar(db);
  const slotOf = await slotsOf(db, lk.ids);
  const key = lookKey(lk.ids, lk.styling, slotOf, lk.makeup);
  const made = await getTryon(db, key, view, avatarVersion(avatar));
  const plain = !made && lk.makeup && lk.ids.length ? await getTryon(db, lookKey(lk.ids, lk.styling, slotOf), view, avatarVersion(avatar)) : null;
  const uri = made ?? plain;
  const missingMakeup = !!lk.makeup && !made;
  const job = await latestJobFor(db, 'tryon', tryonRef(key, view));
  // A cached image stays on screen while a regeneration runs.
  if (job && (job.status === 'queued' || job.status === 'running')) return { uri, status: 'queued', error: job.lastError, missingMakeup };
  if (job && job.status === 'failed' && !made) return { uri, status: 'failed', error: job.lastError, missingMakeup };
  return { uri, status: 'none', error: null, missingMakeup };
}

/** From the try-on sheet: a model and quality for this time (or from now on), and notes for the AI. */
export interface TryonOptions {
  model?: Route;
  quality?: 'low' | 'medium' | 'high';
  hint?: string;
  makeDefault?: boolean;
}

export async function requestTryon(ctx: Ctx, look: Look, view: TryonView, opts: TryonOptions = {}): Promise<void> {
  const lk = asSeen(look, view);
  if (opts.makeDefault) {
    if (opts.model) await saveRoutes(ctx.db, { ...(await getRoutes(ctx.db)), tryon: opts.model });
    if (opts.quality) await saveAiSettings(ctx.db, { tryonQuality: opts.quality });
  }
  const key = lookKey(lk.ids, lk.styling, await slotsOf(ctx.db, lk.ids), lk.makeup);
  const ref = tryonRef(key, view);
  const payload = { itemIds: lk.ids, styling: lk.styling, makeup: lk.makeup, model: opts.model, quality: opts.quality, hint: opts.hint?.trim() || undefined };
  const job = await latestJobFor(ctx.db, 'tryon', ref);
  if (job?.status === 'failed') {
    await updateJobPayload(ctx.db, job.id, payload);
    await retryJob(ctx.db, job.id);
  } else await enqueueJob(ctx.db, 'tryon', ref, payload);
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
  for (const old of [item.originalUri, item.sourceUri]) await removeUnshared(ctx, old, id);
  // A wardrobe item stays usable; the new standard image waits in review. Others go back to generating.
  const keep = item.status === 'active' || item.status === 'archived';
  await updateItem(ctx.db, id, { originalUri, sourceUri: null, crop: null, ...(keep ? {} : { status: 'processing' as const }), error: null });
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
