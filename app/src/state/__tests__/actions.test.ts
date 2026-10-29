import * as XLSX from 'xlsx';
import { createTestDb } from '@/test/memoryDb';
import type { Db } from '@/db/db';
import { createItem, getItem, listItems } from '@/db/items';
import { enqueueJob, listJobs } from '@/db/jobs';
import { listOutfits } from '@/db/outfits';
import { getLogByDate, listLogs } from '@/db/wear';
import { buildWorkbook, isDuplicate, parseWorkbook } from '@/domain/excel';
import type { ImageStore } from '@/ai/imageStore';
import { addFitNote, addGarments, confirmItem, keepCurrent, keepOriginal, recordWear, removeItem, saveOutfit, undoWear, userSources } from '../actions';
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
      ['皮鞋', 'shoes', ['winter'], 89900, '2023-03-15'],
    ]);
    expect(r.skipped.map((s) => s.row)).toEqual([3, 5]);
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
