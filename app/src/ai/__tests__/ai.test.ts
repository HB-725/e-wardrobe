import { createTestDb } from '@/test/memoryDb';
import type { Db } from '@/db/db';
import type { Box } from '@/domain/crop';
import type { Item } from '@/domain/types';
import { createItem, getItem, updateItem } from '@/db/items';
import { enqueueJob, latestJobFor, listJobs } from '@/db/jobs';
import { addUsage, getAvatar, getSetting, getTryon, monthSpend, putTryon, saveAvatar, avatarVersion, setSetting } from '@/db/misc';
import { AUTO_ROUTES, type KeyEntry, type ProviderId } from '../catalog';
import { AiError, classify, createOpenAiClient, type FetchLike, type ImageEditRequest, type OpenAiClient, reasoningEffort } from '../client';
import { getAiBlocked, saveAiSettings } from '../config';
import { outfitKey } from '@/domain/outfit';
import { type AiDeps, applyAutofill, generatePhoto, matchMirror, pickMirrorCandidates, tryonRef } from '../engine';
import { imageExt, type ImageStore } from '../imageStore';
import { addKey, listKeys, markVerified, saveRoutes, setConsentFor } from '../keys';
import { autofillText, catalogPrompt, photoPrompt, SCENES, tryonPrompt, type AutofillResult, type DetectResult } from '../prompts';
import { lookKey } from '@/domain/look';
import { JobRunner } from '../runner';

class MemoryImages implements ImageStore {
  files = new Map<string, string>();
  private n = 0;
  async toDataUrl(uri: string) {
    return `data:image/jpeg;base64,${this.files.get(uri) ?? 'eA=='}`;
  }
  async saveBase64(b64: string, folder: string) {
    const uri = `mem://${folder}/${++this.n}.jpg`;
    this.files.set(uri, b64);
    return uri;
  }
  async importPhoto(uri: string, folder: string) {
    return this.saveBase64('cGhvdG8=', folder + uri.length);
  }
  crops: { uri: string; box: Box }[] = [];
  async crop(uri: string, box: Box, folder: string) {
    this.crops.push({ uri, box });
    return this.saveBase64(`crop:${this.files.get(uri) ?? ''}`, folder);
  }
  async remove(uri: string | null | undefined) {
    if (uri) this.files.delete(uri);
  }
  async wipe() {
    this.files.clear();
  }
}

const AUTOFILL: AutofillResult = {
  isGarment: true,
  name: '牛仔夹克',
  slot: 'outer',
  subcategory: '夹克',
  colorName: '靛蓝',
  colorHex: '#2E4466',
  seasons: ['spring', 'autumn'],
  brand: null,
  size: 'M',
  material: '棉 100%',
  printText: null,
  fromTag: ['size', 'material'],
};

const { isGarment: _g, ...GARMENT } = AUTOFILL;
/** One garment filling the photo: behaves like the single-garment recognition before boxes existed. */
const WHOLE: DetectResult = { garments: [{ ...GARMENT, box_2d: [0, 0, 1000, 1000] }] };

type Call = { kind: 'image' | 'vision'; model: string; schemaName?: string; images: number; n?: number; prompt?: string; quality?: string };

type Fidelity = { candidates: { checks: { label: string; ok: boolean; note: string }[] }[] };
type Outfit = { fullBody: boolean; problems: string[] };
function fakeClient(opts: { failImage?: (model: string, i: number) => AiError | null; models?: string[]; detect?: DetectResult; fidelity?: Fidelity; outfit?: Outfit[]; image?: (call: number, i: number) => string } = {}): OpenAiClient & { calls: Call[] } {
  const calls: Call[] = [];
  let imageCalls = 0;
  return {
    calls,
    async listModels() {
      return opts.models ?? ['gpt-image-1-mini', 'gpt-image-1', 'gpt-5.4-nano', 'gpt-4o-mini'];
    },
    async imageEdit(req) {
      calls.push({ kind: 'image', model: req.model, images: req.images.length, n: req.n, prompt: req.prompt, quality: req.quality });
      const call = imageCalls++;
      const err = opts.failImage?.(req.model, call);
      if (err) throw err;
      return { images: Array.from({ length: req.n ?? 1 }, (_, i) => opts.image?.(call, i) ?? `img${i}`), usage: { textIn: 30, imageIn: 256, out: 408 } };
    },
    async visionJson<T>(req: { model: string; schemaName: string; images: string[] }) {
      calls.push({ kind: 'vision', model: req.model, schemaName: req.schemaName, images: req.images.length });
      let data: unknown;
      if (req.schemaName === 'garment') data = AUTOFILL;
      else if (req.schemaName === 'detect') data = opts.detect ?? WHOLE;
      else if (req.schemaName === 'fidelity')
        data = opts.fidelity ?? { candidates: [{ checks: [{ label: '主色', ok: true, note: '一致' }] }, { checks: [{ label: '主色', ok: false, note: '偏浅' }] }] };
      else if (req.schemaName === 'outfit') data = opts.outfit?.shift() ?? { fullBody: true, problems: [] };
      else data = { matches: [], unmatched: [] };
      return { data: data as T, usage: { in: 1000, out: 100 } };
    },
  };
}

const secretMap = new Map<string, string>();
const secrets = { get: async (n: string) => secretMap.get(n) ?? null, set: async (n: string, v: string | null) => void (v ? secretMap.set(n, v) : secretMap.delete(n)) };

/** A verified key with the fake client's models. */
async function seedKey(provider: ProviderId = 'openai', models = ['gpt-image-1-mini', 'gpt-image-1', 'gpt-5.4-nano', 'gpt-4o-mini']): Promise<KeyEntry> {
  const k = await addKey(db, secrets, provider, `${provider}-test-key`);
  await markVerified(db, k.id, models);
  return (await listKeys(db)).find((x) => x.id === k.id)!;
}

let db: Db;
let images: MemoryImages;
beforeEach(async () => {
  db = await createTestDb();
  await setConsentFor(db, 'openai');
  await seedKey();
  images = new MemoryImages();
});

function deps(client: OpenAiClient | null): AiDeps {
  return { db, images, clientFor: async () => client };
}

async function drain(runner: JobRunner) {
  runner.kick();
  await runner.idle();
}

const noTimers = { setTimer: () => null, clearTimer: () => {} };

describe('client', () => {
  it('classifies API errors', () => {
    expect(classify(401, '{"error":{"message":"bad key"}}').kind).toBe('auth');
    expect(classify(429, '{"error":{"code":"insufficient_quota","message":"x"}}').kind).toBe('quota');
    expect(classify(429, '{"error":{"message":"slow down"}}').kind).toBe('rate');
    expect(classify(503, 'oops').kind).toBe('server');
    expect(classify(404, '{"error":{"code":"model_not_found","message":"The model `gpt-4.1-nano` has been deprecated"}}').kind).toBe('model');
    expect(classify(400, '{"error":{"code":"moderation_blocked","message":"blocked"}}').kind).toBe('rejected');
    expect(classify(403, '{"error":{"message":"Your organization must be verified to use gpt-image-1"}}').kind).toBe('model');
    expect(new AiError('rate', '').retryable).toBe(true);
    expect(new AiError('rejected', '').retryable).toBe(false);
    expect(new AiError('quota', '').needsUser).toBe(true);
  });

  it('sends JSON bodies with data URLs and reasoning effort', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body ?? '{}') });
      const body = url.endsWith('/images/edits')
        ? { data: [{ b64_json: 'QUJD' }], usage: { input_tokens_details: { image_tokens: 256, text_tokens: 20 }, output_tokens: 400 } }
        : { choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const c = createOpenAiClient({ apiKey: 'sk-test', fetch });
    const img = await c.imageEdit({ model: 'gpt-image-1-mini', prompt: 'p', images: ['data:image/jpeg;base64,eA=='], n: 2 });
    expect(img.images).toEqual(['QUJD']);
    expect(img.usage).toEqual({ textIn: 20, imageIn: 256, out: 400 });
    expect(sent[0].body.images).toEqual([{ image_url: 'data:image/jpeg;base64,eA==' }]);
    expect(sent[0].body.n).toBe(2);
    const v = await c.visionJson<{ a: number }>({ model: 'gpt-5.4-nano', system: 's', text: 't', images: ['data:x'], schemaName: 'x', schema: {} });
    expect(v.data.a).toBe(1);
    expect(sent[1].body.reasoning_effort).toBe('none');
    expect(reasoningEffort('gpt-4o-mini')).toBeNull();
    expect(reasoningEffort('gpt-5-nano')).toBe('minimal');
  });

  it('maps network failures and missing keys', async () => {
    const c = createOpenAiClient({ apiKey: 'k', fetch: async () => { throw new TypeError('Network request failed'); } });
    await expect(c.listModels()).rejects.toMatchObject({ kind: 'network' });
    await expect(createOpenAiClient({ apiKey: '' }).listModels()).rejects.toMatchObject({ kind: 'no_key' });
  });
});

describe('autofill', () => {
  it('never overwrites fields the user typed and marks tag-read fields', async () => {
    const item = await createItem(db, { name: '我的夹克', slot: 'outer', status: 'processing', fieldSources: { name: 'user' } });
    const patch = applyAutofill(item, { ...AUTOFILL, colorHex: 'blue' });
    expect(patch.name).toBeUndefined();
    expect(patch.colorHex).toBeUndefined();
    expect(patch.size).toBe('M');
    expect(patch.fieldSources).toMatchObject({ name: 'user', size: 'tag', material: 'tag', colorName: 'ai', slot: 'ai' });
    expect(patch.brand).toBeUndefined();
  });
});

describe('runner', () => {
  async function newGarment() {
    const item = await createItem(db, { name: '新衣服', slot: 'top', status: 'processing', originalUri: 'mem://original/1.jpg' });
    await enqueueJob(db, 'catalog', item.id);
    return item;
  }

  it('turns a photo into a reviewable item with candidates, checks and usage', async () => {
    const item = await newGarment();
    const client = fakeClient();
    const runner = new JobRunner(deps(client), noTimers);
    await drain(runner);
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('review');
    expect(after.name).toBe('牛仔夹克');
    expect(after.slot).toBe('outer');
    expect(after.candidates).toHaveLength(1);
    expect(after.checks).toEqual([[{ label: '主色', ok: true, note: '一致' }]]);
    expect(client.calls.map((c) => c.schemaName ?? c.kind)).toEqual(['detect', 'image', 'fidelity']);
    expect((await monthSpend(db)).totalUsd).toBeGreaterThan(0);
    expect(await listJobs(db, ['queued', 'running'])).toHaveLength(0);
  });

  it('regenerating skips autofill and replaces old candidates', async () => {
    const item = await newGarment();
    const client = fakeClient();
    const runner = new JobRunner(deps(client), noTimers);
    await drain(runner);
    const first = (await getItem(db, item.id))!.candidates;
    await enqueueJob(db, 'catalog', item.id, { regenerate: true });
    await drain(runner);
    const second = (await getItem(db, item.id))!.candidates;
    expect(second).not.toEqual(first);
    expect(images.files.has(first[0])).toBe(false);
    expect(client.calls.filter((c) => c.schemaName === 'detect')).toHaveLength(1);
  });

  it('pauses without a key and resumes once one is provided', async () => {
    const item = await newGarment();
    const keys = await getSetting(db, 'ai.keys');
    await setSetting(db, 'ai.keys', '[]');
    const runner = new JobRunner(deps(fakeClient()), noTimers);
    await drain(runner);
    expect(await getAiBlocked(db)).toBe('no_key');
    const [job] = await listJobs(db, ['queued']);
    expect(job.attempts).toBe(0);
    expect((await getItem(db, item.id))!.status).toBe('processing');
    await setSetting(db, 'ai.keys', keys!);
    await drain(runner);
    expect((await getItem(db, item.id))!.status).toBe('review');
    expect(await getAiBlocked(db)).toBeNull();
  });

  it('switches to the next image model when one is deprecated', async () => {
    await newGarment();
    const client = fakeClient({ failImage: (m) => (m === 'gpt-image-1-mini' ? new AiError('model', 'deprecated') : null) });
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls.filter((c) => c.kind === 'image').map((c) => c.model)).toEqual(['gpt-image-1-mini', 'gpt-image-1']);
    expect((await listKeys(db))[0].blocked).toContain('gpt-image-1-mini');
  });

  it('retries transient failures with backoff, then marks the item failed', async () => {
    const item = await newGarment();
    let now = new Date(Date.now() + 1000);
    const client = fakeClient({ failImage: () => new AiError('server', '502') });
    const runner = new JobRunner({ db, images, clientFor: async () => client, now: () => now }, noTimers);
    await drain(runner);
    let [job] = await listJobs(db, ['queued']);
    expect(job.attempts).toBe(1);
    expect(job.nextRunAt > now.toISOString()).toBe(true);
    for (let i = 0; i < 2; i++) {
      now = new Date(now.getTime() + 60 * 60 * 1000);
      await drain(runner);
    }
    expect(await listJobs(db, ['queued'])).toHaveLength(0);
    const failed = (await getItem(db, item.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('稍后自动重试');
    [job] = await listJobs(db, ['failed']);
    expect(job.attempts).toBe(3);
  });

  it('does not retry requests the API rejected', async () => {
    const item = await newGarment();
    const client = fakeClient({ failImage: () => new AiError('rejected', 'moderation') });
    await drain(new JobRunner(deps(client), noTimers));
    expect((await getItem(db, item.id))!.status).toBe('failed');
  });

  it('stops at the monthly cap', async () => {
    await saveAiSettings(db, { capUsd: 1 });
    await addUsage(db, { kind: 'catalog', model: 'x', costUsd: 1.5 });
    await newGarment();
    const client = fakeClient();
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls).toHaveLength(0);
    expect(await getAiBlocked(db)).toBe('cap');
  });

  it('builds the avatar, then caches try-on images per combination and view', async () => {
    await saveAvatar(db, { sourceUris: ['mem://body/1', 'mem://body/2', 'mem://body/3'], heightCm: 175, weightKg: 68, status: 'processing' });
    const client = fakeClient();
    const runner = new JobRunner(deps(client), noTimers);
    await enqueueJob(db, 'avatar', 'me');
    await drain(runner);
    const avatar = await getAvatar(db);
    expect(avatar.status).toBe('ready');
    expect(avatar.frontUri).toBeTruthy();
    expect(avatar.backUri).toBeTruthy();
    // front call gets 3 body photos, back call gets the front + back photo
    expect(client.calls.filter((c) => c.kind === 'image').map((c) => c.images)).toEqual([3, 2]);

    const a = await createItem(db, { name: 'T', slot: 'top', status: 'active', catalogUri: 'mem://catalog/a' });
    const b = await createItem(db, { name: 'J', slot: 'bottom', status: 'active', catalogUri: 'mem://catalog/b' });
    const key = [a.id, b.id].sort().join('+');
    await enqueueJob(db, 'tryon', tryonRef(key, 'back'), { itemIds: [a.id, b.id] });
    await drain(runner);
    const uri = await getTryon(db, key, 'back', avatarVersion(avatar));
    expect(uri).toMatch(/^mem:\/\/tryon\//);
    // The back is drawn from the front try-on, generated first: front = avatar + 2 garments, back = avatar + front.
    expect(client.calls.slice(-2).map((c) => c.images)).toEqual([3, 2]);
    expect(await getTryon(db, key, 'front', avatarVersion(avatar))).toMatch(/^mem:\/\/tryon\//);
    await enqueueJob(db, 'tryon', tryonRef(key, 'back'), { itemIds: [a.id, b.id] }, { evenIfRunning: true });
    await drain(runner);
    expect(client.calls.at(-1)?.images).toBe(2); // regenerating the back reuses the cached front
    // Regenerating the front drops the back that was turned from the old front.
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: [a.id, b.id] });
    await drain(runner);
    expect(await getTryon(db, key, 'front', avatarVersion(avatar))).toMatch(/^mem:\/\/tryon\//);
    expect(await getTryon(db, key, 'back', avatarVersion(avatar))).toBeNull();
  });

  it('marks the avatar failed when generation is refused', async () => {
    await saveAvatar(db, { sourceUris: ['mem://body/1'], status: 'processing' });
    await enqueueJob(db, 'avatar', 'me');
    await drain(new JobRunner(deps(fakeClient({ failImage: () => new AiError('rejected', 'no') })), noTimers));
    expect((await getAvatar(db)).status).toBe('failed');
  });

  it('re-queues jobs interrupted by an app kill on start', async () => {
    await newGarment();
    await db.runAsync("UPDATE jobs SET status = 'running'");
    const runner = new JobRunner(deps(fakeClient()), noTimers);
    await runner.start();
    await runner.idle();
    expect(await listJobs(db, ['done'])).toHaveLength(1);
  });

  it('schedules a wake-up for retries', async () => {
    await newGarment();
    const timers: number[] = [];
    const runner = new JobRunner(deps(fakeClient({ failImage: () => new AiError('rate', '429') })), {
      setTimer: (_fn, ms) => timers.push(ms),
      clearTimer: () => {},
    });
    await drain(runner);
    await new Promise((r) => setTimeout(r, 20));
    expect(timers.length).toBe(1);
    expect(timers[0]).toBeGreaterThan(10_000);
  });
});

describe('mirror', () => {
  it('maps model indices to items and keeps one item per slot', async () => {
    const a = await createItem(db, { name: '夹克', slot: 'outer', status: 'active', catalogUri: 'mem://c/1' });
    const b = await createItem(db, { name: '另一件夹克', slot: 'outer', status: 'active', catalogUri: 'mem://c/2' });
    const c = await createItem(db, { name: '牛仔裤', slot: 'bottom', status: 'active', catalogUri: 'mem://c/3' });
    await createItem(db, { name: '待确认', slot: 'top', status: 'review', catalogUri: 'mem://c/4' });
    const client = fakeClient();
    client.visionJson = async <T,>(req: { images: string[] }) => {
      expect(req.images).toHaveLength(4); // photo + 3 active items
      return {
        data: { matches: [{ index: 1, confidence: 'high', note: ' 裤脚堆在鞋面上 ' }, { index: 2, confidence: 'low', note: '' }, { index: 3, confidence: 'medium', note: '' }, { index: 9, confidence: 'high', note: '' }], unmatched: ['灰色围巾'] } as T,
        usage: { in: 1, out: 1 },
      };
    };
    const r = await matchMirror(deps(client), 'mem://mirror/1');
    const ids = new Map([[a.id, 'a'], [b.id, 'b'], [c.id, 'c']]);
    // listItems orders newest first, so index 1 is the newest item
    // per category the more confident match wins: medium (a) over low (b)
    expect(r.matches.map((m) => ids.get(m.itemId))).toEqual(['c', 'a']);
    expect(r.matches[0].note).toBe('裤脚堆在鞋面上');
    expect(r.unmatched).toEqual(['灰色围巾']);
    expect(await getSetting(db, 'ai.blocked')).toBeNull();
  });
});

describe('races', () => {
  it('drops generated candidates when the user kept the original meanwhile', async () => {
    const item = await createItem(db, { name: 'x', slot: 'top', status: 'processing', originalUri: 'mem://original/9.jpg' });
    await enqueueJob(db, 'catalog', item.id);
    const client = fakeClient();
    const orig = client.imageEdit.bind(client);
    client.imageEdit = async (req) => {
      await updateItem(db, item.id, { status: 'active' });
      return orig(req);
    };
    await drain(new JobRunner(deps(client), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('active');
    expect(after.candidates).toEqual([]);
    expect([...images.files.keys()].some((k) => k.includes('catalog'))).toBe(false);
  });
});

describe('review fixes', () => {
  it('regenerating a wardrobe item keeps it active and attaches new candidates', async () => {
    const item = await createItem(db, { name: '夹克', slot: 'outer', status: 'active', originalUri: 'mem://o/1', catalogUri: 'mem://c/old', fieldSources: { name: 'user' } });
    await enqueueJob(db, 'catalog', item.id, { regenerate: true });
    await drain(new JobRunner(deps(fakeClient()), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('active');
    expect(after.catalogUri).toBe('mem://c/old');
    expect(after.candidates).toHaveLength(1);
  });

  it('a failed regeneration leaves the item active', async () => {
    const item = await createItem(db, { name: '夹克', slot: 'outer', status: 'archived', originalUri: 'mem://o/1', catalogUri: 'mem://c/old' });
    await enqueueJob(db, 'catalog', item.id, { regenerate: true });
    await drain(new JobRunner(deps(fakeClient({ failImage: () => new AiError('rejected', 'no') })), noTimers));
    expect((await getItem(db, item.id))!.status).toBe('archived');
  });

  it('skips paid generation when the user settled the item during autofill', async () => {
    const item = await createItem(db, { name: '新衣服', slot: 'top', status: 'processing', originalUri: 'mem://o/1' });
    await enqueueJob(db, 'catalog', item.id);
    const client = fakeClient();
    const orig = client.visionJson.bind(client);
    client.visionJson = async (req) => {
      await updateItem(db, item.id, { status: 'active', name: '我起的名字', fieldSources: { name: 'user' } });
      return orig(req);
    };
    await drain(new JobRunner(deps(client), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.name).toBe('我起的名字');
    expect(client.calls.some((c) => c.kind === 'image')).toBe(false);
  });

  it('keeps the previous avatar usable when regenerating it fails', async () => {
    await saveAvatar(db, { frontUri: 'mem://a/f', backUri: 'mem://a/b', sourceUris: ['mem://body/1'], status: 'processing' });
    await enqueueJob(db, 'avatar', 'me');
    await drain(new JobRunner(deps(fakeClient({ failImage: () => new AiError('rejected', 'no') })), noTimers));
    const a = await getAvatar(db);
    expect(a.status).toBe('ready');
    expect(a.frontUri).toBe('mem://a/f');
    expect(a.error).toBeTruthy();
  });

  it('does not clear the pause reason when another worker finishes after the cap is hit', async () => {
    await saveAiSettings(db, { capUsd: 0.005 });
    for (let i = 0; i < 3; i++) {
      const it = await createItem(db, { name: `x${i}`, slot: 'top', status: 'processing', originalUri: `mem://o/${i}` });
      await enqueueJob(db, 'catalog', it.id);
    }
    await drain(new JobRunner(deps(fakeClient()), { ...noTimers, concurrency: 2 }));
    expect(await getAiBlocked(db)).toBe('cap');
  });
});

describe('round 2 fixes', () => {
  it('a new photo for a wardrobe item re-runs autofill and generation but keeps the item usable', async () => {
    const item = await createItem(db, { name: '旧名字', slot: 'top', status: 'active', originalUri: 'mem://o/new', catalogUri: 'mem://c/old', fieldSources: { name: 'user' } });
    await enqueueJob(db, 'catalog', item.id);
    const client = fakeClient();
    await drain(new JobRunner(deps(client), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('active');
    expect(after.name).toBe('旧名字');
    expect(after.colorName).toBe('靛蓝');
    expect(after.candidates).toHaveLength(1);
  });

  it('mirror matching sends the most-worn items first', async () => {
    const rare = await createItem(db, { name: 'rare', slot: 'top', status: 'active', catalogUri: 'mem://c/r' });
    const often = await createItem(db, { name: 'often', slot: 'top', status: 'active', catalogUri: 'mem://c/o' });
    await db.runAsync("INSERT INTO wear_logs (id, date, source, created_at) VALUES ('l1', '2026-10-01', 'manual', 'x')");
    await db.runAsync('INSERT INTO wear_log_items (log_id, item_id) VALUES (?, ?)', ['l1', often.id]);
    const client = fakeClient();
    let text = '';
    client.visionJson = async <T,>(req: { text: string }) => {
      text = req.text;
      return { data: { matches: [], unmatched: [] } as T, usage: { in: 1, out: 1 } };
    };
    await matchMirror(deps(client), 'mem://mirror/1');
    expect(text.indexOf('often')).toBeLessThan(text.indexOf('rare'));
    expect(rare.id).toBeTruthy();
  });
});

describe('model errors', () => {
  it('does not treat a rejected parameter as a dead model', () => {
    expect(classify(400, '{"error":{"message":"output_compression is not supported for this request","code":"unsupported_value"}}').kind).toBe('rejected');
    expect(classify(400, '{"error":{"message":"The model `gpt-image-1-mini` does not exist or you do not have access to it."}}').kind).toBe('model');
    expect(classify(404, '{"error":{"message":"Not found"}}').kind).toBe('model');
  });
});

describe('paid results survive retries', () => {
  it('reuses catalog candidates generated before a failure', async () => {
    const item = await createItem(db, { name: 'x', slot: 'top', status: 'processing', originalUri: 'mem://o/1' });
    await enqueueJob(db, 'catalog', item.id);
    let visionCalls = 0;
    const client = fakeClient();
    const orig = client.visionJson.bind(client);
    client.visionJson = async (req) => {
      visionCalls += 1;
      if (visionCalls === 2) throw new AiError('server', '502 on fidelity'); // fidelity failure is swallowed
      return orig(req);
    };
    // Simulate a crash right after generation: fail the update after images were saved.
    const runner = new JobRunner(deps(client), noTimers);
    await drain(runner);
    expect(client.calls.filter((c) => c.kind === 'image')).toHaveLength(1);
    expect((await getItem(db, item.id))!.status).toBe('review');
  });

  it('continues an avatar from the paid front image when the back failed', async () => {
    await saveAvatar(db, { sourceUris: ['mem://body/1'], status: 'processing' });
    await enqueueJob(db, 'avatar', 'me');
    let n = 0;
    const client = fakeClient({ failImage: () => (++n === 2 ? new AiError('server', 'back failed') : null) });
    let now = new Date(Date.now() + 1000);
    const runner = new JobRunner({ db, images, clientFor: async () => client, now: () => now }, noTimers);
    await drain(runner);
    expect((await getAvatar(db)).status).toBe('processing');
    now = new Date(now.getTime() + 60 * 60 * 1000);
    await drain(runner);
    const a = await getAvatar(db);
    expect(a.status).toBe('ready');
    // front once + back twice
    expect(client.calls.filter((c) => c.kind === 'image')).toHaveLength(3);
  });

  it('marks exhausted interrupted jobs failed on start', async () => {
    const item = await createItem(db, { name: 'x', slot: 'top', status: 'processing', originalUri: 'mem://o/1' });
    const job = await enqueueJob(db, 'catalog', item.id);
    await db.runAsync("UPDATE jobs SET status = 'running', attempts = 3 WHERE id = ?", [job.id]);
    const client = fakeClient();
    const runner = new JobRunner(deps(client), noTimers);
    await runner.start();
    await runner.idle();
    expect((await getItem(db, item.id))!.status).toBe('failed');
    expect(client.calls).toHaveLength(0);
  });
});

describe('round 6 fixes', () => {
  it('sends nothing before the user agreed to photos going to OpenAI, and continues once they do', async () => {
    db = await createTestDb(); // no consent
    await seedKey();
    const item = await createItem(db, { name: 'x', slot: 'top', status: 'processing', originalUri: 'mem://original/1.jpg' });
    await enqueueJob(db, 'catalog', item.id);
    const client = fakeClient();
    const runner = new JobRunner(deps(client), noTimers);
    await drain(runner);
    expect(client.calls).toHaveLength(0);
    expect(await getAiBlocked(db)).toBe('consent');
    expect((await listJobs(db, ['queued']))[0].attempts).toBe(0);
    await setConsentFor(db, 'openai');
    await drain(runner);
    expect((await getItem(db, item.id))!.status).toBe('review');
  });

  it('a job for a replaced photo neither pays again nor publishes old-photo candidates', async () => {
    const item = await createItem(db, { name: 'x', slot: 'top', status: 'active', originalUri: 'mem://original/new.jpg', catalogUri: 'mem://catalog/old' });
    const stale = await images.saveBase64('b2xk', 'catalog');
    await enqueueJob(db, 'catalog', item.id, { photo: 'mem://original/old.jpg', generated: [stale] });
    const client = fakeClient();
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls).toHaveLength(0);
    expect(images.files.has(stale)).toBe(false);
    expect((await getItem(db, item.id))!.candidates).toEqual([]);
  });

  it('an older catalog job yields to a newer one for the same item', async () => {
    const item = await createItem(db, { name: 'x', slot: 'top', status: 'processing', originalUri: 'mem://original/1.jpg' });
    const first = await enqueueJob(db, 'catalog', item.id);
    await db.runAsync("UPDATE jobs SET status = 'running' WHERE id = ?", [first.id]);
    await enqueueJob(db, 'catalog', item.id, {}, { evenIfRunning: true });
    await db.runAsync("UPDATE jobs SET status = 'queued' WHERE id = ?", [first.id]);
    const client = fakeClient();
    await drain(new JobRunner(deps(client), noTimers));
    // one autofill + one generation + one check: the older job did nothing
    expect(client.calls.filter((c) => c.kind === 'image')).toHaveLength(1);
  });

  it('discards a try-on when a garment changes while it is being generated', async () => {
    await saveAvatar(db, { frontUri: 'mem://avatar/f', backUri: 'mem://avatar/b', status: 'ready' });
    const a = await createItem(db, { name: 'T', slot: 'top', status: 'active', catalogUri: 'mem://catalog/a' });
    const key = a.id;
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: [a.id] });
    const base = fakeClient();
    const client: OpenAiClient = {
      ...base,
      async imageEdit(req) {
        await updateItem(db, a.id, { catalogUri: 'mem://catalog/a2' });
        return base.imageEdit(req);
      },
    };
    await drain(new JobRunner(deps(client), noTimers));
    expect(await getTryon(db, key, 'front', avatarVersion(await getAvatar(db)))).toBeNull();
    expect([...images.files.keys()].some((u) => u.includes('tryon'))).toBe(false);
  });
});

describe('mirror candidates', () => {
  const mk = (id: string, slot: Item['slot'], createdAt: string) => ({ id, slot, createdAt }) as Item;
  it('gives every category a share and includes new garments, not only the most worn', () => {
    const tops = Array.from({ length: 100 }, (_, i) => mk(`t${i}`, 'top', `2025-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`));
    const shoes = Array.from({ length: 5 }, (_, i) => mk(`s${i}`, 'shoes', '2025-01-01T00:00:00Z'));
    const brandNew = mk('new', 'top', '2026-10-28T00:00:00Z');
    const wear = new Map(tops.slice(0, 60).map((t, i) => [t.id, { n: 100 - i, last: '2026-01-01' }]));
    const picked = pickMirrorCandidates([...tops, brandNew, ...shoes], wear, 20);
    expect(picked).toHaveLength(20);
    expect(picked.filter((x) => x.slot === 'shoes').length).toBeGreaterThanOrEqual(4);
    expect(picked.map((x) => x.id)).toContain('new');
    expect(picked.map((x) => x.id)).toContain('t0');
  });
});

describe('offline', () => {
  it('waits for the network instead of using up attempts, and does not count a timeout as offline', async () => {
    const item = await createItem(db, { name: 'x', slot: 'top', status: 'processing', originalUri: 'mem://original/1.jpg' });
    await enqueueJob(db, 'catalog', item.id);
    let now = new Date('2030-01-01T00:00:00Z');
    const client = fakeClient();
    client.visionJson = async () => {
      throw new AiError('network', 'Network request failed');
    };
    const runner = new JobRunner({ db, images, clientFor: async () => client, now: () => now }, noTimers);
    for (let i = 0; i < 5; i++) {
      await drain(runner);
      now = new Date(now.getTime() + 61_000);
    }
    const [job] = await listJobs(db, ['queued']);
    expect(job.attempts).toBe(0);
    expect((await getItem(db, item.id))!.status).toBe('processing');
    expect(new AiError('timeout', '').retryable).toBe(true);
  });
});

describe('multiple providers', () => {
  it('sends each purpose to its own key, asks consent per provider and fits Gemini requests', async () => {
    const g = await seedKey('gemini', ['gemini-2.5-flash-image', 'gemini-2.5-flash-lite']);
    await saveRoutes(db, { ...AUTO_ROUTES, catalog: { keyId: g.id, model: 'gemini-2.5-flash-image' } });
    await createItem(db, { name: '旧衣服', slot: 'top', status: 'active', catalogUri: 'mem://catalog/old' });
    const item = await createItem(db, { name: '新衣服', slot: 'top', status: 'processing', originalUri: 'mem://original/1.jpg' });
    await enqueueJob(db, 'catalog', item.id);
    const openai = fakeClient();
    const gemini = fakeClient();
    const sent: ImageEditRequest[] = [];
    const edit = gemini.imageEdit.bind(gemini);
    gemini.imageEdit = async (req) => {
      sent.push(req);
      return edit(req);
    };
    const runner = new JobRunner({ db, images, clientFor: async (k) => (k.provider === 'gemini' ? gemini : openai) }, noTimers);
    await drain(runner);
    // Recognition stays on OpenAI (agreed); the Gemini catalog image waits for its own consent.
    expect(openai.calls.map((c) => c.schemaName)).toEqual(['detect']);
    expect(gemini.calls).toHaveLength(0);
    expect(await getAiBlocked(db)).toBe('consent');
    await setConsentFor(db, 'gemini');
    await drain(runner);
    expect((await getItem(db, item.id))!.status).toBe('review');
    expect(openai.calls.filter((c) => c.kind === 'image')).toHaveLength(0);
    // The photo plus an existing catalog image as style reference; no quality setting, which Gemini does not have.
    expect(sent[0]).toMatchObject({ model: 'gemini-2.5-flash-image', quality: undefined, size: '1024x1536' });
    expect(sent[0].images).toHaveLength(2);
    expect(sent[0].prompt).toContain('style reference');
  });

  it('re-reads a stale model list and does not hold unknown prices against the cap', async () => {
    await setSetting(db, 'ai.keys', '[]');
    const k = await seedKey('openai', ['gpt-image-9', 'gpt-5.4-nano']);
    const item = await createItem(db, { name: 'x', slot: 'top', status: 'processing', originalUri: 'mem://original/1.jpg' });
    await enqueueJob(db, 'catalog', item.id);
    const client = fakeClient({ models: ['gpt-image-9', 'gpt-5.4-nano'] });
    await drain(new JobRunner(deps(client), noTimers));
    // Only the two recognition calls are priced: 2 × (1000 × $0.2 + 100 × $1.25) / 1M.
    expect((await monthSpend(db)).totalUsd).toBeCloseTo(0.00065, 8);
    expect(client.calls.find((c) => c.kind === 'image')?.model).toBe('gpt-image-9');

    await markVerified(db, k.id, ['gpt-image-9', 'gpt-5.4-nano'], '2020-01-01T00:00:00Z');
    await enqueueJob(db, 'catalog', item.id, { regenerate: true });
    const newer = fakeClient({ models: ['gpt-image-9', 'gpt-image-1-mini', 'gpt-5.4-nano'] });
    await drain(new JobRunner(deps(newer), noTimers));
    expect((await listKeys(db))[0].models).toContain('gpt-image-1-mini');
    expect(newer.calls.find((c) => c.kind === 'image')?.model).toBe('gpt-image-1-mini');
  });

  it('pauses with no_key when no key can do a purpose', async () => {
    await setSetting(db, 'ai.keys', '[]');
    await seedKey('openai', ['gpt-5.4-nano']);
    const item = await createItem(db, { name: 'x', slot: 'top', status: 'processing', originalUri: 'mem://original/1.jpg' });
    await enqueueJob(db, 'catalog', item.id, { regenerate: true });
    await drain(new JobRunner(deps(fakeClient()), noTimers));
    expect(await getAiBlocked(db)).toBe('no_key');
  });

  it('names saved images after the data they hold', () => {
    expect(imageExt('iVBORw0KGgo=')).toBe('png');
    expect(imageExt('/9j/4AAQ')).toBe('jpg');
    expect(imageExt('UklGRiQA')).toBe('webp');
  });
});

describe('garments on a photo', () => {
  const tee = { ...GARMENT, name: '黑色T恤', slot: 'top' as const, box_2d: [100, 250, 450, 750] };
  const pants = { ...GARMENT, name: '灰色卫裤', slot: 'bottom' as const, box_2d: [430, 300, 1000, 700] };

  async function photo(extra: Partial<Item> = {}) {
    const originalUri = await images.saveBase64('cGhvdG8=', 'original');
    const item = await createItem(db, { name: '新衣服', slot: 'top', status: 'processing', originalUri, ...extra });
    await enqueueJob(db, 'catalog', item.id);
    return item;
  }

  it('makes one catalog candidate by default; a miss is for the regenerate panel', async () => {
    // 44 garments on 2026-11-05: the second candidate beat the first 3 times, so it is not worth half the cost.
    const item = await photo();
    const client = fakeClient();
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls.find((c) => c.kind === 'image')!.n).toBe(1);
    expect((await getItem(db, item.id))!.candidates).toHaveLength(1);
  });

  it('crops a single small garment and generates from the crop', async () => {
    const item = await photo();
    const client = fakeClient({ detect: { garments: [pants] } });
    await drain(new JobRunner(deps(client), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('review');
    expect(after.name).toBe('灰色卫裤');
    expect(after.sourceUri).toBe(item.originalUri);
    expect(after.originalUri).not.toBe(item.originalUri);
    expect(images.files.get(after.originalUri!)).toBe('crop:cGhvdG8=');
    expect(after.crop!.y).toBeCloseTo(0.43 - 0.57 * 0.06);
    expect(images.crops).toHaveLength(1);
    expect(after.candidates).toHaveLength(1);
  });

  it('does not crop a garment that fills the photo', async () => {
    const item = await photo();
    await drain(new JobRunner(deps(fakeClient({ detect: { garments: [{ ...tee, box_2d: [20, 20, 980, 980] }] } })), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.crop).toBeNull();
    expect(after.originalUri).toBe(item.originalUri);
    expect(images.crops).toHaveLength(0);
  });

  it('waits for the user to pick when there are several garments, without generating', async () => {
    const item = await photo();
    const client = fakeClient({ detect: { garments: [tee, pants, { ...pants, name: '小点', box_2d: [0, 0, 10, 10] }] } });
    await drain(new JobRunner(deps(client), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('pick');
    expect(after.detections.map((d) => d.name)).toEqual(['黑色T恤', '灰色卫裤']);
    expect(after.detections.every((d) => !d.selected && !d.manual)).toBe(true);
    expect(client.calls.map((c) => c.kind)).toEqual(['vision']);
    expect(await listJobs(db, ['queued', 'running'])).toHaveLength(0);
  });

  it('a pair of shoes listed as two is one garment, cut as one', async () => {
    const item = await photo();
    const left = { ...GARMENT, name: '白色板鞋', slot: 'shoes' as const, box_2d: [600, 200, 900, 480] };
    const right = { ...left, box_2d: [600, 520, 900, 800] };
    await drain(new JobRunner(deps(fakeClient({ detect: { garments: [left, right] } })), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('review');
    expect(after.name).toBe('白色板鞋');
    expect(images.crops).toHaveLength(1);
    expect(after.crop!.x).toBeLessThan(0.2);
    expect(after.crop!.x + after.crop!.w).toBeGreaterThan(0.8);
  });

  it('a print on a garment is not a garment of its own', async () => {
    const item = await photo();
    const print = { ...GARMENT, name: '彩色印花', slot: 'accessory' as const, box_2d: [200, 400, 300, 600] };
    await drain(new JobRunner(deps(fakeClient({ detect: { garments: [tee, print] } })), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('review');
    expect(after.name).toBe('黑色T恤');
  });

  it('a logo or cuff listed as a second garment of the same kind is part of the first', async () => {
    const item = await photo();
    const hoodie = { ...GARMENT, name: '黑色卫衣', slot: 'top' as const, box_2d: [50, 100, 950, 900] };
    const cuff = { ...GARMENT, name: '袖口图标卫衣', slot: 'top' as const, box_2d: [800, 700, 940, 890] };
    await drain(new JobRunner(deps(fakeClient({ detect: { garments: [hoodie, cuff] } })), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('review');
    expect(after.name).toBe('黑色卫衣');
  });

  it('puts the candidate that passed every check first', async () => {
    await saveAiSettings(db, { candidates: 2 });
    const item = await photo();
    const fidelity = { candidates: [{ checks: [{ label: '印花', ok: false, note: '字样不同' }] }, { checks: [{ label: '印花', ok: true, note: '一致' }] }] };
    await drain(new JobRunner(deps(fakeClient({ fidelity })), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.candidates.map((u) => images.files.get(u))).toEqual(['img1', 'img0']);
    expect(after.checks.map((c) => c[0].ok)).toEqual([true, false]);
  });

  it('tells the image model the exact print text', async () => {
    await photo();
    const client = fakeClient({ detect: { garments: [{ ...tee, printText: 'OET GRUNN', box_2d: [20, 20, 980, 980] }] } });
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls.find((c) => c.kind === 'image')!.prompt).toContain('OET GRUNN');
  });

  it('a wardrobe item with a new outfit photo takes the garment of its own category', async () => {
    const item = await photo({ name: '旧裤子', slot: 'bottom', status: 'active', catalogUri: 'mem://c/old', fieldSources: { name: 'user' } });
    await drain(new JobRunner(deps(fakeClient({ detect: { garments: [tee, pants] } })), noTimers));
    const after = (await getItem(db, item.id))!;
    expect(after.status).toBe('active');
    expect(after.slot).toBe('bottom');
    expect(after.crop!.y).toBeGreaterThan(0.3);
    expect(after.candidates).toHaveLength(1);
  });

  it('regenerates with the model, quality and notes picked for this time', async () => {
    const item = await createItem(db, { name: '外套', slot: 'outer', status: 'review', originalUri: 'mem://o/1', candidates: ['mem://c/a'] });
    const key = (await listKeys(db))[0];
    await enqueueJob(db, 'catalog', item.id, { regenerate: true, model: { keyId: key.id, model: 'gpt-image-1' }, quality: 'high', hint: '颜色更浅' });
    const client = fakeClient();
    await drain(new JobRunner(deps(client), noTimers));
    const call = client.calls.find((c) => c.kind === 'image')!;
    expect(call.model).toBe('gpt-image-1');
    expect(call.quality).toBe('high');
    expect(call.prompt).toContain('颜色更浅');
    expect(client.calls.some((c) => c.schemaName === 'detect' || c.schemaName === 'garment')).toBe(false);
  });

  it('a box the user drew is recognised on its own', async () => {
    const item = await createItem(db, { name: '新衣服', slot: 'top', status: 'processing', originalUri: 'mem://o/crop' });
    await enqueueJob(db, 'catalog', item.id, { autofill: 'crop' });
    const client = fakeClient();
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls.map((c) => c.schemaName ?? c.kind)).toEqual(['garment', 'image', 'fidelity']);
    expect((await getItem(db, item.id))!.name).toBe('牛仔夹克');
  });

  it('tells the image model to keep wear as it is and never to invent text', () => {
    const p = catalogPrompt('top', '卫衣');
    expect(p).toContain('fading');
    expect(p).toContain('illegible');
    expect(p).not.toContain('complete parts that were hidden');
  });

  // On 9 real photos (2026-11-05) the recogniser called navy track pants 黑色 #1A1A1A and gpt-image-2 drew them black.
  it('tells the recogniser to tell navy from black and a faded black from a black', () => {
    const t = autofillText(false);
    expect(t).toContain('藏青');
    expect(t).toContain('褪色');
  });

  it('puts the owner notes last in the catalog prompt', () => {
    const p = catalogPrompt('top', 'T恤', undefined, '  保留胸前小标 ');
    expect(p.endsWith('follow them: 保留胸前小标')).toBe(true);
    expect(catalogPrompt('top', 'T恤')).not.toContain('Notes from the owner');
  });
});

describe('layered try-ons', () => {
  it('words one top under one jacket as before, and spells out longer layering and styling', () => {
    const plain = tryonPrompt([{ slot: 'bottom' }, { slot: 'top' }, { slot: 'outer' }]);
    expect(plain).toContain('The outerwear is worn over the top.');
    expect(plain).not.toContain('innermost');
    const layered = tryonPrompt([{ slot: 'shoes' }, { slot: 'top' }, { slot: 'top', styling: { open: true, tucked: false } }, { slot: 'outer' }, { slot: 'outer', styling: { open: false } }]);
    expect(layered).toContain('Upper-body layers from innermost to outermost: image 3 (top), then image 4 (top), then image 5 (outerwear piece), then image 6 (outerwear piece).');
    expect(layered).toContain('The garment in image 4 is worn open (unbuttoned / unzipped) and worn untucked.');
    expect(layered).toContain('The garment in image 6 is worn closed (buttoned / zipped up).');
    expect(layered).not.toContain('The outerwear is worn over the top.');
    expect(tryonPrompt([{ slot: 'top', styling: { tucked: true } }, { slot: 'bottom' }])).toContain('The garment in image 2 is tucked into the bottoms.');
  });

  it('draws the layers in the order and styling of the look', async () => {
    const avatar = await saveAvatar(db, { frontUri: 'mem://avatar/f', backUri: 'mem://avatar/b', status: 'ready' });
    const tee = await createItem(db, { name: 'T', slot: 'top', status: 'active', catalogUri: 'mem://catalog/tee' });
    const jacket = await createItem(db, { name: 'J', slot: 'outer', status: 'active', catalogUri: 'mem://catalog/j' });
    const shirt = await createItem(db, { name: 'S', slot: 'top', status: 'active', catalogUri: 'mem://catalog/s' });
    const jeans = await createItem(db, { name: 'P', slot: 'bottom', status: 'active', catalogUri: 'mem://catalog/p' });
    const ids = [tee.id, jacket.id, jeans.id, shirt.id];
    const styling = { [shirt.id]: { open: true } };
    const slots = new Map([tee, jacket, shirt, jeans].map((i) => [i.id, i.slot]));
    const key = lookKey(ids, styling, (id) => slots.get(id));
    const client = fakeClient();
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: ids, styling });
    await drain(new JobRunner(deps(client), noTimers));
    expect(await getTryon(db, key, 'front', avatarVersion(avatar))).toMatch(/^mem:\/\/tryon\//);
    const prompt = client.calls.filter((c) => c.kind === 'image').at(-1)?.prompt ?? '';
    // Jeans first (feet up), then the upper body in the look's order: tee, jacket, shirt over the jacket.
    expect(prompt).toContain('image 2: bottoms');
    expect(prompt).toContain('Upper-body layers from innermost to outermost: image 3 (top), then image 4 (outerwear piece), then image 5 (top).');
    expect(prompt).toContain('The garment in image 5 is worn open');
  });
});

describe('accessories, makeup and the try-on sheet', () => {
  it('asks for every accessory together', () => {
    const p = tryonPrompt([{ slot: 'top' }, { slot: 'accessory' }, { slot: 'accessory' }]);
    expect(p).toContain('Wear all 2 accessories (images 3, 4) together');
    expect(tryonPrompt([{ slot: 'top' }, { slot: 'accessory' }])).not.toContain('Wear all');
    expect(photoPrompt([{ slot: 'top' }], SCENES[0], 'a bold red lipstick')).toContain('The person wears a bold red lipstick; only the makeup differs');
  });

  /** A vision fake that answers the face check with `same` in turn. */
  function faceAnswers(client: ReturnType<typeof fakeClient>, same: boolean[]) {
    const orig = client.visionJson.bind(client);
    let i = 0;
    client.visionJson = async <T,>(req: Parameters<OpenAiClient['visionJson']>[0]) => {
      if (req.schemaName !== 'face_check') return orig<T>(req);
      client.calls.push({ kind: 'vision', model: req.model, schemaName: req.schemaName, images: req.images.length });
      return { data: { samePerson: same[i++] ?? false, note: '' } as T, usage: { in: 1000, out: 20 } };
    };
  }

  async function setup() {
    const avatar = await saveAvatar(db, { frontUri: 'mem://avatar/f', backUri: 'mem://avatar/b', status: 'ready' });
    const tee = await createItem(db, { name: 'T', slot: 'top', status: 'active', catalogUri: 'mem://catalog/tee' });
    const key = lookKey([tee.id], {}, () => 'top');
    return { avatar, tee, key, made: lookKey([tee.id], {}, () => 'top', 'redlip') };
  }

  it('draws the outfit first, then only the makeup, checked against the user\'s face', async () => {
    const { avatar, tee, key, made } = await setup();
    const client = fakeClient();
    faceAnswers(client, [true]);
    await enqueueJob(db, 'tryon', tryonRef(made, 'front'), { itemIds: [tee.id], styling: {}, makeup: 'redlip' });
    await drain(new JobRunner(deps(client), noTimers));
    // The dressed front is checked against the garments; the made-up face against the user's own.
    expect(client.calls.map((c) => `${c.kind}:${c.schemaName ?? ''}:${c.images}`)).toEqual(['image::2', 'vision:outfit:2', 'image::2', 'vision:face_check:2']);
    expect(client.calls[2].prompt).toContain('Apply makeup to the person in image 1: classic retro makeup');
    expect(client.calls[2].prompt).toContain('Image 2 shows the same person without makeup');
    expect(await getTryon(db, key, 'front', avatarVersion(avatar))).toMatch(/^mem:\/\/tryon\//);
    expect(await getTryon(db, made, 'front', avatarVersion(avatar))).toMatch(/^mem:\/\/tryon\//);
  });

  it('redraws the makeup once when the face changed, then gives up without saving it', async () => {
    const { avatar, tee, key, made } = await setup();
    await putPlain(key, avatar);
    const client = fakeClient();
    faceAnswers(client, [false, true]);
    await enqueueJob(db, 'tryon', tryonRef(made, 'front'), { itemIds: [tee.id], styling: {}, makeup: 'redlip' });
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls.filter((c) => c.kind === 'image').length).toBe(2);
    expect(await getTryon(db, made, 'front', avatarVersion(avatar))).not.toBeNull();

    const other = fakeClient();
    faceAnswers(other, [false, false]);
    const ref = tryonRef(lookKey([tee.id], {}, () => 'top', 'smoky'), 'front');
    await enqueueJob(db, 'tryon', ref, { itemIds: [tee.id], styling: {}, makeup: 'smoky' });
    await drain(new JobRunner(deps(other), noTimers));
    expect(other.calls.filter((c) => c.kind === 'image').length).toBe(2);
    expect(await latestJobFor(db, 'tryon', ref)).toMatchObject({ status: 'failed', lastError: '化妆后看起来不像你了，这次没有保存，可以再试一次' });
  });

  async function putPlain(key: string, avatar: Awaited<ReturnType<typeof saveAvatar>>) {
    await putTryon(db, key, 'front', avatarVersion(avatar), 'mem://tryon/plain');
  }

  it('puts makeup on the avatar itself when nothing is worn', async () => {
    const avatar = await saveAvatar(db, { frontUri: 'mem://avatar/f', backUri: 'mem://avatar/b', status: 'ready' });
    const client = fakeClient();
    faceAnswers(client, [true]);
    const key = lookKey([], {}, () => undefined, 'natural');
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: [], styling: {}, makeup: 'natural' });
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls.map((c) => `${c.kind}:${c.images}`)).toEqual(['image:1', 'vision:2']);
    expect(client.calls[0].prompt).not.toContain('Image 2');
    expect(await getTryon(db, key, 'front', avatarVersion(avatar))).not.toBeNull();
  });

  it('uses the model, quality and notes chosen on the sheet', async () => {
    const { tee, key } = await setup();
    const k = (await listKeys(db))[0];
    const client = fakeClient();
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: [tee.id], styling: {}, model: { keyId: k.id, model: 'gpt-image-1' }, quality: 'high', hint: '袖子卷起' });
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls[0]).toMatchObject({ model: 'gpt-image-1', quality: 'high' });
    expect(client.calls[0].prompt).toMatch(/Notes from the user, follow them: 袖子卷起$/);
  });
});

describe('outfit checks', () => {
  async function dressed() {
    const avatar = await saveAvatar(db, { frontUri: 'mem://avatar/f', backUri: 'mem://avatar/b', status: 'ready' });
    const a = await createItem(db, { name: '白T恤', slot: 'top', status: 'active', catalogUri: 'mem://catalog/a' });
    const b = await createItem(db, { name: '牛仔裤', slot: 'bottom', status: 'active', catalogUri: 'mem://catalog/b' });
    return { avatar, ids: [a.id, b.id], key: outfitKey([a.id, b.id]) };
  }

  it('redraws a front try-on once when the check finds a problem, naming it', async () => {
    const { avatar, ids, key } = await dressed();
    const client = fakeClient({ outfit: [{ fullBody: false, problems: ['牛仔裤变成了短裤'] }, { fullBody: true, problems: [] }] });
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: ids });
    await drain(new JobRunner(deps(client), noTimers));
    const drawn = client.calls.filter((c) => c.kind === 'image');
    expect(drawn).toHaveLength(2);
    expect(drawn[1].prompt).toContain('牛仔裤变成了短裤');
    expect(client.calls.filter((c) => c.schemaName === 'outfit')).toHaveLength(2);
    expect(await getTryon(db, key, 'front', avatarVersion(avatar))).toMatch(/^mem:\/\/tryon\//);
  });

  it('keeps the better of the two drawings, not the last one', async () => {
    const { avatar, ids, key } = await dressed();
    const client = fakeClient({
      outfit: [{ fullBody: true, problems: ['印花偏小'] }, { fullBody: false, problems: ['牛仔裤变成了短裤'] }],
      image: (call) => `draft${call}`,
    });
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: ids });
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls.filter((c) => c.kind === 'image')).toHaveLength(2);
    expect(images.files.get((await getTryon(db, key, 'front', avatarVersion(avatar)))!)).toBe('draft0');
  });

  it('keeps a front try-on that passes the check after one drawing', async () => {
    const { ids, key } = await dressed();
    const client = fakeClient();
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: ids });
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls.map((c) => c.schemaName ?? c.kind)).toEqual(['image', 'outfit']);
  });

  it('draws the photo from the dressed front when there is one, and checks it the same way', async () => {
    const { avatar, ids, key } = await dressed();
    await putTryon(db, key, 'front', avatarVersion(avatar), 'mem://tryon/front');
    const client = fakeClient({ outfit: [{ fullBody: true, problems: ['裤子变短了'] }, { fullBody: true, problems: [] }] });
    await generatePhoto(deps(client), ids, 'street');
    const drawn = client.calls.filter((c) => c.kind === 'image');
    expect(drawn).toHaveLength(2);
    expect(drawn[0].prompt).toContain('already wearing');
    expect(drawn[1].prompt).toContain('裤子变短了');
  });

  it('draws the photo from the plain avatar when no try-on is cached', async () => {
    const { ids } = await dressed();
    const client = fakeClient();
    await generatePhoto(deps(client), ids, 'street');
    expect(client.calls.find((c) => c.kind === 'image')!.prompt).not.toContain('already wearing');
  });
});
