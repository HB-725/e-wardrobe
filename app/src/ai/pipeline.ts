import type { Db } from '@/db/db';
import { enqueueJob } from '@/db/jobs';
import { getItem, updateItem } from '@/db/items';
import { addUsage, avatarVersion, getAvatar, putTryon, saveAvatar } from '@/db/misc';
import { isSlot } from '@/domain/catalog';
import type { FieldSource, Item, Job, JobType, Slot } from '@/domain/types';
import { estimateCostUsd, type ModelChoice, supportsInputFidelity } from './models';
import { type ContentPart, type ImageInput, OpenAIError, type TokenUsage } from './openai';
import {
  AUTOFILL_SCHEMA,
  AUTOFILL_SYSTEM,
  type AutofillResult,
  avatarPrompt,
  catalogPrompt,
  FIDELITY_SCHEMA,
  FIDELITY_SYSTEM,
  type FidelityResult,
  MIRROR_SCHEMA,
  MIRROR_SYSTEM,
  type MirrorResult,
  tryonPrompt,
} from './prompts';

/** What the pipeline needs from the OpenAI client (a fake implements this in tests). */
export interface AiClient {
  chatJson<T>(args: {
    model: string;
    system: string;
    content: ContentPart[];
    schemaName: string;
    schema: Record<string, unknown>;
    maxTokens?: number;
  }): Promise<{ data: T; usage: TokenUsage }>;
  editImage(args: {
    model: string;
    prompt: string;
    images: ImageInput[];
    size: '1024x1024' | '1024x1536' | '1536x1024';
    quality: 'low' | 'medium' | 'high';
    outputFormat?: 'png' | 'jpeg' | 'webp';
    inputFidelity?: 'low' | 'high';
  }): Promise<{ b64: string; usage: TokenUsage }>;
}

export interface FileOps {
  readBase64(uri: string): Promise<string>;
  saveBase64Image(b64: string, ext?: 'jpg' | 'png'): string;
  imageInput(uri: string): ImageInput;
  deleteImage(uri: string | null | undefined): void;
}

export interface AiDeps {
  db: Db;
  client: AiClient;
  models: ModelChoice;
  files: FileOps;
}

/** Errors that will not fix themselves by retrying (bad input, missing data). */
export class PermanentError extends Error {}

async function record(deps: AiDeps, kind: JobType, model: string, usage: TokenUsage): Promise<void> {
  await addUsage(deps.db, { kind, model, costUsd: estimateCostUsd(model, usage) });
}

async function dataUrl(deps: AiDeps, uri: string): Promise<string> {
  return `data:image/jpeg;base64,${await deps.files.readBase64(uri)}`;
}

async function requireItem(deps: AiDeps, id: string): Promise<Item> {
  const item = await getItem(deps.db, id);
  if (!item) throw new PermanentError('这件单品已被删除');
  if (!item.originalUri) throw new PermanentError('缺少原始照片');
  return item;
}

// ---------- autofill ----------

const AUTOFILL_FIELDS: { key: keyof Item; from: keyof AutofillResult; tagField?: boolean }[] = [
  { key: 'name', from: 'name' },
  { key: 'slot', from: 'slot' },
  { key: 'subcategory', from: 'subcategory' },
  { key: 'colorName', from: 'color_name' },
  { key: 'colorHex', from: 'color_hex' },
  { key: 'seasons', from: 'seasons' },
  { key: 'brand', from: 'brand', tagField: true },
  { key: 'size', from: 'size', tagField: true },
  { key: 'material', from: 'material', tagField: true },
];

/** Merge AI results without overwriting anything the user typed. */
export function mergeAutofill(item: Item, r: AutofillResult, hasTag: boolean): Partial<Item> {
  const patch: Partial<Item> = {};
  const sources: Partial<Record<keyof Item, FieldSource>> = { ...item.fieldSources };
  for (const f of AUTOFILL_FIELDS) {
    if (item.fieldSources[f.key] === 'user') continue;
    const value = r[f.from];
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (f.key === 'slot' && !isSlot(value)) continue;
    if (f.key === 'colorHex' && !/^#[0-9a-fA-F]{6}$/.test(String(value))) continue;
    (patch as Record<string, unknown>)[f.key] = value;
    sources[f.key] = f.tagField && hasTag ? 'tag' : 'ai';
  }
  patch.fieldSources = sources;
  return patch;
}

export async function runAutofill(deps: AiDeps, job: Job): Promise<void> {
  const item = await requireItem(deps, job.refId);
  const content: ContentPart[] = [
    { type: 'text', text: '第一张是衣服照片' + (item.tagUri ? '，第二张是吊牌或洗标照片。' : '。') },
    { type: 'image_url', image_url: { url: await dataUrl(deps, item.originalUri!), detail: 'low' } },
  ];
  if (item.tagUri) content.push({ type: 'image_url', image_url: { url: await dataUrl(deps, item.tagUri), detail: 'high' } });
  const { data, usage } = await deps.client.chatJson<AutofillResult>({
    model: deps.models.vision,
    system: AUTOFILL_SYSTEM,
    content,
    schemaName: 'garment',
    schema: AUTOFILL_SCHEMA as unknown as Record<string, unknown>,
  });
  await record(deps, 'autofill', deps.models.vision, usage);
  const fresh = (await getItem(deps.db, item.id)) ?? item;
  if (!data.is_clothing) {
    await updateItem(deps.db, item.id, { status: 'failed', error: '照片里好像不是衣服、鞋或包，请换一张' });
    return;
  }
  await updateItem(deps.db, item.id, mergeAutofill(fresh, data, !!item.tagUri));
  await enqueueJob(deps.db, 'catalog', item.id);
}

// ---------- catalog image ----------

export async function runCatalog(deps: AiDeps, job: Job): Promise<void> {
  const item = await requireItem(deps, job.refId);
  const model = deps.models.image;
  const gen = await deps.client.editImage({
    model,
    prompt: catalogPrompt(isSlot(item.slot) ? item.slot : null),
    images: [deps.files.imageInput(item.originalUri!)],
    size: '1024x1024',
    quality: 'medium',
    outputFormat: 'jpeg',
    inputFidelity: supportsInputFidelity(model) ? 'high' : undefined,
  });
  await record(deps, 'catalog', model, gen.usage);
  const uri = deps.files.saveBase64Image(gen.b64, 'jpg');

  let fidelity: Item['fidelity'] = null;
  try {
    const check = await deps.client.chatJson<FidelityResult>({
      model: deps.models.vision,
      system: FIDELITY_SYSTEM,
      content: [
        { type: 'image_url', image_url: { url: await dataUrl(deps, item.originalUri!), detail: 'low' } },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${gen.b64}`, detail: 'low' } },
      ],
      schemaName: 'fidelity',
      schema: FIDELITY_SCHEMA as unknown as Record<string, unknown>,
    });
    await record(deps, 'catalog', deps.models.vision, check.usage);
    fidelity = { sameItem: check.data.same_item, checks: check.data.checks };
  } catch {
    // The check is advisory; the user still compares the two images on the review screen.
  }

  const latest = await getItem(deps.db, item.id);
  if (!latest) {
    deps.files.deleteImage(uri);
    return;
  }
  if (latest.catalogUri && latest.catalogUri !== uri) deps.files.deleteImage(latest.catalogUri);
  // Items already in the wardrobe keep their status when regenerated; new ones wait for review.
  const status = latest.status === 'active' ? 'active' : 'review';
  await updateItem(deps.db, item.id, { catalogUri: uri, fidelity, status, error: null });
}

// ---------- avatar ----------

export async function runAvatar(deps: AiDeps, job: Job): Promise<void> {
  const avatar = await getAvatar(deps.db);
  const view = job.payload.view === 'back' ? 'back' : 'front';
  const model = deps.models.image;
  let images: ImageInput[];
  let prompt: string;
  if (view === 'front') {
    if (avatar.sourceUris.length === 0) throw new PermanentError('缺少全身照');
    images = avatar.sourceUris.map((u) => deps.files.imageInput(u));
    prompt = avatarPrompt({ ...avatar, photoCount: images.length });
  } else {
    if (!avatar.frontUri) throw new PermanentError('请先生成正面形象');
    images = [deps.files.imageInput(avatar.frontUri)];
    prompt =
      'Image 1 shows a person in a studio. Create the same photo of the same person seen from directly behind (back view): same body, hair, clothes, framing, lighting and light gray background. Entire body from head to feet visible.';
  }
  const gen = await deps.client.editImage({
    model,
    prompt,
    images,
    size: '1024x1536',
    quality: 'medium',
    outputFormat: 'jpeg',
    inputFidelity: supportsInputFidelity(model) ? 'high' : undefined,
  });
  await record(deps, 'avatar', model, gen.usage);
  const uri = deps.files.saveBase64Image(gen.b64, 'jpg');
  const latest = await getAvatar(deps.db);
  if (view === 'front') {
    deps.files.deleteImage(latest.frontUri);
    deps.files.deleteImage(latest.backUri);
    await saveAvatar(deps.db, { frontUri: uri, backUri: null, status: 'ready', error: null });
  } else {
    deps.files.deleteImage(latest.backUri);
    await saveAvatar(deps.db, { backUri: uri });
  }
}

// ---------- try-on ----------

export async function runTryon(deps: AiDeps, job: Job): Promise<void> {
  const avatar = await getAvatar(deps.db);
  if (avatar.status !== 'ready' || !avatar.frontUri) throw new PermanentError('请先建立个人形象');
  const itemIds = (job.payload.itemIds as string[] | undefined) ?? [];
  const view = job.payload.view === 'back' ? 'back' : 'front';
  const key = String(job.payload.key ?? job.refId);
  const items: Item[] = [];
  for (const id of itemIds) {
    const it = await getItem(deps.db, id);
    if (it && (it.catalogUri || it.originalUri)) items.push(it);
  }
  if (items.length === 0) throw new PermanentError('这套穿搭里没有可用的单品');
  const model = deps.models.image;
  const gen = await deps.client.editImage({
    model,
    prompt: tryonPrompt(items.map((i) => ({ slot: i.slot, name: i.name })), view),
    images: [
      deps.files.imageInput(view === 'back' && avatar.backUri ? avatar.backUri : avatar.frontUri),
      ...items.map((i) => deps.files.imageInput((i.catalogUri ?? i.originalUri)!)),
    ],
    size: '1024x1536',
    quality: 'medium',
    outputFormat: 'jpeg',
    inputFidelity: supportsInputFidelity(model) ? 'high' : undefined,
  });
  await record(deps, 'tryon', model, gen.usage);
  const uri = deps.files.saveBase64Image(gen.b64, 'jpg');
  await putTryon(deps.db, key, view, avatarVersion(avatar), uri);
}

// ---------- mirror (interactive, not queued) ----------

export interface MirrorMatch {
  itemId: string;
  confidence: number;
  fitNote: string | null;
}

/** Keeps only known ids, at most one per slot (highest confidence), above a floor. */
export function cleanMirrorResult(
  r: MirrorResult,
  items: Pick<Item, 'id' | 'slot'>[],
  minConfidence = 0.5,
): { matches: MirrorMatch[]; unmatched: string[] } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const notes = new Map(r.fit_notes.map((n) => [n.id, n.note]));
  const bestBySlot = new Map<Slot, MirrorMatch>();
  for (const m of r.matches) {
    const it = byId.get(m.id);
    if (!it || m.confidence < minConfidence) continue;
    const prev = bestBySlot.get(it.slot);
    if (!prev || m.confidence > prev.confidence) {
      bestBySlot.set(it.slot, { itemId: m.id, confidence: m.confidence, fitNote: notes.get(m.id) ?? null });
    }
  }
  return { matches: [...bestBySlot.values()], unmatched: r.unmatched };
}

export async function identifyFromMirror(
  deps: AiDeps,
  photoUri: string,
  items: Item[],
): Promise<{ matches: MirrorMatch[]; unmatched: string[] }> {
  const catalog = items.map((i) => ({ id: i.id, name: i.name, slot: i.slot, color: i.colorName, subcategory: i.subcategory }));
  const { data, usage } = await deps.client.chatJson<MirrorResult>({
    model: deps.models.vision,
    system: MIRROR_SYSTEM,
    content: [
      { type: 'text', text: `衣橱清单：${JSON.stringify(catalog)}` },
      { type: 'image_url', image_url: { url: await dataUrl(deps, photoUri), detail: 'high' } },
    ],
    schemaName: 'mirror',
    schema: MIRROR_SCHEMA as unknown as Record<string, unknown>,
  });
  await record(deps, 'mirror', deps.models.vision, usage);
  return cleanMirrorResult(data, items);
}

// ---------- dispatch + failure bookkeeping ----------

export async function runJob(deps: AiDeps, job: Job): Promise<void> {
  switch (job.type) {
    case 'autofill':
      return runAutofill(deps, job);
    case 'catalog':
      return runCatalog(deps, job);
    case 'avatar':
      return runAvatar(deps, job);
    case 'tryon':
      return runTryon(deps, job);
    default:
      throw new PermanentError(`未知任务：${job.type}`);
  }
}

export function isRetryable(e: unknown): boolean {
  if (e instanceof PermanentError) return false;
  if (e instanceof OpenAIError) return e.retryable;
  return false;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return '出错了，请重试';
}

/** Reflect a job that gave up into the object the user sees. */
export async function markJobFailed(db: Db, job: Job, message: string): Promise<void> {
  if (job.type === 'autofill') {
    // Autofill is a convenience: still try to make the catalog image.
    await enqueueJob(db, 'catalog', job.refId);
  } else if (job.type === 'catalog') {
    const item = await getItem(db, job.refId);
    if (item && item.status !== 'active') await updateItem(db, job.refId, { status: 'failed', error: message });
  } else if (job.type === 'avatar' && job.payload.view !== 'back') {
    await saveAvatar(db, { status: 'failed', error: message });
  }
}
