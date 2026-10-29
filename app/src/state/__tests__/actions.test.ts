import { setPhotoConsent } from '@/ai/config';
import * as XLSX from 'xlsx';
import { createTestDb } from '@/test/memoryDb';
import type { Db } from '@/db/db';
import { createItem, getItem, listItems } from '@/db/items';
import { enqueueJob, listJobs } from '@/db/jobs';
import { listOutfits } from '@/db/outfits';
import { getLogByDate, listLogs } from '@/db/wear';
import { buildWorkbook, decodeUtf8, isDuplicate, parseWorkbook } from '@/domain/excel';
import type { ImageStore } from '@/ai/imageStore';
import { addFitNote, addGarments, confirmItem, keepCurrent, keepOriginal, recordWear, removeItem, saveOutfit, tryonState, undoWear, userSources } from '../actions';
import { avatarVersion, putTryon, saveAvatar } from '@/db/misc';
import { outfitKey } from '@/domain/outfit';
import { tryonRef } from '@/ai/engine';
import { normalizeDate } from '@/ui/ItemForm';

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
  await setPhotoConsent(db);
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
    expect(await tryonState(db, [a.id], 'front')).toEqual({ uri: 'file:///t.jpg', status: 'none', error: null });
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: [a.id] });
    expect(await tryonState(db, [a.id], 'front')).toMatchObject({ uri: 'file:///t.jpg', status: 'queued' });
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
    const csv = '名称,品类\n' + ['包臀裙', '面包服', '西装裤', '西装裙', '羽绒裤', '牛仔外套', '皮衣', '吊带', '袜子', '鞋包'].map((n) => `${n},${n}`).join('\n');
    const r = parseWorkbook(Buffer.from(csv, 'utf8').toString('base64'), 'x.csv');
    expect(Object.fromEntries(r.items.map((i) => [i.name, i.slot]))).toEqual({
      包臀裙: 'bottom', 面包服: 'outer', 西装裤: 'bottom', 西装裙: 'bottom', 羽绒裤: 'bottom', 牛仔外套: 'outer', 皮衣: 'outer', 吊带: 'top', 袜子: 'accessory', 鞋包: 'shoes',
    });
  });

  it('rejects invalid UTF-8 and keeps valid 4-byte characters', () => {
    const bin = (bytes: number[]) => String.fromCharCode(...bytes);
    expect(decodeUtf8(bin([0xf0, 0x9f, 0x98, 0x80]))).toBe('😀');
    for (const bad of [[0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xc3], [0xc0, 0x80]]) expect(decodeUtf8(bin(bad))).toBeNull();
  });
});
