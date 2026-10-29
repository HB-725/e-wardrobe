import * as XLSX from 'xlsx';
import { isSeason, SEASONS, SLOTS, OCCASION_LABEL } from './catalog';
import { computeItemStats } from './stats';
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

export function itemRow(item: Item, logs: WearLog[], today: Date): Row {
  const s = computeItemStats(item, logs, today);
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
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(items.map((i) => itemRow(i, logs, today)), { header: [...ITEM_COLUMNS] }), '单品');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      outfits.map((o) => ({
        名称: o.name,
        场合: o.occasions.map((x) => OCCASION_LABEL[x] ?? x).join('、'),
        单品: o.itemIds.map((id) => names.get(id) ?? '').join('、'),
        穿过次数: logs.filter((l) => l.outfitId === o.id).length,
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
  下装: 'bottom',
  裤子: 'bottom',
  裙子: 'bottom',
  鞋: 'shoes',
  鞋子: 'shoes',
  包: 'bag',
  配饰: 'accessory',
};

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
  return `${m[1]}-${m[2].padStart(2, '0')}${m[3] ? `-${m[3].padStart(2, '0')}` : '-01'}`;
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
}

/** Reads the first sheet (or the one named 单品). Rows need at least 名称 and a recognisable 品类. */
export function parseWorkbook(base64: string): ImportResult {
  const wb = XLSX.read(base64, { type: 'base64' });
  const sheet = wb.Sheets['单品'] ?? wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { items: [], skipped: [] };
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  const items: ImportedItem[] = [];
  const skipped: ImportResult['skipped'] = [];
  rows.forEach((r, i) => {
    const rowNo = i + 2; // header is row 1
    const name = str(r['名称']);
    if (!name) {
      if (Object.values(r).some((v) => str(v))) skipped.push({ row: rowNo, reason: '缺少名称' });
      return;
    }
    const slotRaw = str(r['品类']) ?? '';
    const slot = SLOT_ALIASES[slotRaw] ?? (SLOTS.find((s) => s.id === slotRaw)?.id as Slot | undefined);
    if (!slot) {
      skipped.push({ row: rowNo, reason: `品类「${slotRaw || '空'}」无法识别` });
      return;
    }
    const seasons = (str(r['季节']) ?? '')
      .split(/[、,，/·\s]+/)
      .map((x) => SEASON_ALIASES[x] ?? x)
      .filter(isSeason);
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
      purchasedOn: parseDate(r['购买日期']),
      channel: str(r['购买渠道']),
      location: str(r['存放位置']),
      fitNotes: str(r['合身笔记']),
      archived: str(r['状态']) === '已收起',
    });
  });
  return { items, skipped };
}

/** Same name + category already in the wardrobe counts as a duplicate, so importing an export twice is harmless. */
export function isDuplicate(existing: Pick<Item, 'name' | 'slot'>[], it: ImportedItem): boolean {
  return existing.some((e) => e.name === it.name && e.slot === it.slot);
}
