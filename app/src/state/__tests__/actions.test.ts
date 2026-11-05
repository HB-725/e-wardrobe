import { getAiSettings } from '@/ai/config';
import { getRoutes, setConsentFor } from '@/ai/keys';
import { withBox } from '@/domain/crop';
import type { Detection } from '@/domain/types';
import * as XLSX from 'xlsx';
import { createTestDb } from '@/test/memoryDb';
import type { Db } from '@/db/db';
import { createItem, getItem, listItems } from '@/db/items';
import { enqueueJob, latestJobFor, listJobs } from '@/db/jobs';
import { listOutfits } from '@/db/outfits';
import { getLogByDate, listLogs } from '@/db/wear';
import { buildWorkbook, decodeUtf8, isDuplicate, parseWorkbook } from '@/domain/excel';
import type { ImageStore } from '@/ai/imageStore';
import { addFitNote, addGarments, confirmItem, confirmPicks, cropItem, keepCurrent, regenerateWith, keepOriginal, recordWear, removeItem, requestTryon, saveOutfit, tryonState, undoWear, userSources } from '../actions';
import { avatarVersion, putTryon, saveAvatar } from '@/db/misc';
import { outfitKey } from '@/domain/outfit';
import { tryonRef } from '@/ai/engine';
import { fitOf, formOf, formProblems, normalizeDate, patchOf } from '@/ui/ItemForm';

class Images implements ImageStore {
  removed: string[] = [];
  n = 0;
  async toDataUrl(u: string) {
    return u;
  }
  async saveBase64() {
    return `mem://${++this.n}`;
  }
  async importPhoto(_u: string, folder: string) {
    return `mem://${folder}/${++this.n}`;
  }
  async crop(_u: string, _box: unknown, folder: string) {
    return `mem://${folder}/crop${++this.n}`;
  }
  async size() {
    return { width: 1024, height: 1536 };
  }
  async layer(dressedB64: string, greenUri: string) {
    return `mem://layer/${dressedB64.length}-${greenUri.length}`;
  }
  async remove(u: string | null | undefined) {
    if (u) this.removed.push(u);
  }
  async wipe() {}
}

let db: Db;
let images: Images;
let kicks = 0;
const ctx = () => ({ db, images, runner: { kick: () => (kicks += 1) } });

beforeEach(async () => {
  db = await createTestDb();
  await setConsentFor(db, 'openai');
  images = new Images();
  kicks = 0;
});

describe('garment flow', () => {
  it('imports photos, queues one catalog job per item and wakes the runner', async () => {
    const items = await addGarments(ctx(), [{ uri: 'a' }, { uri: 'b', tagUri: 't' }]);
    expect(items).toHaveLength(2);
    expect(items[1].tagUri).toMatch(/^mem:\/\/tag\//);
    expect((await listJobs(db, ['queued'])).map((j) => j.refId).sort()).toEqual(items.map((i) => i.id).sort());
    expect(kicks).toBe(1);
  });

  it('confirming keeps the chosen candidate and deletes the others', async () => {
    const it = await createItem(db, { name: 'x', slot: 'top', status: 'review', candidates: ['c1', 'c2'], checks: [[], []] });
    await confirmItem(ctx(), it.id, 1, { name: '白衬衫' });
    const after = (await getItem(db, it.id))!;
    expect(after).toMatchObject({ status: 'active', catalogUri: 'c2', candidates: [], checks: [], name: '白衬衫' });
    expect(images.removed).toEqual(['c1']);
  });

  it('keeping the original drops queued jobs and all candidates', async () => {
    const it = await createItem(db, { name: 'x', slot: 'top', status: 'processing', originalUri: 'o', candidates: ['c1'] });
    await enqueueJob(db, 'catalog', it.id);
    await keepOriginal(ctx(), it.id);
    expect((await getItem(db, it.id))!).toMatchObject({ status: 'active', catalogUri: null });
    expect(await listJobs(db, ['queued'])).toHaveLength(0);
    expect(images.removed).toContain('c1');
    expect(images.removed).not.toContain('o');
  });

  it('removing an item deletes its files and outfits / days left empty', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active', originalUri: 'o', catalogUri: 'c' });
    const b = await createItem(db, { name: 'b', slot: 'bottom', status: 'active' });
    await saveOutfit(ctx(), { name: 'solo', occasions: [], itemIds: [a.id] });
    await saveOutfit(ctx(), { name: 'pair', occasions: [], itemIds: [a.id, b.id] });
    await recordWear(ctx(), { date: '2026-10-01', itemIds: [a.id], source: 'manual' });
    await recordWear(ctx(), { date: '2026-10-02', itemIds: [a.id, b.id], source: 'manual' });
    await removeItem(ctx(), a.id);
    expect(images.removed).toEqual(expect.arrayContaining(['o', 'c']));
    expect((await listOutfits(db)).map((o) => [o.name, o.itemIds])).toEqual([['pair', [b.id]]]);
    expect((await listLogs(db)).map((l) => l.date)).toEqual(['2026-10-02']);
  });
});

describe('outfits & wear', () => {
  it('saving the same garments again updates the existing outfit', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    const b = await createItem(db, { name: 'b', slot: 'bottom', status: 'active' });
    const o1 = await saveOutfit(ctx(), { name: '一', occasions: ['work'], itemIds: [a.id, b.id] });
    const o2 = await saveOutfit(ctx(), { name: '二', occasions: ['date'], itemIds: [b.id, a.id] });
    expect(o2.id).toBe(o1.id);
    expect(o2.name).toBe('二');
    expect(await listOutfits(db)).toHaveLength(1);
  });

  it('links a logged combination to the matching saved outfit, and undo removes the photo', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    const o = await saveOutfit(ctx(), { name: 'o', occasions: [], itemIds: [a.id] });
    await recordWear(ctx(), { date: '2026-10-29', itemIds: [a.id], source: 'mirror', photoUri: 'p1' });
    expect((await getLogByDate(db, '2026-10-29'))!.outfitId).toBe(o.id);
    await recordWear(ctx(), { date: '2026-10-29', itemIds: [a.id], source: 'mirror', photoUri: 'p2' });
    expect(images.removed).toEqual(['p1']);
    await undoWear(ctx(), '2026-10-29');
    expect(images.removed).toEqual(['p1', 'p2']);
    expect(await getLogByDate(db, '2026-10-29')).toBeNull();
  });

  it('appends fit notes once', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active', fitNotes: '偏大' });
    await addFitNote(ctx(), a.id, '衣长到胯部', '10 月 29 日');
    await addFitNote(ctx(), a.id, '衣长到胯部', '10 月 30 日');
    expect((await getItem(db, a.id))!.fitNotes).toBe('偏大\n衣长到胯部（10 月 29 日 镜子照片）');
  });
});

describe('excel', () => {
  it('round-trips the export through the importer', async () => {
    const a = await createItem(db, { name: '牛仔夹克', slot: 'outer', status: 'active', seasons: ['spring', 'autumn'], priceCents: 39950, purchasedOn: '2025-09-14', colorName: '靛蓝' });
    const b = await createItem(db, { name: '旧T恤', slot: 'top', status: 'archived' });
    await recordWear(ctx(), { date: '2026-10-01', itemIds: [a.id], source: 'manual' });
    const b64 = buildWorkbook(await listItems(db), await listOutfits(db), await listLogs(db), new Date(2026, 9, 29));
    const r = parseWorkbook(b64);
    expect(r.skipped).toEqual([]);
    const jacket = r.items.find((i) => i.name === '牛仔夹克')!;
    expect(jacket).toMatchObject({ slot: 'outer', seasons: ['spring', 'autumn'], priceCents: 39950, purchasedOn: '2025-09-14', colorName: '靛蓝', archived: false });
    expect(r.items.find((i) => i.name === '旧T恤')!.archived).toBe(true);
    expect(isDuplicate(await listItems(db), jacket)).toBe(true);
    expect(b.id).toBeTruthy();
  });

  it('accepts hand-made sheets and reports unusable rows', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['名称', '品类', '季节', '价格', '购买日期'],
      ['白衬衫', '上衣', '春,秋', '¥199', '2024/5'],
      ['帽子', '帽类', '', '', ''],
      ['', '', '', '', ''],
      ['', '鞋', '', '', ''],
      ['皮鞋', 'shoes', '冬', 899, 45000],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const r = parseWorkbook(XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }));
    expect(r.items.map((i) => [i.name, i.slot, i.seasons, i.priceCents, i.purchasedOn])).toEqual([
      ['白衬衫', 'top', ['spring', 'autumn'], 19900, '2024-05-01'],
      ['帽子', 'accessory', [], null, null], // 帽类 is recognised by keyword
      ['皮鞋', 'shoes', ['winter'], 89900, '2023-03-15'],
    ]);
    expect(r.skipped.map((s) => s.row)).toEqual([5]);
  });

  it('marks imported fields as user-entered so the AI keeps them', () => {
    expect(userSources({ name: 'x', brand: null, seasons: [], size: 'M' })).toEqual({ name: 'user', size: 'user' });
  });
});

describe('form helpers', () => {
  it('normalizes loose dates', () => {
    expect(normalizeDate('2025-9')).toBe('2025-09-01');
    expect(normalizeDate('2025年9月14日')).toBe('2025-09-14');
    expect(normalizeDate('2025-13-01')).toBeNull();
    expect(normalizeDate('')).toBeNull();
  });
});

describe('review fixes', () => {
  it('adding a garment to today keeps the mirror photo', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    const b = await createItem(db, { name: 'b', slot: 'bottom', status: 'active' });
    await recordWear(ctx(), { date: '2026-10-29', itemIds: [a.id], source: 'mirror', photoUri: 'p1' });
    await recordWear(ctx(), { date: '2026-10-29', itemIds: [a.id, b.id], source: 'manual' });
    const log = (await getLogByDate(db, '2026-10-29'))!;
    expect(log.photoUri).toBe('p1');
    expect(log.source).toBe('mirror');
    expect(images.removed).toEqual([]);
    await recordWear(ctx(), { date: '2026-10-29', itemIds: [b.id], source: 'manual' });
    expect(images.removed).toEqual(['p1']);
  });

  it('deleting an item removes photos of days that become empty', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    await recordWear(ctx(), { date: '2026-10-01', itemIds: [a.id], source: 'mirror', photoUri: 'm1' });
    await removeItem(ctx(), a.id);
    expect(images.removed).toContain('m1');
  });

  it('keeping the current image after a regeneration discards the new candidates', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active', catalogUri: 'cur', candidates: ['n1', 'n2'] });
    await keepCurrent(ctx(), a.id);
    expect((await getItem(db, a.id))!).toMatchObject({ catalogUri: 'cur', candidates: [], status: 'active' });
    expect(images.removed).toEqual(['n1', 'n2']);
  });
});

describe('round 2 fixes', () => {
  it('replacing the photo of a wardrobe item keeps it active and queues a catalog job', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active', originalUri: 'old', catalogUri: 'c' });
    const { setItemPhoto } = jest.requireActual('../actions') as typeof import('../actions');
    await setItemPhoto(ctx(), a.id, 'new');
    const after = (await getItem(db, a.id))!;
    expect(after.status).toBe('active');
    expect(after.originalUri).toMatch(/^mem:\/\/original\//);
    expect(images.removed).toContain('old');
    expect(await listJobs(db, ['queued'])).toHaveLength(1);
  });

  it('treats same-name items with different colour or size as distinct on import', () => {
    const base = { name: '白T恤', slot: 'top' as const, colorName: '白', size: 'M', brand: null };
    const imported = { name: '白T恤', slot: 'top' as const, subcategory: null, colorName: '白', seasons: [], brand: null, size: 'L', material: null, priceCents: null, purchasedOn: null, channel: null, location: null, fitNotes: null, archived: false };
    expect(isDuplicate([base], imported)).toBe(false);
    expect(isDuplicate([base], { ...imported, size: 'M' })).toBe(true);
  });
});

describe('round 5', () => {
  it('drops cached try-ons that include an item whose picture changed or that was deleted', async () => {
    const { putTryon, getTryon } = jest.requireActual('@/db/misc') as typeof import('@/db/misc');
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'review', catalogUri: 'old', candidates: ['new'] });
    const b = await createItem(db, { name: 'b', slot: 'bottom', status: 'active' });
    await putTryon(db, [a.id, b.id].sort().join('+'), 'front', 'v', 'tryon-ab');
    await putTryon(db, b.id, 'front', 'v', 'tryon-b');
    await confirmItem(ctx(), a.id, 0);
    expect(await getTryon(db, [a.id, b.id].sort().join('+'), 'front', 'v')).toBeNull();
    expect(images.removed).toContain('tryon-ab');
    expect(await getTryon(db, b.id, 'front', 'v')).toBe('tryon-b');
    await removeItem(ctx(), b.id);
    expect(images.removed).toContain('tryon-b');
  });

  it('cleans up orphaned image files but keeps recent and referenced ones', async () => {
    const { cleanOrphanImages } = jest.requireActual('../actions') as typeof import('../actions');
    await createItem(db, { name: 'a', slot: 'top', status: 'active', catalogUri: 'kept' });
    const now = Date.now();
    const store = Object.assign(images, {
      listAll: async () => [
        { uri: 'kept', modified: 0 },
        { uri: 'orphan', modified: 0 },
        { uri: 'fresh', modified: now - 1000 },
      ],
    });
    expect(await cleanOrphanImages({ db, images: store, runner: { kick() {} } }, now)).toBe(1);
    expect(images.removed).toEqual(['orphan']);
  });
});

describe('try-on state', () => {
  it('keeps showing the cached image while a regeneration runs', async () => {
    const avatar = await saveAvatar(db, { frontUri: 'file:///f.jpg', status: 'ready' });
    const a = await createItem(db, { name: 'T', slot: 'top', status: 'active', catalogUri: 'file:///a.jpg' });
    const key = outfitKey([a.id]);
    await putTryon(db, key, 'front', avatarVersion(avatar), 'file:///t.jpg');
    expect(await tryonState(db, { ids: [a.id], styling: {} }, 'front')).toEqual({ uri: 'file:///t.jpg', status: 'none', error: null, missingMakeup: false });
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: [a.id] });
    expect(await tryonState(db, { ids: [a.id], styling: {} }, 'front')).toMatchObject({ uri: 'file:///t.jpg', status: 'queued' });
  });

  it('caches each layering and styling of the same garments separately, and the plain one under its old key', async () => {
    const avatar = await saveAvatar(db, { frontUri: 'file:///f.jpg', status: 'ready' });
    const tee = await createItem(db, { name: 'T', slot: 'top', status: 'active', catalogUri: 'file:///tee.jpg' });
    const shirt = await createItem(db, { name: 'S', slot: 'top', status: 'active', catalogUri: 'file:///shirt.jpg' });
    const jacket = await createItem(db, { name: 'J', slot: 'outer', status: 'active', catalogUri: 'file:///j.jpg' });
    await putTryon(db, outfitKey([tee.id, jacket.id]), 'front', avatarVersion(avatar), 'file:///old.jpg');
    expect((await tryonState(db, { ids: [tee.id, jacket.id], styling: {} }, 'front')).uri).toBe('file:///old.jpg');
    expect((await tryonState(db, { ids: [tee.id, jacket.id], styling: { [jacket.id]: { open: true } } }, 'front')).uri).toBeNull();
    await requestTryon(ctx(), { ids: [tee.id, shirt.id, jacket.id], styling: { [shirt.id]: { tucked: true } } }, 'front');
    const job = await latestJobFor(db, 'tryon', tryonRef(`${outfitKey([tee.id, shirt.id, jacket.id])}~${tee.id}>${shirt.id}:t>${jacket.id}`, 'front'));
    expect(job?.payload).toEqual({ itemIds: [tee.id, shirt.id, jacket.id], styling: { [shirt.id]: { tucked: true } } });
  });
});

describe('outfits keep layer order and styling', () => {
  it('saves, reads back and tells looks apart by order and styling', async () => {
    const tee = await createItem(db, { name: 'T', slot: 'top', status: 'active' });
    const shirt = await createItem(db, { name: 'S', slot: 'top', status: 'active' });
    const a = await saveOutfit(ctx(), { name: 'A', occasions: [], itemIds: [tee.id, shirt.id], styling: { [shirt.id]: { open: true } } });
    expect(a.itemIds).toEqual([tee.id, shirt.id]);
    expect(a.styling).toEqual({ [shirt.id]: { open: true } });
    const again = await saveOutfit(ctx(), { name: 'A2', occasions: ['work'], itemIds: [tee.id, shirt.id], styling: { [shirt.id]: { open: true } } });
    expect(again.id).toBe(a.id);
    const swapped = await saveOutfit(ctx(), { name: 'B', occasions: [], itemIds: [shirt.id, tee.id] });
    expect(swapped.id).not.toBe(a.id);
    expect((await listOutfits(db)).find((o) => o.id === swapped.id)?.itemIds).toEqual([shirt.id, tee.id]);
  });

  it('keeps the makeup, and the same garments made up differently are another outfit', async () => {
    const tee = await createItem(db, { name: 'T', slot: 'top', status: 'active' });
    const plain = await saveOutfit(ctx(), { name: 'A', occasions: [], itemIds: [tee.id] });
    expect(plain.makeup).toBeNull();
    const made = await saveOutfit(ctx(), { name: 'B', occasions: [], itemIds: [tee.id], makeup: 'date' });
    expect(made.id).not.toBe(plain.id);
    expect((await listOutfits(db)).find((o) => o.id === made.id)?.makeup).toBe('date');
    expect((await saveOutfit(ctx(), { name: 'B2', occasions: [], itemIds: [tee.id], makeup: 'date' })).id).toBe(made.id);
  });
});

describe('makeup and generation options', () => {
  it('shows the outfit without makeup until the made-up one exists, and the back without it', async () => {
    const avatar = await saveAvatar(db, { frontUri: 'file:///f.jpg', backUri: 'file:///b.jpg', status: 'ready' });
    const tee = await createItem(db, { name: 'T', slot: 'top', status: 'active', catalogUri: 'file:///tee.jpg' });
    const key = outfitKey([tee.id]);
    await putTryon(db, key, 'front', avatarVersion(avatar), 'file:///plain.jpg');
    await putTryon(db, key, 'back', avatarVersion(avatar), 'file:///back.jpg');
    const look = { ids: [tee.id], styling: {}, makeup: 'natural' };
    expect(await tryonState(db, look, 'front')).toEqual({ uri: 'file:///plain.jpg', status: 'none', error: null, missingMakeup: true });
    expect(await tryonState(db, look, 'back')).toEqual({ uri: 'file:///back.jpg', status: 'none', error: null, missingMakeup: false });
    await putTryon(db, `${key}~mk:natural`, 'front', avatarVersion(avatar), 'file:///made.jpg');
    expect(await tryonState(db, look, 'front')).toMatchObject({ uri: 'file:///made.jpg', missingMakeup: false });
    // Makeup alone goes on the avatar.
    expect(await tryonState(db, { ids: [], styling: {}, makeup: 'natural' }, 'front')).toMatchObject({ uri: null, missingMakeup: true });
  });

  it('sends the makeup and the sheet\'s choices with the job, drops makeup for the back, and can keep them', async () => {
    await saveAvatar(db, { frontUri: 'file:///f.jpg', backUri: 'file:///b.jpg', status: 'ready' });
    const tee = await createItem(db, { name: 'T', slot: 'top', status: 'active', catalogUri: 'file:///tee.jpg' });
    const key = outfitKey([tee.id]);
    const look = { ids: [tee.id], styling: {}, makeup: 'natural' };
    const model = { keyId: 'k1', model: 'gpt-image-1-mini' };
    await requestTryon(ctx(), look, 'front', { model, quality: 'high', hint: ' 袖子卷起 ' });
    expect((await latestJobFor(db, 'tryon', tryonRef(`${key}~mk:natural`, 'front')))?.payload).toEqual({ itemIds: [tee.id], styling: {}, makeup: 'natural', model, quality: 'high', hint: '袖子卷起' });
    await requestTryon(ctx(), look, 'back', { makeDefault: true, model, quality: 'medium' });
    expect((await latestJobFor(db, 'tryon', tryonRef(key, 'back')))?.payload).toEqual({ itemIds: [tee.id], styling: {}, model, quality: 'medium' });
    expect((await getRoutes(db)).tryon).toEqual(model);
    expect((await getAiSettings(db)).tryonQuality).toBe('medium');
  });

  it('retries a failed try-on with the new choices', async () => {
    await saveAvatar(db, { frontUri: 'file:///f.jpg', status: 'ready' });
    const tee = await createItem(db, { name: 'T', slot: 'top', status: 'active', catalogUri: 'file:///tee.jpg' });
    const ref = tryonRef(outfitKey([tee.id]), 'front');
    const job = await enqueueJob(db, 'tryon', ref, { itemIds: [tee.id] });
    await db.runAsync("UPDATE jobs SET status = 'failed' WHERE id = ?", [job.id]);
    await requestTryon(ctx(), { ids: [tee.id], styling: {} }, 'front', { hint: '更合身' });
    const again = await latestJobFor(db, 'tryon', ref);
    expect(again).toMatchObject({ id: job.id, status: 'queued' });
    expect(again?.payload).toMatchObject({ hint: '更合身' });
  });
});

describe('spreadsheet import details', () => {
  const b64 = (bytes: Buffer) => bytes.toString('base64');
  it('reads a UTF-8 CSV (with or without BOM) and refuses other encodings with a clear message', () => {
    const csv = '名称,品类,购买日期\n白衬衫,衬衫,2024-03-05\n牛仔裤,牛仔裤,2024-13-40\n帽子,棒球帽,\n';
    for (const bom of ['', '﻿']) {
      const r = parseWorkbook(b64(Buffer.from(bom + csv, 'utf8')), 'wardrobe.csv');
      expect(r.items.map((i) => [i.name, i.slot, i.purchasedOn])).toEqual([
        ['白衬衫', 'top', '2024-03-05'],
        ['牛仔裤', 'bottom', null],
        ['帽子', 'accessory', null],
      ]);
      expect(r.warnings).toEqual([{ row: 3, reason: '购买日期「2024-13-40」无法识别，已留空' }]);
    }
    const gbkLike = Buffer.from([0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0x0a]); // "名称," in GBK
    expect(() => parseWorkbook(b64(gbkLike), 'old.csv')).toThrow(/UTF-8/);
  });
});

describe('spreadsheet edge cases', () => {
  it('classifies tricky garment names', () => {
    const csv = '名称,品类\n' + ['包臀裙', '面包服', '西装裤', '西装裙', '羽绒裤', '牛仔外套', '皮衣', '吊带', '袜子', '鞋包', '帽衫', '连帽外套', '开衫', '托特包', '棒球帽', '运动鞋'].map((n) => `${n},${n}`).join('\n');
    const r = parseWorkbook(Buffer.from(csv, 'utf8').toString('base64'), 'x.csv');
    expect(Object.fromEntries(r.items.map((i) => [i.name, i.slot]))).toEqual({
      包臀裙: 'bottom', 面包服: 'outer', 西装裤: 'bottom', 西装裙: 'bottom', 羽绒裤: 'bottom', 牛仔外套: 'outer', 皮衣: 'outer', 吊带: 'top', 袜子: 'accessory', 鞋包: 'shoes', 帽衫: 'top', 连帽外套: 'outer', 开衫: 'top', 托特包: 'bag', 棒球帽: 'accessory', 运动鞋: 'shoes',
    });
  });

  it('guesses the category from 细类 or the name when 品类 is empty or unknown', () => {
    const csv = '名称,品类,细类\n黑色面包服,,\n灰色连帽卫衣,,\n小白鞋,,板鞋\n真丝方巾,丝巾类,\n神秘单品,,\n';
    const r = parseWorkbook(Buffer.from(csv, 'utf8').toString('base64'), 'x.csv');
    expect(r.items.map((i) => [i.name, i.slot])).toEqual([
      ['黑色面包服', 'outer'],
      ['灰色连帽卫衣', 'top'],
      ['小白鞋', 'shoes'],
      ['真丝方巾', 'accessory'],
    ]);
    expect(r.skipped).toEqual([{ row: 6, reason: '没有填品类，名称里也看不出是哪一类' }]);
    expect(r.warnings).toEqual([]);
  });

  it('falls back to the name when 品类 is filled with something unknown, and says so', () => {
    const csv = '名称,品类\n羊毛大衣,冬季\n旧东西,杂物\n';
    const r = parseWorkbook(Buffer.from(csv, 'utf8').toString('base64'), 'x.csv');
    expect(r.items.map((i) => [i.name, i.slot])).toEqual([['羊毛大衣', 'outer']]);
    expect(r.warnings).toEqual([{ row: 2, reason: '品类「冬季」无法识别，按名称归为外套' }]);
    expect(r.skipped).toEqual([{ row: 3, reason: '品类「杂物」无法识别' }]);
  });

  it('finds the header row below a blank or title row and numbers rows from the sheet', () => {
    const ws = XLSX.utils.aoa_to_sheet([['我的衣橱清单'], [], ['名称', '品类'], ['夹克', '外套'], ['', '鞋']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const r = parseWorkbook(XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }));
    expect(r.items.map((i) => [i.name, i.slot])).toEqual([['夹克', 'outer']]);
    expect(r.skipped).toEqual([{ row: 5, reason: '缺少名称' }]);
  });

  it('explains a sheet without a 名称 column instead of importing nothing', () => {
    const csv = '衣服,类别\n夹克,外套\n';
    expect(() => parseWorkbook(Buffer.from(csv, 'utf8').toString('base64'), 'x.csv')).toThrow(/名称/);
  });

  it('rejects invalid UTF-8 and keeps valid 4-byte characters', () => {
    const bin = (bytes: number[]) => String.fromCharCode(...bytes);
    expect(decodeUtf8(bin([0xf0, 0x9f, 0x98, 0x80]))).toBe('😀');
    for (const bad of [[0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xc3], [0xc0, 0x80]]) expect(decodeUtf8(bin(bad))).toBeNull();
  });
});

describe('item form validation', () => {
  const item = { name: 'x', slot: 'top', priceCents: 19900, purchasedOn: '2025-09-14', fieldSources: {}, seasons: [] } as unknown as import('@/domain/types').Item;
  it('reports unreadable price and date and keeps the stored values', () => {
    const f = { ...formOf(item), price: '12.5.3', purchasedOn: '9/2025' };
    expect(formProblems(f)).toHaveLength(2);
    const p = patchOf(item, f);
    expect(p.priceCents).toBe(19900);
    expect(p.purchasedOn).toBe('2025-09-14');
    expect(formProblems({ ...formOf(item), price: '¥99.5', purchasedOn: '2024年3月' })).toEqual([]);
    expect(patchOf(item, { ...formOf(item), price: '', purchasedOn: '' })).toMatchObject({ priceCents: null, purchasedOn: null });
    expect(normalizeDate('2025-02-31')).toBeNull();
  });
});

describe('garments picked from a photo', () => {
  const det = (name: string, extra: Partial<Detection> = {}): Detection => ({
    box: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 }, selected: true, manual: false, edited: false, name, slot: 'top', subcategory: null,
    colorName: '黑色', colorHex: '#111111', seasons: ['summer'], brand: null, size: null, material: null, ...extra,
  });

  it('turns the chosen garments into items cut from the shared photo', async () => {
    const pick = await createItem(db, {
      name: '新衣服', slot: 'top', status: 'pick', originalUri: 'mem://original/photo',
      detections: [det('T恤', { printText: 'OET GRUNN' }), det('卫裤', { slot: 'bottom', edited: true }), det('包', { selected: false })],
    });
    await enqueueJob(db, 'catalog', pick.id);
    const made = await confirmPicks(ctx(), pick.id);
    expect(made.map((i) => [i.name, i.slot, i.sourceUri, i.status])).toEqual([
      ['T恤', 'top', 'mem://original/photo', 'processing'],
      ['卫裤', 'bottom', 'mem://original/photo', 'processing'],
    ]);
    expect(made[0].originalUri).toMatch(/crop/);
    expect(made[0].fieldSources.name).toBe('ai');
    expect(await getItem(db, pick.id)).toBeNull();
    const jobs = await listJobs(db, ['queued']);
    expect(jobs.map((j) => [j.refId, j.payload.autofill, j.payload.printText])).toEqual([
      [made[0].id, 'skip', 'OET GRUNN'],
      [made[1].id, 'crop', undefined],
    ]);
    expect(images.removed).toEqual([]);

    // The photo goes only with the last garment cut from it.
    await removeItem(ctx(), made[0].id);
    expect(images.removed).not.toContain('mem://original/photo');
    await removeItem(ctx(), made[1].id);
    expect(images.removed).toContain('mem://original/photo');
  });

  it('refuses to confirm with nothing chosen', async () => {
    const pick = await createItem(db, { name: 'x', slot: 'top', status: 'pick', originalUri: 'mem://p', detections: [det('a', { selected: false })] });
    await expect(confirmPicks(ctx(), pick.id)).rejects.toThrow('还没有选中衣服');
  });

  it('marks a box moved far from the AI box as edited', () => {
    const d = det('a');
    expect(withBox(d, { ...d.box, x: 0.12 }).edited).toBe(false);
    expect(withBox(d, { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }).edited).toBe(true);
    expect(withBox(det('b', { manual: true }), { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }).edited).toBe(false);
  });

  it('re-cuts an item and keeps the whole photo', async () => {
    const it = await createItem(db, { name: 'x', slot: 'top', status: 'review', originalUri: 'mem://original/whole' });
    await cropItem(ctx(), it.id, { x: 0, y: 0.5, w: 1, h: 0.5 });
    const once = (await getItem(db, it.id))!;
    expect(once.sourceUri).toBe('mem://original/whole');
    expect(once.crop).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    await cropItem(ctx(), it.id, { x: 0, y: 0, w: 1, h: 0.5 });
    expect(images.removed).toEqual([once.originalUri]);
    expect((await getItem(db, it.id))!.sourceUri).toBe('mem://original/whole');
  });

  it('regenerates with the form saved first and the chosen options', async () => {
    const it = await createItem(db, { name: 'T恤', slot: 'top', status: 'review', colorName: '黑色', colorHex: '#111111', originalUri: 'mem://o' });
    await regenerateWith(ctx(), it.id, { slot: 'bottom', name: '卫裤', colorName: '灰色' }, { model: { keyId: 'k1', model: 'gpt-image-1' }, quality: 'medium', hint: ' 颜色浅一点 ', makeDefault: true });
    const after = (await getItem(db, it.id))!;
    expect([after.slot, after.name, after.colorName, after.colorHex]).toEqual(['bottom', '卫裤', '灰色', null]);
    const [job] = await listJobs(db, ['queued']);
    expect(job.payload).toEqual({ regenerate: true, model: { keyId: 'k1', model: 'gpt-image-1' }, quality: 'medium', hint: '颜色浅一点' });
    expect((await getRoutes(db)).catalog).toEqual({ keyId: 'k1', model: 'gpt-image-1' });
    expect((await getAiSettings(db)).catalogQuality).toBe('medium');
  });
});

describe('fit on the form', () => {
  it('keeps the two taps and the centimetres typed, and nothing when nothing was said', async () => {
    const it = await createItem(db, { name: 'x', slot: 'top', status: 'active', fit: { width: 'loose', cm: { length: 72 } } });
    const f = formOf(it);
    expect(f).toMatchObject({ fitWidth: 'loose', fitLength: '', cm: { length: '72' } });
    expect(fitOf({ ...f, fitLength: 'short', cm: { ...f.cm, chest: '61.5', sleeve: '' } })).toEqual({ width: 'loose', length: 'short', cm: { length: 72, chest: 61.5 } });
    expect(fitOf({ ...f, fitWidth: '', cm: {} })).toBeNull();
    expect(patchOf(it, { ...f, fitWidth: 'tight' }).fit).toEqual({ width: 'tight', cm: { length: 72 } });
  });
});
