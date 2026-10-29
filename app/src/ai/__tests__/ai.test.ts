import { createTestDb } from '@/test/memoryDb';
import type { Db } from '@/db/db';
import { createItem, getItem } from '@/db/items';
import { enqueueJob, listJobs } from '@/db/jobs';
import { addUsage, getAvatar, getSetting, getTryon, monthSpend, saveAvatar, avatarVersion } from '@/db/misc';
import { AiError, classify, createOpenAiClient, type FetchLike, type OpenAiClient, reasoningEffort } from '../client';
import { getAiBlocked, getModelChoice, saveAiSettings } from '../config';
import { type AiDeps, applyAutofill, matchMirror, tryonRef } from '../engine';
import type { ImageStore } from '../imageStore';
import { blockModel, EMPTY_CHOICE, imageCost, pickModels } from '../models';
import type { AutofillResult } from '../prompts';
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
  fromTag: ['size', 'material'],
};

type Call = { kind: 'image' | 'vision'; model: string; schemaName?: string; images: number; n?: number };

function fakeClient(opts: { failImage?: (model: string, i: number) => AiError | null; models?: string[] } = {}): OpenAiClient & { calls: Call[] } {
  const calls: Call[] = [];
  let imageCalls = 0;
  return {
    calls,
    async listModels() {
      return opts.models ?? ['gpt-image-1-mini', 'gpt-image-1', 'gpt-5.4-nano', 'gpt-4o-mini'];
    },
    async imageEdit(req) {
      calls.push({ kind: 'image', model: req.model, images: req.images.length, n: req.n });
      const err = opts.failImage?.(req.model, imageCalls++);
      if (err) throw err;
      return { images: Array.from({ length: req.n ?? 1 }, (_, i) => `img${i}`), usage: { textIn: 30, imageIn: 256, out: 408 } };
    },
    async visionJson<T>(req: { model: string; schemaName: string; images: string[] }) {
      calls.push({ kind: 'vision', model: req.model, schemaName: req.schemaName, images: req.images.length });
      let data: unknown;
      if (req.schemaName === 'garment') data = AUTOFILL;
      else if (req.schemaName === 'fidelity')
        data = { candidates: [{ checks: [{ label: '主色', ok: true, note: '一致' }] }, { checks: [{ label: '主色', ok: false, note: '偏浅' }] }] };
      else data = { matches: [], unmatched: [] };
      return { data: data as T, usage: { in: 1000, out: 100 } };
    },
  };
}

let db: Db;
let images: MemoryImages;
beforeEach(async () => {
  db = await createTestDb();
  images = new MemoryImages();
});

function deps(client: OpenAiClient | null): AiDeps {
  return { db, images, getClient: async () => client };
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

describe('models', () => {
  it('picks the cheapest available models and falls back when one is blocked', () => {
    const avail = ['gpt-4o', 'gpt-image-1', 'gpt-image-1-mini', 'gpt-4o-mini', 'gpt-5.4-nano'];
    expect(pickModels(avail)).toEqual({ image: 'gpt-image-1-mini', vision: 'gpt-5.4-nano' });
    const next = blockModel({ ...EMPTY_CHOICE, image: 'gpt-image-1-mini', vision: 'gpt-5.4-nano' }, 'gpt-5.4-nano', avail);
    expect(next.vision).toBe('gpt-4o-mini');
    expect(next.blocked).toEqual(['gpt-5.4-nano']);
    expect(pickModels(['whisper-1'])).toEqual({ image: null, vision: null });
  });

  it('estimates image cost from usage', () => {
    expect(imageCost('gpt-image-1-mini', { textIn: 32, imageIn: 256, out: 408 })).toBeCloseTo(0.00397, 4);
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
    expect(after.candidates).toHaveLength(2);
    expect(after.checks[1][0]).toEqual({ label: '主色', ok: false, note: '偏浅' });
    expect(client.calls.map((c) => c.schemaName ?? c.kind)).toEqual(['garment', 'image', 'fidelity']);
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
    expect(client.calls.filter((c) => c.schemaName === 'garment')).toHaveLength(1);
  });

  it('pauses without a key and resumes once one is provided', async () => {
    const item = await newGarment();
    let client: OpenAiClient | null = null;
    const runner = new JobRunner({ db, images, getClient: async () => client }, noTimers);
    await drain(runner);
    expect(await getAiBlocked(db)).toBe('no_key');
    const [job] = await listJobs(db, ['queued']);
    expect(job.attempts).toBe(0);
    expect((await getItem(db, item.id))!.status).toBe('processing');
    client = fakeClient();
    await drain(runner);
    expect((await getItem(db, item.id))!.status).toBe('review');
    expect(await getAiBlocked(db)).toBeNull();
  });

  it('switches to the next image model when one is deprecated', async () => {
    await newGarment();
    const client = fakeClient({ failImage: (m) => (m === 'gpt-image-1-mini' ? new AiError('model', 'deprecated') : null) });
    await drain(new JobRunner(deps(client), noTimers));
    expect(client.calls.filter((c) => c.kind === 'image').map((c) => c.model)).toEqual(['gpt-image-1-mini', 'gpt-image-1']);
    expect((await getModelChoice(db)).blocked).toContain('gpt-image-1-mini');
  });

  it('retries transient failures with backoff, then marks the item failed', async () => {
    const item = await newGarment();
    let now = new Date(Date.now() + 1000);
    const client = fakeClient({ failImage: () => new AiError('server', '502') });
    const runner = new JobRunner({ db, images, getClient: async () => client, now: () => now }, noTimers);
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
    expect(client.calls.at(-1)?.images).toBe(3);
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
    expect(r.matches.map((m) => ids.get(m.itemId))).toEqual(['c', 'b']);
    expect(r.matches[0].note).toBe('裤脚堆在鞋面上');
    expect(r.unmatched).toEqual(['灰色围巾']);
    expect(await getSetting(db, 'ai.blocked')).toBeNull();
  });
});
