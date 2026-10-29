import * as XLSX from 'xlsx';
import type { Item } from '@/domain/types';
import type { ItemStats } from '@/domain/stats';
import { exportWardrobe, parseDate, parsePriceCents, parseSeasons, parseWardrobeXlsx, templateXlsx } from '../excel';

function item(extra: Partial<Item>): Item {
  return {
    id: 'x', name: 'x', slot: 'top', subcategory: null, colorName: null, colorHex: null, seasons: [], brand: null,
    size: null, material: null, priceCents: null, purchasedOn: null, channel: null, location: null, fitNotes: null,
    status: 'active', originalUri: null, catalogUri: null, tagUri: null, fieldSources: {}, fidelity: null, error: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra,
  };
}

function sheetFrom(rows: unknown[][]): string {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

function readBack(b64: string): unknown[][] {
  const wb = XLSX.read(b64, { type: 'base64' });
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
}

describe('export', () => {
  it('writes active items with stats under Chinese headers', () => {
    const items = [
      item({ id: 'a', name: '牛仔夹克', slot: 'outer', seasons: ['autumn', 'spring'], priceCents: 39900 }),
      item({ id: 'b', name: '草稿', status: 'review' }),
    ];
    const stats = new Map<string, ItemStats>([['a', { wears: 14, lastWorn: '2026-10-19', costPerWearCents: 2850, idleDays: 10 }]]);
    const rows = readBack(exportWardrobe(items, stats));
    expect(rows[0].slice(0, 3)).toEqual(['名称', '类别', '细分']);
    expect(rows).toHaveLength(2);
    const r = rows[1];
    expect(r[0]).toBe('牛仔夹克');
    expect(r[1]).toBe('外套');
    expect(r[4]).toBe('春、秋');
    expect(r[8]).toBe(399);
    expect(r[13]).toBe(14);
    expect(r[15]).toBe(28.5);
  });

  it('exported files import back to the same items', () => {
    const items = [item({ id: 'a', name: '白衬衫', slot: 'top', seasons: ['summer'], priceCents: 19900, brand: 'ACME', purchasedOn: '2025-05-01' })];
    const { rows, errors } = parseWardrobeXlsx(exportWardrobe(items, new Map()));
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ name: '白衬衫', slot: 'top', seasons: ['summer'], priceCents: 19900, brand: 'ACME', purchasedOn: '2025-05-01', status: 'active' });
    expect(rows[0].fieldSources).toMatchObject({ name: 'user', brand: 'user', priceCents: 'user' });
  });

  it('template is importable', () => {
    const { rows, errors } = parseWardrobeXlsx(templateXlsx());
    expect(errors).toEqual([]);
    expect(rows[0].name).toBe('牛仔夹克');
  });
});

describe('import', () => {
  it('accepts aliases, loose categories, a title row above the header and skips blank rows', () => {
    const b64 = sheetFrom([
      [],
      ['名字', '分类', '价格（元）', '季节', '日期'],
      ['灰色卫衣', '卫衣', '¥129', '四季', '2025/3/8'],
      [null, null, null, null, null],
      ['短靴', '靴子', 299.5, '秋冬', 45000],
    ]);
    const { rows, errors } = parseWardrobeXlsx(b64);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.slot)).toEqual(['top', 'shoes']);
    expect(rows[0].priceCents).toBe(12900);
    expect(rows[0].seasons).toEqual(['spring', 'summer', 'autumn', 'winter']);
    expect(rows[0].purchasedOn).toBe('2025-03-08');
    expect(rows[1].priceCents).toBe(29950);
    expect(rows[1].seasons).toEqual(['autumn', 'winter']);
    expect(rows[1].purchasedOn).toBe('2023-03-15');
  });

  it('reports row-level errors with spreadsheet row numbers and keeps valid rows', () => {
    const b64 = sheetFrom([
      ['名称', '类别', '价格', '购买日期', '季节'],
      ['', '上衣', null, null, null],
      ['神秘物品', '家具', null, null, null],
      ['T恤', '上衣', 'abc', null, null],
      ['T恤', '上衣', null, '2025-02-30', null],
      ['T恤', '上衣', null, null, '雨季'],
      ['好的', '下装', 10, '2025年1月2日', '夏'],
    ]);
    const { rows, errors } = parseWardrobeXlsx(b64);
    expect(rows.map((r) => r.name)).toEqual(['好的']);
    expect(errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6]);
    expect(errors[1].message).toContain('家具');
  });

  it('requires name and category columns', () => {
    expect(parseWardrobeXlsx(sheetFrom([['颜色'], ['红']])).errors[0].message).toContain('名称');
    expect(parseWardrobeXlsx(sheetFrom([['名称'], ['x']])).errors[0].message).toContain('类别');
    expect(parseWardrobeXlsx('not a file').errors.length).toBe(1);
  });

  it('parsers', () => {
    expect(parseSeasons('')).toEqual([]);
    expect(parseSeasons('春 / 秋')).toEqual(['spring', 'autumn']);
    expect(parseSeasons('全年')).toHaveLength(4);
    expect(parsePriceCents('1,299元')).toBe(129900);
    expect(parsePriceCents(-1)).toBe('invalid');
    expect(parsePriceCents('')).toBeNull();
    expect(parseDate('2025.12.31')).toBe('2025-12-31');
    expect(parseDate('31/12/2025')).toBe('invalid');
  });
});
