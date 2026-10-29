import type { Season, Slot } from './types';

export const SLOTS: { id: Slot; label: string }[] = [
  { id: 'outer', label: '外套' },
  { id: 'top', label: '上衣' },
  { id: 'bottom', label: '下装' },
  { id: 'shoes', label: '鞋' },
  { id: 'bag', label: '包' },
  { id: 'accessory', label: '配饰' },
];

export const SLOT_LABEL: Record<Slot, string> = Object.fromEntries(
  SLOTS.map((s) => [s.id, s.label]),
) as Record<Slot, string>;

/** Display order, top of the body to the bottom. */
export const SLOT_ORDER: Slot[] = SLOTS.map((s) => s.id);

/** Order garments are layered on the body, inner to outer. */
export const LAYER_ORDER: Slot[] = ['shoes', 'bottom', 'top', 'outer', 'bag', 'accessory'];

export const SEASONS: { id: Season; label: string }[] = [
  { id: 'spring', label: '春' },
  { id: 'summer', label: '夏' },
  { id: 'autumn', label: '秋' },
  { id: 'winter', label: '冬' },
];

export const OCCASIONS: { id: string; label: string }[] = [
  { id: 'work', label: '通勤' },
  { id: 'weekend', label: '周末' },
  { id: 'date', label: '约会' },
  { id: 'travel', label: '旅行' },
  { id: 'sport', label: '运动' },
  { id: 'formal', label: '正式' },
];

export const OCCASION_LABEL: Record<string, string> = Object.fromEntries(
  OCCASIONS.map((o) => [o.id, o.label]),
);

export function isSlot(value: unknown): value is Slot {
  return typeof value === 'string' && SLOTS.some((s) => s.id === value);
}

export function isSeason(value: unknown): value is Season {
  return typeof value === 'string' && SEASONS.some((s) => s.id === value);
}

export function seasonsLabel(seasons: Season[]): string {
  return SEASONS.filter((s) => seasons.includes(s.id))
    .map((s) => s.label)
    .join(' · ');
}
