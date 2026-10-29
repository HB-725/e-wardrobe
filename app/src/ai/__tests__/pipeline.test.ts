import { createTestDb } from '@/test/memoryDb';
import type { Db } from '@/db/db';
import { createItem, getItem, updateItem } from '@/db/items';
import { claimNextJob, enqueueJob, listJobs } from '@/db/jobs';
import { addUsage, getAvatar, getTryon, monthSpend, saveAvatar, setSetting } from '@/db/misc';
import type { Item } from '@/domain/types';
import { type AiClient, type AiDeps, cleanMirrorResult, identifyFromMirror, markJobFailed, mergeAutofill, runJob } from '../pipeline';
import { JobRunner, BUDGET_SETTING } from '../runner';
import { OpenAIError } from '../openai';
import type { AutofillResult } from '../prompts';

function fakeFiles() {
  const saved: string[] = [];
  const deleted: string[] = [];
  return {
    saved,
    deleted,
    readBase64: async (uri: string) => `b64(${uri})`,
    saveBase64Image: (b64: string) => {
      const uri = `file:///gen/${saved.length}.jpg`;
      saved.push(uri);
      return uri;
    },
    imageInput: (uri: string) => ({ uri, name: 'x.jpg', type: 'image/jpeg' }),
    deleteImage: (uri: string | null | undefined) => {
      if (uri) deleted.push(uri);
    },
  };
}

const AUTOFILL: AutofillResult = {
  is_clothing: true, slot: 'outer', name: '牛仔夹克', subcategory: '夹克', color_name: '靛蓝', color_hex: '#2E4466',
  seasons: ['spring', 'autumn'], brand: null, size: 'M', material: '棉',
};

function fakeClient(overrides: Partial<AiClient> = {}) {
  const calls: { kind: string; args: any }[] = [];
  const client: AiClient = {
    chatJson: async (args: any) => {
      calls.push({ kind: 'chat', args });
      if (args.schemaName === 'garment') return { data: AUTOFILL as any, usage: { inputTokens: 1000, outputTokens: 100 } };
      if (args.schemaName === 'fidelity')
        return { data: { same_item: true, checks: [{ label: '颜色', ok: true, note: '一致' }] } as any, usage: { inputTokens: 500, outputTokens: 50 } };
      throw new Error('unexpected');
    },
    editImage: async (args: any) => {
      calls.push({ kind: 'edit', args });
      return { b64: 'IMG', usage: { inputTokens: 100, imageInputTokens: 300, outputTokens: 1000 } };
    },
    ...overrides,
  };
  return { client, calls };
}

let db: Db;
let files: ReturnType<typeof fakeFiles>;
const models = { image: 'gpt-image-1-mini', vision: 'gpt-4.1-mini' };

beforeEach(async () => {
  db = await createTestDb();
  files = fakeFiles();
});

async function newPhotoItem(extra: Partial<Item> = {}) {
  return createItem(db, { name: '新单品', slot: 'top', status: 'processing', originalUri: 'file:///orig.jpg', ...extra });
}

describe('mergeAutofill', () => {
  it('fills fields, tags brand/size/material from the tag photo, and never overwrites user edits', async () => {
    const item = await newPhotoItem({ fieldSources: { name: 'user' }, name: '我的夹克' });
    const patch = mergeAutofill(item, { ...AUTOFILL, brand: 'ACME' }, true);
    expect(patch.name).toBeUndefined();
    expect(patch.slot).toBe('outer');
    expect(patch.brand).toBe('ACME');
    expect(patch.fieldSources).toMatchObject({ name: 'user', slot: 'ai', brand: 'tag', size: 'tag', colorName: 'ai' });
  });

  it('drops invalid values', async () => {
    const item = await newPhotoItem();
    const patch = mergeAutofill(item, { ...AUTOFILL, color_hex: 'blue', seasons: [] }, false);
    expect(patch.colorHex).toBeUndefined();
    expect(patch.seasons).toBeUndefined();
    expect(patch.fieldSources?.size).toBe('ai');
  });
});

describe('jobs', () => {
  it('autofill then catalog takes a new item to review with a fidelity report and records spend', async () => {
    const { client, calls } = fakeClient();
    const deps: AiDeps = { db, client, models, files };
    const item = await newPhotoItem({ tagUri: 'file:///tag.jpg' });
    await enqueueJob(db, 'autofill', item.id);
    await runJob(deps, (await claimNextJob(db, new Date(Date.now() + 1000)))!);
    expect(calls[0].args.content).toHaveLength(3);
    const catalogJob = await claimNextJob(db, new Date(Date.now() + 1000));
    expect(catalogJob?.type).toBe('catalog');
    await runJob(deps, catalogJob!);
    const edit = calls.find((c) => c.kind === 'edit')!;
    expect(edit.args.prompt).toContain('outerwear');
    expect(edit.args.inputFidelity).toBeUndefined();
    const done = await getItem(db, item.id);
    expect(done?.status).toBe('review');
    expect(done?.name).toBe('牛仔夹克');
    expect(done?.catalogUri).toBe('file:///gen/0.jpg');
    expect(done?.fidelity?.sameItem).toBe(true);
    expect((await monthSpend(db)).totalUsd).toBeGreaterThan(0);
  });

  it('marks non-clothing photos as failed without generating an image', async () => {
    const { client, calls } = fakeClient({
      chatJson: async () => ({ data: { ...AUTOFILL, is_clothing: false } as any, usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    const item = await newPhotoItem();
    await enqueueJob(db, 'autofill', item.id);
    await runJob({ db, client, models, files }, (await claimNextJob(db, new Date(Date.now() + 1000)))!);
    expect((await getItem(db, item.id))?.status).toBe('failed');
    expect(calls.some((c) => c.kind === 'edit')).toBe(false);
    expect(await claimNextJob(db, new Date(Date.now() + 1000))).toBeNull();
  });

  it('regenerating an active item keeps it active and deletes the old image', async () => {
    const { client } = fakeClient();
    const item = await newPhotoItem({ status: 'active', catalogUri: 'file:///old.jpg' });
    await enqueueJob(db, 'catalog', item.id);
    await runJob({ db, client, models, files }, (await claimNextJob(db, new Date(Date.now() + 1000)))!);
    const after = await getItem(db, item.id);
    expect(after?.status).toBe('active');
    expect(files.deleted).toContain('file:///old.jpg');
  });

  it('final failure surfaces on the item; autofill failure still proceeds to catalog', async () => {
    const item = await newPhotoItem();
    const j = await enqueueJob(db, 'catalog', item.id);
    await markJobFailed(db, j, 'boom');
    expect((await getItem(db, item.id))?.status).toBe('failed');
    const a = await enqueueJob(db, 'autofill', item.id);
    await markJobFailed(db, a, 'x');
    expect((await listJobs(db, ['queued'])).some((x) => x.type === 'catalog')).toBe(true);
  });

  it('avatar then try-on caches the image per combination and view', async () => {
    const { client, calls } = fakeClient();
    const deps: AiDeps = { db, client, models: { ...models, image: 'gpt-image-1' }, files };
    await saveAvatar(db, { sourceUris: ['file:///me.jpg'], heightCm: 175, status: 'processing' });
    await enqueueJob(db, 'avatar', 'me');
    await runJob(deps, (await claimNextJob(db, new Date(Date.now() + 1000)))!);
    const avatar = await getAvatar(db);
    expect(avatar.status).toBe('ready');
    expect(calls[0].args.prompt).toContain('175 cm');
    expect(calls[0].args.inputFidelity).toBe('high');

    const a = await createItem(db, { name: '夹克', slot: 'outer', status: 'active', catalogUri: 'file:///a.jpg' });
    const b = await createItem(db, { name: 'T恤', slot: 'top', status: 'active', catalogUri: 'file:///b.jpg' });
    await enqueueJob(db, 'tryon', 'k1', { key: 'k1', itemIds: [a.id, b.id], view: 'front' });
    await runJob(deps, (await claimNextJob(db, new Date(Date.now() + 1000)))!);
    const tryCall = calls[calls.length - 1];
    expect(tryCall.args.images.map((i: any) => i.uri)).toEqual([avatar.frontUri, 'file:///a.jpg', 'file:///b.jpg']);
    expect(await getTryon(db, 'k1', 'front', avatar.frontUri!)).toBe('file:///gen/1.jpg');
  });

  it('try-on without an avatar is a permanent error', async () => {
    const { client } = fakeClient();
    const j = await enqueueJob(db, 'tryon', 'k', { key: 'k', itemIds: [] });
    await expect(runJob({ db, client, models, files }, j)).rejects.toThrow('请先建立个人形象');
  });
});

describe('mirror', () => {
  it('keeps the best known match per slot above the floor', () => {
    const items = [
      { id: 'a', slot: 'top' as const },
      { id: 'b', slot: 'top' as const },
      { id: 'c', slot: 'bottom' as const },
    ];
    const r = cleanMirrorResult(
      {
        matches: [{ id: 'a', confidence: 0.6 }, { id: 'b', confidence: 0.9 }, { id: 'c', confidence: 0.3 }, { id: 'zzz', confidence: 1 }],
        unmatched: ['黑色帽子'],
        fit_notes: [{ id: 'b', note: '偏宽松' }],
      },
      items,
    );
    expect(r.matches).toEqual([{ itemId: 'b', confidence: 0.9, fitNote: '偏宽松' }]);
    expect(r.unmatched).toEqual(['黑色帽子']);
  });

  it('sends the wardrobe list and photo', async () => {
    const seen: any[] = [];
    const client = fakeClient({
      chatJson: async (args: any) => {
        seen.push(args);
        return { data: { matches: [{ id: 'x', confidence: 0.8 }], unmatched: [], fit_notes: [] } as any, usage: { inputTokens: 1, outputTokens: 1 } };
      },
    }).client;
    const x = await createItem(db, { name: '牛仔裤', slot: 'bottom', status: 'active' });
    const res = await identifyFromMirror({ db, client, models, files }, 'file:///mirror.jpg', [{ ...x, id: 'x' }]);
    expect(res.matches[0].itemId).toBe('x');
    expect(seen[0].content[0].text).toContain('牛仔裤');
  });
});

describe('JobRunner', () => {
  const flush = () => new Promise((r) => setTimeout(r, 30));

  it('blocks without a key and processes once deps are available', async () => {
    const { client } = fakeClient();
    let deps: AiDeps | null = null;
    const runner = new JobRunner(db, async () => deps, () => {}, 1);
    const item = await newPhotoItem();
    await enqueueJob(db, 'catalog', item.id);
    await runner.start();
    await flush();
    expect(runner.block).toBe('no-key');
    deps = { db, client, models, files };
    runner.kick();
    await flush();
    runner.stop();
    expect((await getItem(db, item.id))?.status).toBe('review');
    expect(runner.block).toBeNull();
  });

  it('stops at the monthly budget', async () => {
    const { client } = fakeClient();
    await setSetting(db, BUDGET_SETTING, '1');
    await addUsage(db, { kind: 'catalog', model: 'm', costUsd: 1.5 });
    const runner = new JobRunner(db, async () => ({ db, client, models, files }), () => {}, 1);
    await enqueueJob(db, 'catalog', (await newPhotoItem()).id);
    await runner.start();
    await flush();
    runner.stop();
    expect(runner.block).toBe('over-budget');
    expect((await listJobs(db, ['queued'])).length).toBe(1);
  });

  it('retries retryable errors and fails permanent ones', async () => {
    const client = fakeClient({
      editImage: async () => {
        throw new OpenAIError('bad', 400, false);
      },
    }).client;
    const runner = new JobRunner(db, async () => ({ db, client, models, files }), () => {}, 1);
    const item = await newPhotoItem();
    await enqueueJob(db, 'catalog', item.id);
    await runner.start();
    await flush();
    runner.stop();
    const after = await getItem(db, item.id);
    expect(after?.status).toBe('failed');
    expect(after?.error).toBe('bad');
  });
});
