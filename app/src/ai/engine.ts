import { LAYER_ORDER } from '@/domain/catalog';
import type { FieldSource, Item, Job, Slot } from '@/domain/types';
import type { Db } from '@/db/db';
import { getItem, listItems, updateItem } from '@/db/items';
import { updateJobPayload } from '@/db/jobs';
import { addUsage, avatarUsable, avatarVersion, getAvatar, getTryon, monthSpend, pruneTryons, putTryon, saveAvatar } from '@/db/misc';
import { AiError, type OpenAiClient } from './client';
import { getAiSettings, getModelChoice, qualityFor, saveModelChoice } from './config';
import type { ImageStore } from './imageStore';
import { blockModel, chatCost, imageCost, pickModels } from './models';
import {
  AUTOFILL_SCHEMA,
  AUTOFILL_SYSTEM,
  autofillText,
  type AutofillResult,
  avatarBackPrompt,
  avatarFrontPrompt,
  catalogPrompt,
  FIDELITY_SCHEMA,
  FIDELITY_SYSTEM,
  fidelityText,
  type FidelityResult,
  MIRROR_SCHEMA,
  MIRROR_SYSTEM,
  mirrorText,
  type MirrorResult,
  photoPrompt,
  SCENES,
  tryonPrompt,
} from './prompts';

export interface AiDeps {
  db: Db;
  images: ImageStore;
  /** Null when the user has not entered a key. */
  getClient(): Promise<OpenAiClient | null>;
  now?: () => Date;
}

const PROBE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

async function requireClient(deps: AiDeps): Promise<OpenAiClient> {
  const c = await deps.getClient();
  if (!c) throw new AiError('no_key', 'missing api key');
  return c;
}

/** Throws `cap` if this month's spend already reached the user's limit. */
export async function assertBudget(deps: AiDeps): Promise<void> {
  const [{ capUsd }, spend] = await Promise.all([getAiSettings(deps.db), monthSpend(deps.db, deps.now?.() ?? new Date())]);
  if (capUsd > 0 && spend.totalUsd >= capUsd) throw new AiError('cap', `spend ${spend.totalUsd} >= cap ${capUsd}`);
}

/** Picks models from /v1/models, re-probing every few days or when nothing usable is chosen. */
export async function ensureModels(deps: AiDeps, client: OpenAiClient, force = false): Promise<{ image: string | null; vision: string | null }> {
  const choice = await getModelChoice(deps.db);
  const now = deps.now?.() ?? new Date();
  const fresh = choice.probedAt && now.getTime() - new Date(choice.probedAt).getTime() < PROBE_TTL_MS;
  if (!force && fresh && choice.image && choice.vision) return choice;
  const available = await client.listModels();
  // Blocks expire with every re-probe (every few days): a model may have been re-enabled for the account, or the
  // block came from a transient error. Within one probe period they stick.
  const blocked = force || !fresh ? [] : choice.blocked.filter((m) => available.includes(m));
  const next = { ...pickModels(available, blocked), blocked, probedAt: now.toISOString() };
  await saveModelChoice(deps.db, next);
  return next;
}

/**
 * Runs `fn` with the preferred model of a kind; if the model turns out to be unavailable it is blocked and the next
 * one tried, so a deprecated model never strands the user.
 */
async function withModel<T>(deps: AiDeps, client: OpenAiClient, kind: 'image' | 'vision', fn: (model: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const models = await ensureModels(deps, client);
    const model = models[kind];
    if (!model) throw new AiError('model', `no ${kind} model available for this key`);
    try {
      return await fn(model);
    } catch (e) {
      if (!(e instanceof AiError) || e.kind !== 'model') throw e;
      const choice = await getModelChoice(deps.db);
      let available: string[] = [];
      try {
        available = await client.listModels();
      } catch {
        // keep going with the static list
      }
      await saveModelChoice(deps.db, { ...blockModel(choice, model, available), probedAt: choice.probedAt });
    }
  }
  throw new AiError('model', `no working ${kind} model`);
}

async function generate(
  deps: AiDeps,
  client: OpenAiClient,
  kind: Job['type'] | 'photo',
  req: { prompt: string; images: string[]; quality: 'low' | 'medium' | 'high'; n?: number; transparent?: boolean },
): Promise<string[]> {
  return withModel(deps, client, 'image', async (model) => {
    await assertBudget(deps);
    const r = await client.imageEdit({ model, prompt: req.prompt, images: req.images, quality: req.quality, n: req.n, size: '1024x1536', transparent: req.transparent });
    await addUsage(deps.db, { kind, model, costUsd: imageCost(model, r.usage) });
    return r.images;
  });
}

async function vision<T>(
  deps: AiDeps,
  client: OpenAiClient,
  kind: Job['type'],
  req: { system: string; text: string; images: string[]; schemaName: string; schema: Record<string, unknown>; detail?: 'low' | 'high' | 'auto' },
): Promise<T> {
  return withModel(deps, client, 'vision', async (model) => {
    await assertBudget(deps);
    const r = await client.visionJson<T>({ model, ...req });
    await addUsage(deps.db, { kind, model, costUsd: chatCost(model, r.usage) });
    return r.data;
  });
}

// ---------- autofill ----------

const AUTO_FIELDS = ['name', 'slot', 'subcategory', 'colorName', 'colorHex', 'seasons', 'brand', 'size', 'material'] as const;

/** Applies AI results without overwriting anything the user typed. Exported for tests. */
export function applyAutofill(item: Item, r: AutofillResult): Partial<Item> {
  const patch: Partial<Item> = {};
  const sources: Partial<Record<keyof Item, FieldSource>> = { ...item.fieldSources };
  for (const key of AUTO_FIELDS) {
    if (item.fieldSources[key] === 'user') continue;
    const value = r[key];
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0) || value === '') continue;
    if (key === 'colorHex' && !/^#[0-9a-fA-F]{6}$/.test(String(value))) continue;
    (patch as Record<string, unknown>)[key] = value;
    sources[key] = (r.fromTag as string[]).includes(key) ? 'tag' : 'ai';
  }
  patch.fieldSources = sources;
  return patch;
}

// ---------- job handlers ----------

async function runCatalog(deps: AiDeps, job: Job): Promise<void> {
  const { db, images } = deps;
  let item = await getItem(db, job.refId);
  if (!item || !item.originalUri) return; // deleted meanwhile
  const client = await requireClient(deps);
  const settings = await getAiSettings(db);
  const original = await images.toDataUrl(item.originalUri, 1024);

  const startStatus = item.status;
  if (!job.payload.regenerate) {
    const tag = item.tagUri ? await images.toDataUrl(item.tagUri, 1024) : null;
    const r = await vision<AutofillResult>(deps, client, 'catalog', {
      system: AUTOFILL_SYSTEM,
      text: autofillText(!!tag),
      images: tag ? [original, tag] : [original],
      schemaName: 'garment',
      schema: AUTOFILL_SCHEMA as unknown as Record<string, unknown>,
      detail: 'high',
    });
    // Re-read: the user may have typed fields, settled or deleted the item while the model was thinking.
    const now = await getItem(db, item.id);
    if (!now || now.status !== startStatus) return;
    item = (await updateItem(db, item.id, applyAutofill(now, r)))!;
  }

  // A retry after a crash reuses the candidates that were already paid for.
  let uris = (job.payload.generated as string[] | undefined) ?? [];
  if (uris.length === 0) {
    const b64s = await generate(deps, client, 'catalog', {
      prompt: catalogPrompt(item.slot, item.name, { name: item.colorName, hex: item.colorHex }),
      images: [original],
      quality: qualityFor(settings.quality, 'catalog'),
      n: Math.max(1, Math.min(3, settings.candidates)),
      // Opaque on purpose: transparent cut-outs look perfect, but image models read transparent pixels as black,
      // so dark garments vanish when they are fed back in for try-ons (verified with black jeans).
    });
    for (const b64 of b64s) uris.push(await images.saveBase64(b64, 'catalog'));
    await updateJobPayload(db, job.id, { ...job.payload, generated: uris });
  }

  // The checklist helps the user choose; if it fails the candidates are still usable.
  let checks: Item['checks'] = [];
  try {
    const thumbs = await Promise.all(uris.map((u) => images.toDataUrl(u, 768)));
    const r = await vision<FidelityResult>(deps, client, 'catalog', {
      system: FIDELITY_SYSTEM,
      text: fidelityText(uris.length),
      images: [await images.toDataUrl(item.originalUri!, 768), ...thumbs],
      schemaName: 'fidelity',
      schema: FIDELITY_SCHEMA as unknown as Record<string, unknown>,
      detail: 'high',
    });
    checks = uris.map((_, i) => r.candidates[i]?.checks ?? []);
  } catch {
    // Paid-for candidates are kept even if the check fails (including on the spend cap).
  }

  const fresh = await getItem(db, item.id);
  // A first-time item the user deleted or settled ("只存原图") meanwhile: drop the results.
  const inWardrobe = (st: Item['status']) => st === 'active' || st === 'archived';
  const settled = !fresh || (!inWardrobe(startStatus) && inWardrobe(fresh.status));
  if (settled) {
    for (const u of uris) await images.remove(u);
    return;
  }
  for (const old of fresh.candidates) if (old !== fresh.catalogUri) await images.remove(old);
  // Regenerating a garment already in the wardrobe keeps it usable; the new candidates wait for review.
  await updateItem(db, item.id, { candidates: uris, checks, status: inWardrobe(fresh.status) ? fresh.status : 'review', error: null });
}

async function runAvatar(deps: AiDeps, job: Job): Promise<void> {
  const { db, images } = deps;
  const avatar = await getAvatar(db);
  if (avatar.sourceUris.length === 0) throw new AiError('rejected', 'no body photos');
  const client = await requireClient(deps);
  const settings = await getAiSettings(db);
  const quality = qualityFor(settings.quality, 'avatar');
  const sources = await Promise.all(avatar.sourceUris.map((u) => images.toDataUrl(u, 1024)));

  // The front costs most; if the back failed last time, continue from the front already generated.
  let frontUri = job.payload.front as string | undefined;
  if (!frontUri) {
    const [front] = await generate(deps, client, 'avatar', { prompt: avatarFrontPrompt(avatar), images: sources, quality });
    frontUri = await images.saveBase64(front, 'avatar');
    await updateJobPayload(deps.db, job.id, { ...job.payload, front: frontUri });
  }
  const frontRef = await images.toDataUrl(frontUri, 1024);
  // The third body photo is the back view when the user took all three.
  const backRef = sources.length >= 3 ? [sources[2]] : [];
  const [back] = await generate(deps, client, 'avatar', { prompt: avatarBackPrompt(), images: [frontRef, ...backRef], quality });
  const backUri = await images.saveBase64(back, 'avatar');

  const prev = await getAvatar(db);
  await images.remove(prev.frontUri);
  await images.remove(prev.backUri);
  const next = await saveAvatar(db, { frontUri, backUri, status: 'ready', error: null });
  for (const uri of await pruneTryons(db, avatarVersion(next))) await images.remove(uri);
}

export function tryonRef(key: string, view: 'front' | 'back'): string {
  return `${key}|${view}`;
}

async function orderedGarments(db: Db, itemIds: string[]): Promise<Item[]> {
  // Items without any picture (Excel imports) cannot be drawn on the avatar.
  const items = (await Promise.all(itemIds.map((id) => getItem(db, id)))).filter((x): x is Item => !!x && !!(x.catalogUri ?? x.originalUri));
  return items.sort((a, b) => LAYER_ORDER.indexOf(a.slot) - LAYER_ORDER.indexOf(b.slot));
}

async function runTryon(deps: AiDeps, job: Job): Promise<void> {
  const { db, images } = deps;
  const [key, view] = job.refId.split('|') as [string, 'front' | 'back'];
  const itemIds = (job.payload.itemIds as string[] | undefined) ?? key.split('+');
  const avatar = await getAvatar(db);
  const base = view === 'back' ? avatar.backUri : avatar.frontUri;
  if (!avatarUsable(avatar) || !base) throw new AiError('rejected', 'avatar not ready');
  const garments = await orderedGarments(db, itemIds);
  if (garments.length === 0) return;
  const client = await requireClient(deps);
  const settings = await getAiSettings(db);
  const refs = await Promise.all(garments.map((g) => images.toDataUrl((g.catalogUri ?? g.originalUri)!, 768)));
  const [b64] = await generate(deps, client, 'tryon', {
    prompt: tryonPrompt(garments.map((g) => g.slot), view),
    images: [await images.toDataUrl(base, 1024), ...refs],
    quality: qualityFor(settings.quality, 'tryon'),
  });
  const uri = await images.saveBase64(b64, 'tryon');
  const version = avatarVersion(avatar);
  const old = await getTryon(db, key, view, version);
  await putTryon(db, key, view, version, uri);
  if (old && old !== uri) await images.remove(old);
}

export async function runJob(deps: AiDeps, job: Job): Promise<void> {
  await assertBudget(deps);
  switch (job.type) {
    case 'catalog':
      return runCatalog(deps, job);
    case 'avatar':
      return runAvatar(deps, job);
    case 'tryon':
      return runTryon(deps, job);
    default:
      return;
  }
}

/** Marks the job's subject as failed once retries are exhausted. */
export async function markJobFailed(deps: AiDeps, job: Job, message: string): Promise<void> {
  if (job.type === 'catalog') {
    const item = await getItem(deps.db, job.refId);
    for (const u of (job.payload.generated as string[] | undefined) ?? []) if (!item?.candidates.includes(u)) await deps.images.remove(u);
    // A regenerate of a wardrobe item that fails leaves the item as it was; an item that still has candidates
    // from an earlier run goes back to review so those paid images stay usable.
    if (item && (item.status === 'processing' || item.status === 'review')) {
      await updateItem(deps.db, job.refId, item.candidates.length ? { status: 'review', error: message } : { status: 'failed', error: message });
    }
  } else if (job.type === 'avatar') {
    const a = await getAvatar(deps.db);
    const front = job.payload.front as string | undefined;
    if (front && front !== a.frontUri) await deps.images.remove(front);
    // Keep the previous avatar usable when only the regeneration failed; the error is shown on the setup page.
    await saveAvatar(deps.db, { status: a.frontUri && a.backUri ? 'ready' : 'failed', error: message });
  }
}

// ---------- interactive calls (the user waits on screen) ----------

export interface MirrorMatch {
  itemId: string;
  confidence: 'high' | 'medium' | 'low';
  note: string;
}

/** Reference images per mirror call; most-worn first so the usual suspects are always included. */
const MIRROR_MAX_ITEMS = 60;

export async function matchMirror(deps: AiDeps, photoUri: string): Promise<{ matches: MirrorMatch[]; unmatched: string[] }> {
  await assertBudget(deps);
  const client = await requireClient(deps);
  const wears = new Map(
    (await deps.db.getAllAsync<{ item_id: string; n: number }>('SELECT item_id, COUNT(*) AS n FROM wear_log_items GROUP BY item_id')).map((r) => [r.item_id, r.n]),
  );
  const items = (await listItems(deps.db, ['active']))
    .filter((i) => i.catalogUri || i.originalUri)
    .sort((a, b) => (wears.get(b.id) ?? 0) - (wears.get(a.id) ?? 0))
    .slice(0, MIRROR_MAX_ITEMS);
  if (items.length === 0) return { matches: [], unmatched: [] };
  const refs: string[] = [];
  for (const i of items) refs.push(await deps.images.toDataUrl((i.catalogUri ?? i.originalUri)!, 256));
  const r = await vision<MirrorResult>(deps, client, 'mirror', {
    system: MIRROR_SYSTEM,
    text: mirrorText(items.map((i, k) => ({ index: k + 1, name: i.name, slot: i.slot, color: i.colorName }))),
    images: [await deps.images.toDataUrl(photoUri, 1024), ...refs],
    schemaName: 'mirror',
    schema: MIRROR_SCHEMA as unknown as Record<string, unknown>,
    detail: 'auto',
  });
  const seenSlots = new Set<Slot>();
  const matches: MirrorMatch[] = [];
  for (const m of r.matches) {
    const it = items[m.index - 1];
    if (!it || seenSlots.has(it.slot)) continue;
    seenSlots.add(it.slot);
    matches.push({ itemId: it.id, confidence: m.confidence, note: m.note.trim() });
  }
  return { matches, unmatched: r.unmatched };
}

export async function generatePhoto(deps: AiDeps, itemIds: string[], sceneId: string): Promise<string> {
  await assertBudget(deps);
  const client = await requireClient(deps);
  const avatar = await getAvatar(deps.db);
  if (!avatarUsable(avatar) || !avatar.frontUri) throw new AiError('rejected', 'avatar not ready');
  const scene = SCENES.find((s) => s.id === sceneId) ?? SCENES[0];
  const garments = await orderedGarments(deps.db, itemIds);
  if (garments.length === 0) throw new AiError('rejected', 'no garment images');
  const settings = await getAiSettings(deps.db);
  const refs = await Promise.all(garments.map((g) => deps.images.toDataUrl((g.catalogUri ?? g.originalUri)!, 768)));
  const [b64] = await generate(deps, client, 'photo', {
    prompt: `${tryonPrompt(garments.map((g) => g.slot), 'front')} Then: ${photoPrompt(scene)}`,
    images: [await deps.images.toDataUrl(avatar.frontUri, 1024), ...refs],
    quality: qualityFor(settings.quality, 'photo'),
  });
  return deps.images.saveBase64(b64, 'photo');
}

/** Checks a key before saving it: lists models and returns what would be used. */
export async function verifyKey(client: OpenAiClient): Promise<{ image: string | null; vision: string | null; available: string[] }> {
  const available = await client.listModels();
  return { ...pickModels(available), available };
}
