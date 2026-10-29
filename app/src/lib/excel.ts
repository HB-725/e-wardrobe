import * as XLSX from 'xlsx';
import type { NewItem } from '@/db/items';
import { SEASONS, SLOTS, SLOT_LABEL } from '@/domain/catalog';
import { type ItemStats, toDateKey } from '@/domain/stats';
import type { FieldSource, Item, Season, Slot } from '@/domain/types';

/** Column header -> item field. Export writes these headers; import also accepts the aliases. */
const COLUMNS: { header: string; aliases: string[]; field: keyof Item }[] = [
  { header: '名称', aliases: ['名字', '单品', 'name'], field: 'name' },
  { header: '类别', aliases: ['分类', '品类', 'category'], field: 'slot' },
  { header: '细分', aliases: ['小类', 'subcategory'], field: 'subcategory' },
  { header: '颜色', aliases: ['color'], field: 'colorName' },
  { header: '季节', aliases: ['season', 'seasons'], field: 'seasons' },
  { header: '品牌', aliases: ['brand'], field: 'brand' },
  { header: '尺码', aliases: ['size'], field: 'size' },
  { header: '材质', aliases: ['面料', 'material'], field: 'material' },
  { header: '价格', aliases: ['价格(元)', '价格（元）', '金额', 'price'], field: 'priceCents' },
  { header: '购买日期', aliases: ['日期', 'purchased'], field: 'purchasedOn' },
  { header: '购买渠道', aliases: ['渠道', 'channel'], field: 'channel' },
  { header: '存放位置', aliases: ['位置', 'location'], field: 'location' },
  { header: '合身笔记', aliases: ['备注', 'notes'], field: 'fitNotes' },
];

/** Read-only columns added on export. */
const STAT_HEADERS = ['穿着次数', '上次穿着', '每次成本', '添加日期'];

const SHEET = '衣橱';

function seasonsText(seasons: Season[]): string {
  return SEASONS.filter((s) => seasons.includes(s.id)).map((s) => s.label).join('、');
}

export function exportWardrobe(items: Item[], stats: Map<string, ItemStats>): string {
  const header = [...COLUMNS.map((c) => c.header), ...STAT_HEADERS];
  const rows: (string | number | null)[][] = [header];
  for (const it of items) {
    if (it.status !== 'active') continue;
    const s = stats.get(it.id);
    rows.push([
      it.name,
      SLOT_LABEL[it.slot] ?? it.slot,
      it.subcategory,
      it.colorName,
      seasonsText(it.seasons),
      it.brand,
      it.size,
      it.material,
      it.priceCents != null ? it.priceCents / 100 : null,
      it.purchasedOn,
      it.channel,
      it.location,
      it.fitNotes,
      s?.wears ?? 0,
      s?.lastWorn ?? null,
      s?.costPerWearCents != null ? Math.round(s.costPerWearCents) / 100 : null,
      it.createdAt.slice(0, 10),
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = header.map((h) => ({ wch: h === '合身笔记' ? 30 : h === '名称' || h === '存放位置' ? 16 : 10 }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET);
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

/** An empty sheet with the importable columns and one example row. */
export function templateXlsx(): string {
  const ws = XLSX.utils.aoa_to_sheet([
    COLUMNS.map((c) => c.header),
    ['牛仔夹克', '外套', '夹克', '靛蓝', '春、秋', '', 'M', '棉', 399, '2025-09-14', '网店', '卧室衣柜左二层', ''],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, SHEET);
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

// ---------- import ----------

export interface ImportError {
  /** 1-based spreadsheet row number, as shown in Excel. */
  row: number;
  message: string;
}

export interface ImportResult {
  rows: NewItem[];
  errors: ImportError[];
}

function norm(v: unknown): string {
  return String(v ?? '').trim();
}

function parseSlot(v: string): Slot | null {
  const s = v.replace(/\s/g, '');
  const direct = SLOTS.find((x) => x.label === s || x.id === s.toLowerCase());
  if (direct) return direct.id;
  const hints: [RegExp, Slot][] = [
    [/外套|夹克|大衣|羽绒|风衣|西装|开衫/, 'outer'],
    [/上衣|T恤|衬衫|卫衣|毛衣|针织|背心|吊带/i, 'top'],
    [/下装|裤|裙/, 'bottom'],
    [/鞋|靴/, 'shoes'],
    [/包/, 'bag'],
    [/配饰|帽|围巾|腰带|首饰|手表|眼镜/, 'accessory'],
  ];
  return hints.find(([re]) => re.test(s))?.[1] ?? null;
}

export function parseSeasons(v: string): Season[] | null {
  const s = v.replace(/\s/g, '');
  if (!s) return [];
  if (/四季|全年|all/i.test(s)) return SEASONS.map((x) => x.id);
  const out = SEASONS.filter((x) => s.includes(x.label) || s.toLowerCase().includes(x.id)).map((x) => x.id);
  return out.length ? out : null;
}

export function parsePriceCents(v: unknown): number | null | 'invalid' {
  if (v === null || v === undefined || norm(v) === '') return null;
  if (typeof v === 'number') return v >= 0 ? Math.round(v * 100) : 'invalid';
  const cleaned = norm(v).replace(/[¥￥,，元\s]/g, '').replace(/^RMB/i, '');
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 'invalid';
}

/** Accepts Excel serial dates and YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD / YYYY年M月D日. */
export function parseDate(v: unknown): string | null | 'invalid' {
  if (v === null || v === undefined || norm(v) === '') return null;
  if (typeof v === 'number') {
    const parsed = XLSX.SSF.parse_date_code(v);
    if (!parsed || !parsed.y) return 'invalid';
    return toDateKey(new Date(parsed.y, parsed.m - 1, parsed.d));
  }
  const m = norm(v).match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  if (!m) return 'invalid';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1) return 'invalid';
  return toDateKey(d);
}

export function parseWardrobeXlsx(base64: string): ImportResult {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(base64, { type: 'base64' });
  } catch {
    return { rows: [], errors: [{ row: 0, message: '无法读取这个文件，请确认是 Excel（.xlsx / .xls）或 CSV' }] };
  }
  const ws = wb.Sheets[SHEET] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) return { rows: [], errors: [{ row: 0, message: '文件里没有工作表' }] };
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true });
  const headerIdx = grid.findIndex((r) => (r ?? []).some((c) => norm(c) !== ''));
  if (headerIdx < 0) return { rows: [], errors: [{ row: 0, message: '表格是空的' }] };

  const headerRow = (grid[headerIdx] ?? []).map((c) => norm(c).toLowerCase());
  const colOf = new Map<keyof Item, number>();
  for (const c of COLUMNS) {
    const names = [c.header, ...c.aliases].map((x) => x.toLowerCase());
    const idx = headerRow.findIndex((h) => names.includes(h));
    if (idx >= 0) colOf.set(c.field, idx);
  }
  if (!colOf.has('name')) return { rows: [], errors: [{ row: headerIdx + 1, message: '找不到「名称」这一列' }] };
  if (!colOf.has('slot')) return { rows: [], errors: [{ row: headerIdx + 1, message: '找不到「类别」这一列' }] };

  const rows: NewItem[] = [];
  const errors: ImportError[] = [];
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const line = grid[r] ?? [];
    if (line.every((c) => norm(c) === '')) continue;
    const rowNo = r + 1;
    const cell = (f: keyof Item) => (colOf.has(f) ? line[colOf.get(f)!] : null);
    const text = (f: keyof Item) => norm(cell(f)) || null;

    const name = text('name');
    if (!name) {
      errors.push({ row: rowNo, message: '名称不能为空' });
      continue;
    }
    const slot = parseSlot(norm(cell('slot')));
    if (!slot) {
      errors.push({ row: rowNo, message: `类别「${norm(cell('slot'))}」无法识别，请填外套 / 上衣 / 下装 / 鞋 / 包 / 配饰` });
      continue;
    }
    const seasons = parseSeasons(norm(cell('seasons')));
    if (seasons === null) {
      errors.push({ row: rowNo, message: `季节「${norm(cell('seasons'))}」无法识别，请填春、夏、秋、冬` });
      continue;
    }
    const price = parsePriceCents(cell('priceCents'));
    if (price === 'invalid') {
      errors.push({ row: rowNo, message: `价格「${norm(cell('priceCents'))}」不是有效数字` });
      continue;
    }
    const date = parseDate(cell('purchasedOn'));
    if (date === 'invalid') {
      errors.push({ row: rowNo, message: `购买日期「${norm(cell('purchasedOn'))}」格式不对，请用 2025-09-14` });
      continue;
    }

    const item: NewItem = {
      name,
      slot,
      status: 'active',
      subcategory: text('subcategory'),
      colorName: text('colorName'),
      seasons,
      brand: text('brand'),
      size: text('size'),
      material: text('material'),
      priceCents: price,
      purchasedOn: date,
      channel: text('channel'),
      location: text('location'),
      fitNotes: text('fitNotes'),
    };
    const sources: Partial<Record<keyof Item, FieldSource>> = {};
    for (const f of colOf.keys()) {
      const v = (item as Partial<Item>)[f];
      if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) sources[f] = 'user';
    }
    item.fieldSources = sources;
    rows.push(item);
  }
  return { rows, errors };
}
