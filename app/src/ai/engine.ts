import { type Box, boxArea, fromBox2d, padBox, tidyGarments } from '@/domain/crop';
import { idsOfKey, lookKey, withoutMakeupKey } from '@/domain/look';
import { makeupPromptText } from '@/domain/makeup';
import type { Detection, FieldSource, Item, Job, Slot, Styling } from '@/domain/types';
import type { Db } from '@/db/db';
import { getItem, listItems, updateItem } from '@/db/items';
import { hasNewerJob, updateJobPayload } from '@/db/jobs';
import { addUsage, avatarUsable, avatarVersion, deleteTryon, getAvatar, getTryon, monthSpend, pruneTryons, putTryon, saveAvatar } from '@/db/misc';
import { callCost, type KeyEntry, modelInfo, type Purpose, type Resolved, resolveRoute, type Route } from './catalog';
import { AiError, type OpenAiClient } from './client';
import { catalogQuality, getAiSettings, qualityFor, tryonQuality } from './config';
import { type ImageStore, imageExt } from './imageStore';
import { blockModelForKey, getRoutes, hasConsentFor, listKeys, markVerified, probeModels } from './keys';
import { ANALYSIS_SCHEMA, ANALYSIS_SYSTEM, type AnalysisResult, analysisText, AUTOFILL_SCHEMA, AUTOFILL_SYSTEM, type AutofillResult, autofillText, avatarBackPrompt, avatarFrontPrompt, catalogPrompt, DETECT_SCHEMA, DETECT_SYSTEM, type DetectResult, detectText, FACE_SCHEMA, FACE_SYSTEM, FACE_TEXT, type FaceResult, FIDELITY_SCHEMA, FIDELITY_SYSTEM, type FidelityResult, fidelityText, type GarmentFields, makeupPrompt, MIRROR_SCHEMA, MIRROR_SYSTEM, type MirrorResult, mirrorText, OUTFIT_SCHEMA, OUTFIT_SYSTEM, type OutfitResult, outfitText, photoPrompt, SCENES, STYLE_REF_NOTE, tryonBackPrompt, tryonPrompt } from './prompts';

export interface AiDeps {
  db: Db;
  images: ImageStore;
  /** A client for one of the user's keys; null when its secret is missing from secure storage. */
  clientFor(key: KeyEntry): Promise<OpenAiClient | null>;
  now?: () => Date;
}

const PROBE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Throws `cap` if this month's spend already reached the user's limit. */
export async function assertBudget(deps: AiDeps): Promise<void> {
  const [{ capUsd }, spend] = await Promise.all([getAiSettings(deps.db), monthSpend(deps.db, deps.now?.() ?? new Date())]);
  if (capUsd > 0 && spend.totalUsd >= capUsd) throw new AiError('cap', `spend ${spend.totalUsd} >= cap ${capUsd}`);
}

/**
 * Model lists older than a few days are read again: models get added, removed or re-enabled, and a model blocked
 * after a transient error gets another chance (verification clears the blocks).
 */
async function freshKeys(deps: AiDeps): Promise<KeyEntry[]> {
  const now = deps.now?.() ?? new Date();
  const keys = await listKeys(deps.db);
  const stale = keys.filter((k) => k.verifiedAt && now.getTime() - new Date(k.verifiedAt).getTime() >= PROBE_TTL_MS);
  if (stale.length === 0) return keys;
  for (const k of stale) {
    try {
      const client = await deps.clientFor(k);
      if (client) await markVerified(deps.db, k.id, await probeModels(k.provider, client), now.toISOString());
    } catch {
      // Offline or a key problem: keep the old list; the request itself reports what is wrong.
    }
  }
  return listKeys(deps.db);
}

/**
 * Runs `fn` with the key and model a purpose uses. Every request carries the user's photos, so nothing goes to a
 * provider the user has not agreed to. A model that turns out to be unavailable is blocked for that key and the next
 * one tried, so a deprecated model never strands the user.
 */
/** `override`: a model picked for this one request (the regenerate panel); it falls back like a saved choice. */
async function withRoute<T>(deps: AiDeps, purpose: Purpose, fn: (client: OpenAiClient, r: Resolved) => Promise<T>, override?: Route): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const keys = await freshKeys(deps);
    const routes = await getRoutes(deps.db);
    const r = resolveRoute(purpose, override ? { ...routes, [purpose]: override } : routes, keys);
    if (!r) throw new AiError('no_key', keys.length ? `no key can do ${purpose}` : 'missing api key');
    const client = await deps.clientFor(keys.find((k) => k.id === r.keyId)!);
    if (!client) throw new AiError('no_key', 'key secret missing');
    if (!(await hasConsentFor(deps.db, r.provider))) throw new AiError('consent', `photo consent not given for ${r.provider}`);
    await assertBudget(deps);
    try {
      return await fn(client, r);
    } catch (e) {
      if (!(e instanceof AiError) || e.kind !== 'model') throw e;
      await blockModelForKey(deps.db, r.keyId, r.model);
    }
  }
  throw new AiError('model', `no working model for ${purpose}`);
}

async function generate(
  deps: AiDeps,
  kind: 'catalog' | 'avatar' | 'tryon' | 'photo',
  req: {
    prompt: string;
    images: string[];
    quality: 'low' | 'medium' | 'high';
    n?: number;
    transparent?: boolean;
    /** An existing catalog image, sent to Gemini only (see below). */
    styleRef?: () => Promise<string | null>;
    route?: Route;
  },
): Promise<string[]> {
  return withRoute(deps, kind, async (client, r) => {
    let { prompt, images } = req;
    // Each provider draws in its own style; a Gemini catalog image takes the look of the ones already in the wardrobe.
    const ref = r.provider === 'gemini' && req.styleRef ? await req.styleRef() : null;
    if (ref) {
      prompt = `${prompt} ${STYLE_REF_NOTE}`;
      images = [...images, ref];
    }
    const quality = modelInfo(r.provider, r.model)?.quality ? req.quality : undefined;
    const res = await client.imageEdit({ model: r.model, prompt, images, quality, n: req.n, size: '1024x1536', transparent: req.transparent });
    // Unknown prices count as 0: they are not held against the cap (the settings page says so).
    await addUsage(deps.db, { kind, model: r.model, costUsd: callCost(r.provider, r.model, res.usage) ?? 0 });
    return res.images;
  }, req.route);
}

async function vision<T>(
  deps: AiDeps,
  kind: Job['type'] | 'photo',
  req: { system: string; text: string; images: string[]; schemaName: string; schema: Record<string, unknown>; detail?: 'low' | 'high' | 'auto' },
  purpose: 'vision' | 'analysis' = 'vision',
): Promise<T> {
  return withRoute(deps, purpose, async (client, r) => {
    const res = await client.visionJson<T>({ model: r.model, ...req });
    await addUsage(deps.db, { kind, model: r.model, costUsd: callCost(r.provider, r.model, res.usage) ?? 0 });
    return res.data;
  });
}

// ---------- autofill ----------

const AUTO_FIELDS = ['name', 'slot', 'subcategory', 'colorName', 'colorHex', 'seasons', 'brand', 'size', 'material'] as const;

/** Applies AI results without overwriting anything the user typed. Exported for tests. */
export function applyAutofill(item: Item, r: GarmentFields): Partial<Item> {
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

const validHex = (v: string | null) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);

/** Garments with a usable box, most prominent first; specks under 0.5% of the photo are dropped as misreads. */
function garmentsOf(r: DetectResult): (GarmentFields & { box: Box })[] {
  return tidyGarments(
    (r.garments ?? []).flatMap((g) => {
      const box = fromBox2d(g.box_2d);
      return box && boxArea(box) >= 0.005 ? [{ ...g, box }] : [];
    }),
  );
}

function toDetection(g: GarmentFields & { box: Box }): Detection {
  const { box, name, slot, subcategory, colorName, colorHex, seasons, brand, size, material, printText } = g;
  // Padded here so the box the user sees in the picker is exactly what will be cut.
  return { box: padBox(box), selected: false, manual: false, edited: false, name, slot, subcategory, colorName, colorHex: validHex(colorHex), seasons, brand, size, material, printText };
}

// ---------- job handlers ----------

async function runCatalog(deps: AiDeps, startJob: Job): Promise<void> {
  let job = startJob;
  const { db, images } = deps;
  let item = await getItem(db, job.refId);
  if (!item || !item.originalUri) return; // deleted meanwhile
  // The photo was replaced after this job first ran: the newer job owns the item now, and anything this one
  // generated shows the old photo.
  const photo = job.payload.photo as string | undefined;
  if ((photo && photo !== item.originalUri) || (await hasNewerJob(db, job))) {
    for (const u of (job.payload.generated as string[] | undefined) ?? []) await images.remove(u);
    return;
  }
  if (!photo) {
    job = { ...job, payload: { ...job.payload, photo: item.originalUri } };
    await updateJobPayload(db, job.id, job.payload);
  }
  const settings = await getAiSettings(db);
  let original = await images.toDataUrl(item.originalUri, 1024);
  // From the picker (the photo was recognised as a whole) or from the recognition below.
  let printText = (job.payload.printText as string | undefined) ?? null;

  const startStatus = item.status;
  let startPhoto = item.originalUri;
  // 'skip': the fields are known (a garment picked from a photo, or a regeneration). 'crop': the user drew this box,
  // so recognise just what is in it. Otherwise find every garment on the photo.
  const autofill = (job.payload.autofill as string | undefined) ?? (job.payload.regenerate ? 'skip' : 'detect');
  if (autofill !== 'skip') {
    const tag = item.tagUri ? await images.toDataUrl(item.tagUri, 1024) : null;
    const input = tag ? [original, tag] : [original];
    let fields: GarmentFields | null = null;
    let box: Box | null = null;
    let several: Detection[] | null = null;
    if (autofill === 'crop') {
      fields = await vision<AutofillResult>(deps, 'catalog', {
        system: AUTOFILL_SYSTEM,
        text: autofillText(!!tag),
        images: input,
        schemaName: 'garment',
        schema: AUTOFILL_SCHEMA as unknown as Record<string, unknown>,
        detail: 'high',
      });
    } else {
      const found = garmentsOf(
        await vision<DetectResult>(deps, 'catalog', {
          system: DETECT_SYSTEM,
          text: detectText(!!tag),
          images: input,
          schemaName: 'detect',
          schema: DETECT_SCHEMA as unknown as Record<string, unknown>,
          detail: 'high',
        }),
      );
      // A garment already in the wardrobe getting a new photo, or one shot with its tag, is one known garment.
      const oneGarment = startStatus === 'active' || startStatus === 'archived' || !!tag;
      const slot = item.slot;
      if (found.length > 1 && !oneGarment) several = found.map(toDetection);
      else if (found.length) {
        const g = found.find((x) => x.slot === slot && oneGarment) ?? found.reduce((a, b) => (boxArea(b.box) > boxArea(a.box) ? b : a));
        fields = g;
        box = g.box;
      }
      // Nothing found: carry on with the whole photo, as before boxes existed.
    }
    // Re-read: the user may have typed fields, settled or deleted the item while the model was thinking.
    const now = await getItem(db, item.id);
    if (!now || now.status !== startStatus) return;
    if (several) {
      // Nothing is generated until the user picks garments, so nothing is paid for the ones they do not want.
      await updateItem(db, item.id, { status: 'pick', detections: several, error: null });
      return;
    }
    item = fields ? (await updateItem(db, item.id, applyAutofill(now, fields)))! : now;
    if (fields) printText = fields.printText ?? printText;
    const padded = box && padBox(box);
    // A garment filling most of the photo gains nothing from a crop.
    if (padded && boxArea(padded) < 0.8) {
      const source = item.originalUri!;
      const cropUri = await images.crop(source, padded, 'original');
      const id = item.id;
      const payload = { ...job.payload, photo: cropUri };
      // Together, so a crash in between does not look like the user replacing the photo.
      await db.withTransactionAsync(async (tx) => {
        await updateJobPayload(tx, job.id, payload);
        await updateItem(tx, id, { sourceUri: source, crop: padded, originalUri: cropUri });
      });
      job = { ...job, payload };
      item = (await getItem(db, id))!;
      original = await images.toDataUrl(cropUri, 1024);
      startPhoto = cropUri;
    }
  }

  // A retry after a crash reuses the candidates that were already paid for.
  let uris = (job.payload.generated as string[] | undefined) ?? [];
  if (uris.length === 0) {
    // Everything the photo shows, in words: image models redraw a garment as new unless told what to keep, and a
    // vision model that sees wear (the analysis route, not nano) describes it better than the image model reads it.
    const analysis = await vision<AnalysisResult>(deps, 'catalog', { system: ANALYSIS_SYSTEM, text: analysisText(item.slot), images: [original], schemaName: 'analysis', schema: ANALYSIS_SCHEMA, detail: 'high' }, 'analysis');
    const b64s = await generate(deps, 'catalog', {
      prompt: catalogPrompt(item.slot, item.name, { name: item.colorName, hex: item.colorHex }, job.payload.hint as string | undefined, printText, analysis),
      images: [original],
      quality: (job.payload.quality as 'low' | 'medium' | 'high' | undefined) ?? catalogQuality(settings),
      route: job.payload.model as Route | undefined,
      n: Math.max(1, Math.min(3, settings.candidates)),
      // Opaque on purpose: transparent cut-outs look perfect, but image models read transparent pixels as black,
      // so dark garments vanish when they are fed back in for try-ons (verified with black jeans).
      styleRef: async () => {
        const ref = (await listItems(db, ['active'])).find((x) => x.id !== item.id && x.catalogUri);
        return ref ? images.toDataUrl(ref.catalogUri!, 768) : null;
      },
    });
    for (const b64 of b64s) uris.push(await images.saveBase64(b64, 'catalog'));
    await updateJobPayload(db, job.id, { ...job.payload, generated: uris });
  }

  // The checklist helps the user choose; if it fails the candidates are still usable.
  let checks: Item['checks'] = [];
  try {
    const thumbs = await Promise.all(uris.map((u) => images.toDataUrl(u, 768)));
    const r = await vision<FidelityResult>(deps, 'catalog', {
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
  // The candidate with the fewest failed checks goes first: that is the one the review screen preselects.
  const fails = (i: number) => (checks[i] ?? []).filter((c) => !c.ok).length;
  const order = uris.map((_, i) => i).sort((a, b) => fails(a) - fails(b));
  uris = order.map((i) => uris[i]);
  checks = order.map((i) => checks[i] ?? []);

  const fresh = await getItem(db, item.id);
  // A first-time item the user deleted or settled ("只存原图") meanwhile: drop the results.
  const inWardrobe = (st: Item['status']) => st === 'active' || st === 'archived';
  // ...or replaced the photo, in which case a newer job regenerates from the new one.
  const settled = !fresh || fresh.originalUri !== startPhoto || (!inWardrobe(startStatus) && inWardrobe(fresh.status));
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
  const settings = await getAiSettings(db);
  const quality = qualityFor(settings.quality, 'avatar');
  const sources = await Promise.all(avatar.sourceUris.map((u) => images.toDataUrl(u, 1024)));

  // The front costs most; if the back failed last time, continue from the front already generated.
  let frontUri = job.payload.front as string | undefined;
  if (!frontUri) {
    const [front] = await generate(deps, 'avatar', { prompt: avatarFrontPrompt(avatar), images: sources, quality });
    frontUri = await images.saveBase64(front, 'avatar');
    await updateJobPayload(deps.db, job.id, { ...job.payload, front: frontUri });
  }
  const frontRef = await images.toDataUrl(frontUri, 1024);
  // The third body photo is the back view when the user took all three.
  const backRef = sources.length >= 3 ? [sources[2]] : [];
  const [back] = await generate(deps, 'avatar', { prompt: avatarBackPrompt(), images: [frontRef, ...backRef], quality });
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

/** Feet up; tops and outerwear form one band that keeps the given order (innermost layer first). */
const BAND: Record<Slot, number> = { shoes: 0, bottom: 1, top: 2, outer: 2, bag: 3, accessory: 4 };

async function orderedGarments(db: Db, itemIds: string[]): Promise<Item[]> {
  // Items without any picture (Excel imports) cannot be drawn on the avatar.
  const items = (await Promise.all(itemIds.map((id) => getItem(db, id)))).filter((x): x is Item => !!x && !!(x.catalogUri ?? x.originalUri));
  return items.sort((a, b) => BAND[a.slot] - BAND[b.slot]);
}

/** How many times the makeup is redrawn when the face no longer looks like the user. */
const MAKEUP_TRIES = 2;
const OUTFIT_TRIES = 2;

/**
 * Draws an outfit picture with `draw`, has a vision model compare it with the garments, and draws once more naming
 * what went wrong (a cropped head, trousers turned into shorts). The check is a convenience: if it fails, the
 * picture is kept as drawn.
 */
async function drawChecked(deps: AiDeps, kind: 'tryon' | 'photo', garments: Item[], refs: string[], draw: (fix: string | null) => Promise<string>): Promise<string> {
  let fix: string | null = null;
  // The redraw can come out worse than the first drawing (a redraw turned jeans into shorts): keep the better one.
  let best: { b64: string; problems: number } | null = null;
  for (let i = 0; i < OUTFIT_TRIES; i++) {
    const b64 = await draw(fix);
    let r: OutfitResult;
    try {
      const ext = imageExt(b64);
      r = await vision<OutfitResult>(deps, kind, {
        system: OUTFIT_SYSTEM,
        text: outfitText(garments.map((g) => ({ slot: g.slot, name: g.name, color: g.colorName }))),
        images: [`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64}`, ...refs],
        schemaName: 'outfit',
        schema: OUTFIT_SCHEMA as unknown as Record<string, unknown>,
      });
    } catch {
      return best?.b64 ?? b64;
    }
    const problems = r.problems.length + (r.fullBody ? 0 : 1);
    if (!best || problems < best.problems) best = { b64, problems };
    if (problems === 0) break;
    fix = [...(r.fullBody ? [] : ['the head or the feet were cut off']), ...r.problems].join('; ');
  }
  return best!.b64;
}

async function runTryon(deps: AiDeps, job: Job): Promise<void> {
  const { db, images } = deps;
  const [key, view] = job.refId.split('|') as [string, 'front' | 'back'];
  const itemIds = (job.payload.itemIds as string[] | undefined) ?? idsOfKey(key);
  const styling = (job.payload.styling as Record<string, Styling> | undefined) ?? {};
  // Drawn on the front only (actions drop it for the back).
  const makeup = view === 'front' ? (job.payload.makeup as string | undefined) : undefined;
  const hint = job.payload.hint as string | undefined;
  const route = job.payload.model as Route | undefined;
  const avatar = await getAvatar(db);
  if (!avatarUsable(avatar) || !avatar.frontUri || (view === 'back' && !avatar.backUri)) throw new AiError('rejected', 'avatar not ready');
  const garments = await orderedGarments(db, itemIds);
  if (garments.length === 0 && !makeup) return;
  const look = (gs: Item[]) => gs.map((g) => `${g.id}:${g.slot}:${g.catalogUri ?? g.originalUri}`).join('|');
  const startLook = look(garments);
  const worn = garments.map((g) => ({ slot: g.slot, styling: styling[g.id] }));
  const version = avatarVersion(avatar);
  const quality = (job.payload.quality as 'low' | 'medium' | 'high' | undefined) ?? tryonQuality(await getAiSettings(db));
  const plainKey = withoutMakeupKey(key);

  /** Caches a result under `k`, unless a garment was deleted, re-pictured or moved to another slot meanwhile. */
  const store = async (k: string, v: 'front' | 'back', b64: string): Promise<string | null> => {
    const uri = await images.saveBase64(b64, 'tryon');
    // ...or the avatar was re-created meanwhile (the result shows the old one and would never be displayed).
    if (look(await orderedGarments(db, itemIds)) !== startLook || avatarVersion(await getAvatar(db)) !== version) {
      await images.remove(uri);
      return null;
    }
    const old = await getTryon(db, k, v, version);
    await putTryon(db, k, v, version, uri);
    if (old && old !== uri) {
      await images.remove(old);
      // The back was turned from the old front; it no longer matches.
      if (v === 'front') {
        const back = await getTryon(db, k, 'back', version);
        if (back) {
          await deleteTryon(db, k, 'back');
          await images.remove(back);
        }
      }
    }
    return uri;
  };

  // The back and the made-up front are drawn from the front without makeup, so they first need (and cache) it.
  // With makeup and nothing worn, that is the avatar itself.
  let front = view === 'back' || makeup ? (garments.length ? await getTryon(db, plainKey, 'front', version) : avatar.frontUri) : null;
  if (!front) {
    const refs = await Promise.all(garments.map((g) => images.toDataUrl((g.catalogUri ?? g.originalUri)!, 768)));
    const base = await images.toDataUrl(avatar.frontUri, 1024);
    const b64 = await drawChecked(deps, 'tryon', garments, refs, async (fix) => (await generate(deps, 'tryon', { prompt: tryonPrompt(worn, hint, fix), images: [base, ...refs], quality, route }))[0]);
    front = await store(plainKey, 'front', b64);
    if (!front || (view === 'front' && !makeup)) return;
  }
  if (makeup) {
    const b64 = await drawMakeup(deps, { base: front, own: avatar.frontUri, makeup, dressed: garments.length > 0, hint, quality, route });
    await store(key, 'front', b64);
    return;
  }
  const [b64] = await generate(deps, 'tryon', {
    prompt: tryonBackPrompt(garments, hint),
    images: [await images.toDataUrl(avatar.backUri!, 1024), await images.toDataUrl(front, 1024)],
    quality,
    route,
  });
  await store(key, 'back', b64);
}

/**
 * Makeup as an edit of `base`, checked by a vision model against the user's own face (`own`, the avatar) and
 * redrawn once if it looks like someone else. Image models tend to "beautify" a face into another one.
 */
async function drawMakeup(
  deps: AiDeps,
  req: { base: string; own: string; makeup: string; dressed: boolean; hint?: string; quality: 'low' | 'medium' | 'high'; route?: Route },
): Promise<string> {
  const { images } = deps;
  const own = await images.toDataUrl(req.own, 1024);
  const base = req.dressed ? await images.toDataUrl(req.base, 1024) : own;
  for (let i = 0; i < MAKEUP_TRIES; i++) {
    const [b64] = await generate(deps, 'tryon', {
      prompt: makeupPrompt(makeupPromptText(req.makeup), req.dressed, req.hint),
      images: req.dressed ? [base, own] : [own],
      quality: req.quality,
      route: req.route,
    });
    const ext = imageExt(b64);
    const check = await vision<FaceResult>(deps, 'tryon', {
      system: FACE_SYSTEM,
      text: FACE_TEXT,
      images: [own, `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64}`],
      detail: 'high',
      schemaName: 'face_check',
      schema: FACE_SCHEMA,
    });
    if (check.samePerson) return b64;
  }
  throw new Error('化妆后看起来不像你了，这次没有保存，可以再试一次');
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

/**
 * The garments shown to the model next to a mirror photo (it can only take so many). Every category gets a share,
 * and within one the most-worn, most recently worn and newest garments take turns, so new clothes are recognised too.
 */
export function pickMirrorCandidates(items: Item[], wear: Map<string, { n: number; last: string }>, max: number): Item[] {
  if (items.length <= max) return items;
  const bySlot = new Map<Slot, Item[]>();
  for (const it of items) bySlot.set(it.slot, [...(bySlot.get(it.slot) ?? []), it]);
  const quota = new Map<Slot, number>();
  for (const [slot, xs] of bySlot) quota.set(slot, Math.min(xs.length, Math.max(4, Math.floor((xs.length / items.length) * max))));
  // Trim the largest shares until the total fits.
  let total = [...quota.values()].reduce((a, b) => a + b, 0);
  while (total > max) {
    const [slot, q] = [...quota.entries()].sort((a, b) => b[1] - a[1])[0];
    quota.set(slot, q - 1);
    total -= 1;
  }
  const out: Item[] = [];
  for (const [slot, xs] of bySlot) {
    const orders = [
      [...xs].sort((a, b) => (wear.get(b.id)?.n ?? 0) - (wear.get(a.id)?.n ?? 0)),
      [...xs].sort((a, b) => (wear.get(b.id)?.last ?? '').localeCompare(wear.get(a.id)?.last ?? '')),
      [...xs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    ];
    const chosen = new Set<string>();
    for (let k = 0; chosen.size < quota.get(slot)!; k++) {
      const next = orders[k % 3].find((x) => !chosen.has(x.id));
      if (next) chosen.add(next.id);
    }
    out.push(...xs.filter((x) => chosen.has(x.id)));
  }
  return out;
}

export async function matchMirror(deps: AiDeps, photoUri: string): Promise<{ matches: MirrorMatch[]; unmatched: string[] }> {
  await assertBudget(deps);
  const rows = await deps.db.getAllAsync<{ item_id: string; n: number; last: string }>(
    'SELECT li.item_id, COUNT(*) AS n, MAX(l.date) AS last FROM wear_log_items li JOIN wear_logs l ON l.id = li.log_id GROUP BY li.item_id',
  );
  const wear = new Map(rows.map((r) => [r.item_id, { n: r.n, last: r.last }]));
  const items = pickMirrorCandidates(
    (await listItems(deps.db, ['active'])).filter((i) => i.catalogUri || i.originalUri),
    wear,
    MIRROR_MAX_ITEMS,
  );
  if (items.length === 0) return { matches: [], unmatched: [] };
  // The decoder limits itself to a few images at a time.
  const refs = await Promise.all(items.map((i) => deps.images.toDataUrl((i.catalogUri ?? i.originalUri)!, 256)));
  const r = await vision<MirrorResult>(deps, 'mirror', {
    system: MIRROR_SYSTEM,
    text: mirrorText(items.map((i, k) => ({ index: k + 1, name: i.name, slot: i.slot, color: i.colorName }))),
    images: [await deps.images.toDataUrl(photoUri, 1024), ...refs],
    schemaName: 'mirror',
    schema: MIRROR_SCHEMA as unknown as Record<string, unknown>,
    detail: 'auto',
  });
  // Best match per category (several accessories may be worn together).
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const seenSlots = new Set<Slot>();
  const matches: MirrorMatch[] = [];
  for (const m of [...r.matches].sort((a, b) => rank[a.confidence] - rank[b.confidence])) {
    const it = items[m.index - 1];
    if (!it || matches.some((x) => x.itemId === it.id) || (it.slot !== 'accessory' && seenSlots.has(it.slot))) continue;
    seenSlots.add(it.slot);
    matches.push({ itemId: it.id, confidence: m.confidence, note: m.note.trim() });
  }
  return { matches, unmatched: r.unmatched };
}

export async function generatePhoto(deps: AiDeps, itemIds: string[], sceneId: string, styling: Record<string, Styling> = {}, makeup?: string | null): Promise<string> {
  await assertBudget(deps);
  const avatar = await getAvatar(deps.db);
  if (!avatarUsable(avatar) || !avatar.frontUri) throw new AiError('rejected', 'avatar not ready');
  const scene = SCENES.find((s) => s.id === sceneId) ?? SCENES[0];
  const garments = await orderedGarments(deps.db, itemIds);
  if (garments.length === 0) throw new AiError('rejected', 'no garment images');
  const settings = await getAiSettings(deps.db);
  const refs = await Promise.all(garments.map((g) => deps.images.toDataUrl((g.catalogUri ?? g.originalUri)!, 768)));
  // The front try-on, if the fitting room made one, already has the outfit right; then only the scene changes.
  const version = avatarVersion(avatar);
  const key = lookKey(itemIds, styling, (id) => garments.find((g) => g.id === id)?.slot ?? 'top', makeup);
  const madeUp = makeup ? await getTryon(deps.db, key, 'front', version) : null;
  const front = madeUp ?? (await getTryon(deps.db, withoutMakeupKey(key), 'front', version));
  const base = await deps.images.toDataUrl(front ?? avatar.frontUri, 1024);
  const worn = garments.map((g) => ({ slot: g.slot, styling: styling[g.id] }));
  const makeupLine = makeup && !madeUp ? makeupPromptText(makeup) : null;
  const b64 = await drawChecked(deps, 'photo', garments, refs, async (fix) => (await generate(deps, 'photo', { prompt: photoPrompt(worn, scene, makeupLine, { dressed: !!front, fix }), images: [base, ...refs], quality: qualityFor(settings.quality, 'photo') }))[0]);
  return deps.images.saveBase64(b64, 'photo');
}
