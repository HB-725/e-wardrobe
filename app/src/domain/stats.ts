import type { Item, WearLog } from './types';

export interface ItemStats {
  wears: number;
  lastWorn: string | null;
  /** Price divided by wears, in cents. Null when the price is unknown or the item was never worn. */
  costPerWearCents: number | null;
  /** Whole days since last worn (or since added, if never worn). */
  idleDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function daysBetween(fromKey: string, to: Date): number {
  const from = parseDateKey(fromKey);
  const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.max(0, Math.round((toDay.getTime() - from.getTime()) / DAY_MS));
}

export function computeItemStats(item: Item, logs: WearLog[], today: Date): ItemStats {
  let wears = 0;
  let lastWorn: string | null = null;
  for (const log of logs) {
    if (!log.itemIds.includes(item.id)) continue;
    wears += 1;
    if (lastWorn === null || log.date > lastWorn) lastWorn = log.date;
  }
  // createdAt is a UTC timestamp; compare in the phone's local calendar.
  const since = lastWorn ?? toDateKey(new Date(item.createdAt));
  return {
    wears,
    lastWorn,
    costPerWearCents:
      item.priceCents != null && wears > 0 ? Math.round(item.priceCents / wears) : null,
    idleDays: daysBetween(since, today),
  };
}

export function statsById(items: Item[], logs: WearLog[], today: Date): Map<string, ItemStats> {
  const map = new Map<string, ItemStats>();
  for (const item of items) map.set(item.id, computeItemStats(item, logs, today));
  return map;
}

/** 1-based rank by wear count among active items (ties share the better rank). */
export function wearRank(itemId: string, stats: Map<string, ItemStats>): number {
  const mine = stats.get(itemId)?.wears ?? 0;
  let better = 0;
  for (const s of stats.values()) if (s.wears > mine) better += 1;
  return better + 1;
}

export function idleItems(
  items: Item[],
  stats: Map<string, ItemStats>,
  minDays: number,
  limit: number,
): { item: Item; days: number }[] {
  return items
    .filter((i) => i.status === 'active')
    .map((item) => ({ item, days: stats.get(item.id)?.idleDays ?? 0 }))
    .filter((x) => x.days >= minDays)
    .sort((a, b) => b.days - a.days)
    .slice(0, limit);
}

export function formatYuan(cents: number | null): string {
  if (cents == null) return '—';
  const yuan = cents / 100;
  return Number.isInteger(yuan) ? `¥${yuan}` : `¥${yuan.toFixed(1)}`;
}

export interface WeekDay {
  dateKey: string;
  label: string;
  isToday: boolean;
  logged: boolean;
}

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** Monday-first week containing `today`. */
export function weekOf(today: Date, loggedDates: Set<string>): WeekDay[] {
  const dow = (today.getDay() + 6) % 7;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow);
  const todayKey = toDateKey(today);
  return WEEK_LABELS.map((label, i) => {
    const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const key = toDateKey(d);
    return { dateKey: key, label, isToday: key === todayKey, logged: loggedDates.has(key) };
  });
}

const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
const MONTH_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
const MONTH_EN = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

export function dateParts(d: Date): { day: number; monthCn: string; monthEn: string; weekdayCn: string } {
  return {
    day: d.getDate(),
    monthCn: `${MONTH_CN[d.getMonth()]}月`,
    monthEn: MONTH_EN[d.getMonth()],
    weekdayCn: `星期${WEEKDAY_CN[d.getDay()]}`,
  };
}

export interface MonthCell {
  dateKey: string | null;
  day: number | null;
}

/** Monday-first month grid with leading blanks. */
export function monthGrid(year: number, month0: number): MonthCell[] {
  const first = new Date(year, month0, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(year, month0 + 1, 0).getDate();
  const cells: MonthCell[] = [];
  for (let i = 0; i < lead; i++) cells.push({ dateKey: null, day: null });
  for (let d = 1; d <= days; d++) cells.push({ dateKey: toDateKey(new Date(year, month0, d)), day: d });
  return cells;
}
