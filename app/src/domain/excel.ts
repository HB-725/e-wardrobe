import * as XLSX from 'xlsx';
import { isSeason, SEASONS, SLOTS, OCCASION_LABEL } from './catalog';
import { type ItemStats, statsById } from './stats';
import type { Item, Outfit, Season, Slot, WearLog } from './types';

/** Column headers double as the import template: users can fill a sheet with these names and import it. */
export const ITEM_COLUMNS = [
  '名称',
  '品类',
  '细类',
  '颜色',
  '季节',
  '品牌',
  '尺码',
  '材质',
  '价格',
  '购买日期',
  '购买渠道',
  '存放位置',
  '合身笔记',
  '穿着次数',
  '上次穿着',
  '状态',
] as const;

type Row = Record<string, string | number>;

const STATUS_LABEL: Record<Item['status'], string> = {
  active: '在用',
  archived: '已收起',
  review: '待确认',
  processing: '生成中',
  failed: '生成失败',
};

export function itemRow(item: Item, s: ItemStats): Row {
  return {
    名称: item.name,
    品类: SLOTS.find((x) => x.id === item.slot)?.label ?? item.slot,
    细类: item.subcategory ?? '',
    颜色: item.colorName ?? '',
    季节: SEASONS.filter((x) => item.seasons.includes(x.id)).map((x) => x.label).join('、'),
    品牌: item.brand ?? '',
    尺码: item.size ?? '',
    材质: item.material ?? '',
    价格: item.priceCents != null ? item.priceCents / 100 : '',
    购买日期: item.purchasedOn ?? '',
    购买渠道: item.channel ?? '',
    存放位置: item.location ?? '',
    合身笔记: item.fitNotes ?? '',
    穿着次数: s.wears,
    上次穿着: s.lastWorn ?? '',
    状态: STATUS_LABEL[item.status],
  };
}

/** Builds the export workbook (单品 / 穿搭 / 穿着记录) and returns it as base64 xlsx. */
export function buildWorkbook(items: Item[], outfits: Outfit[], logs: WearLog[], today: Date): string {
  const names = new Map(items.map((i) => [i.id, i.name]));
  const stats = statsById(items, logs, today);
  const outfitWears = new Map<string, number>();
  for (const l of logs) if (l.outfitId) outfitWears.set(l.outfitId, (outfitWears.get(l.outfitId) ?? 0) + 1);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(items.map((i) => itemRow(i, stats.get(i.id)!)), { header: [...ITEM_COLUMNS] }), '单品');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      outfits.map((o) => ({
        名称: o.name,
        场合: o.occasions.map((x) => OCCASION_LABEL[x] ?? x).join('、'),
        单品: o.itemIds.map((id) => names.get(id) ?? '').join('、'),
        穿过次数: outfitWears.get(o.id) ?? 0,
      })),
      { header: ['名称', '场合', '单品', '穿过次数'] },
    ),
    '穿搭',
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      logs.map((l) => ({ 日期: l.date, 单品: l.itemIds.map((id) => names.get(id) ?? '').join('、'), 来源: l.source === 'mirror' ? '镜子照片' : '手动' })),
      { header: ['日期', '单品', '来源'] },
    ),
    '穿着记录',
  );
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
}

const SLOT_ALIASES: Record<string, Slot> = {
  外套: 'outer',
  上衣: 'top',
  上装: 'top',
  下装: 'bottom',
  裤子: 'bottom',
  裙子: 'bottom',
  鞋: 'shoes',
  鞋子: 'shoes',
  包: 'bag',
  配饰: 'accessory',
  饰品: 'accessory',
};

/** Words people write in a 品类 column instead of the six category names, checked in this order. */
const SLOT_KEYWORDS: [RegExp, Slot][] = [
  // Trousers and skirts first: 西装裤, 羽绒裤 and 包臀裙 also contain outerwear or bag words.
  [/裤|裙/, 'bottom'],
  [/外套|夹克|大衣|羽绒|风衣|西装|棉服|冲锋衣|马甲|面包服|皮衣/, 'outer'],
  [/鞋|靴/, 'shoes'],
  [/T恤|t恤|衬衫|毛衣|卫衣|针织|背心|吊带|上衣|打底|polo|POLO/, 'top'],
  [/包/, 'bag'],
  [/帽|围巾|领带|腰带|皮带|手表|眼镜|首饰|项链|手链|耳环|袜|饰/, 'accessory'],
];

function slotOf(raw: string): Slot | undefined {
  return SLOT_ALIASES[raw] ?? (SLOTS.find((s) => s.id === raw)?.id as Slot | undefined) ?? SLOT_KEYWORDS.find(([re]) => re.test(raw))?.[1];
}

const SEASON_ALIASES: Record<string, Season> = { 春: 'spring', 夏: 'summer', 秋: 'autumn', 冬: 'winter' };

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseDate(v: unknown): string | null {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel serial date
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})(?:[-/.月](\d{1,2}))?/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1];
  // Reject impossible dates such as 2024-13-40 rather than storing them.
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > new Date(y, mo, 0).getDate()) return null;
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export interface ImportedItem {
  name: string;
  slot: Slot;
  subcategory: string | null;
  colorName: string | null;
  seasons: Season[];
  brand: string | null;
  size: string | null;
  material: string | null;
  priceCents: number | null;
  purchasedOn: string | null;
  channel: string | null;
  location: string | null;
  fitNotes: string | null;
  archived: boolean;
}

export interface ImportResult {
  items: ImportedItem[];
  skipped: { row: number; reason: string }[];
  /** Rows imported with a value left out (e.g. a date that could not be read). */
  warnings: { row: number; reason: string }[];
}

export class SpreadsheetError extends Error {}

/** Excel workbooks are read as binary; CSV text must be UTF-8 (Excel's "CSV UTF-8"), older ANSI/GBK files are not. */
function readBook(base64: string, fileName: string): XLSX.WorkBook {
  if (!/\.csv$/i.test(fileName)) return XLSX.read(base64, { type: 'base64' });
  const text = decodeUtf8(base64ToBinary(base64));
  if (text === null) throw new SpreadsheetError('这个 CSV 不是 UTF-8 编码。请在 Excel 里另存为「Excel 工作簿 (.xlsx)」或「CSV UTF-8」后再导入。');
  return XLSX.read(text.replace(/^\uFEFF/, ''), { type: 'string' });
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_INDEX = new Map([...B64].map((c, i) => [c.charCodeAt(0), i]));

function base64ToBinary(b64: string): string {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const at = (i: number) => (i < clean.length ? B64_INDEX.get(clean.charCodeAt(i))! : 0);
  const parts: string[] = [];
  let chunk: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const v = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3);
    chunk.push((v >> 16) & 255);
    if (i + 2 < clean.length) chunk.push((v >> 8) & 255);
    if (i + 3 < clean.length) chunk.push(v & 255);
    if (chunk.length >= 8190) {
      parts.push(String.fromCharCode(...chunk));
      chunk = [];
    }
  }
  parts.push(String.fromCharCode(...chunk));
  return parts.join('');
}

/** Strict UTF-8 decoding of a binary string; null if the bytes are not valid UTF-8. */
export function decodeUtf8(bin: string): string | null {
  const parts: string[] = [];
  let chunk: number[] = [];
  for (let i = 0; i < bin.length; ) {
    const b = bin.charCodeAt(i);
    const need = b < 0x80 ? 0 : b >= 0xc2 && b < 0xe0 ? 1 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xf0 && b < 0xf5 ? 3 : -1;
    if (need < 0 || i + need >= bin.length + (need ? 0 : 1)) return null;
    let cp = need === 0 ? b : b & (0x3f >> need);
    for (let k = 1; k <= need; k++) {
      const c = bin.charCodeAt(i + k);
      if ((c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    // Overlong forms, UTF-16 surrogates and code points past U+10FFFF are not valid UTF-8.
    if (cp < [0, 0x80, 0x800, 0x10000][need] || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return null;
    chunk.push(cp);
    if (chunk.length >= 8190) {
      parts.push(String.fromCodePoint(...chunk));
      chunk = [];
    }
    i += need + 1;
  }
  parts.push(String.fromCodePoint(...chunk));
  return parts.join('');
}

/** Reads the first sheet (or the one named 单品). Rows need at least 名称 and a recognisable 品类. */
export function parseWorkbook(base64: string, fileName = 'import.xlsx'): ImportResult {
  const wb = readBook(base64, fileName);
  const sheet = wb.Sheets['单品'] ?? wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { items: [], skipped: [], warnings: [] };
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const items: ImportedItem[] = [];
  const skipped: ImportResult['skipped'] = [];
  const warnings: ImportResult['warnings'] = [];
  rows.forEach((r, i) => {
    const rowNo = i + 2; // header is row 1
    const name = str(r['名称']);
    if (!name) {
      if (Object.values(r).some((v) => str(v))) skipped.push({ row: rowNo, reason: '缺少名称' });
      return;
    }
    const slotRaw = str(r['品类']) ?? '';
    const slot = slotOf(slotRaw);
    if (!slot) {
      skipped.push({ row: rowNo, reason: `品类「${slotRaw || '空'}」无法识别` });
      return;
    }
    const seasons = (str(r['季节']) ?? '')
      .split(/[、,，/·\s]+/)
      .map((x) => SEASON_ALIASES[x] ?? x)
      .filter(isSeason);
    const purchasedOn = parseDate(r['购买日期']);
    if (!purchasedOn && str(r['购买日期'])) warnings.push({ row: rowNo, reason: `购买日期「${str(r['购买日期'])}」无法识别，已留空` });
    const priceRaw = r['价格'];
    const price = typeof priceRaw === 'number' ? priceRaw : Number(String(priceRaw ?? '').replace(/[¥￥,\s元]/g, ''));
    items.push({
      name,
      slot,
      subcategory: str(r['细类']),
      colorName: str(r['颜色']),
      seasons: [...new Set(seasons)],
      brand: str(r['品牌']),
      size: str(r['尺码']),
      material: str(r['材质']),
      priceCents: Number.isFinite(price) && price > 0 ? Math.round(price * 100) : null,
      purchasedOn,
      channel: str(r['购买渠道']),
      location: str(r['存放位置']),
      fitNotes: str(r['合身笔记']),
      archived: str(r['状态']) === '已收起',
    });
  });
  return { items, skipped, warnings };
}

/** Same name, category, colour, size and brand counts as a duplicate, so importing an export twice is harmless. */
export function isDuplicate(existing: Pick<Item, 'name' | 'slot' | 'colorName' | 'size' | 'brand'>[], it: ImportedItem): boolean {
  return existing.some((e) => e.name === it.name && e.slot === it.slot && (e.colorName ?? null) === it.colorName && (e.size ?? null) === it.size && (e.brand ?? null) === it.brand);
}
