import { LAYER_ORDER } from './catalog';
import type { Item, Outfit, Slot, WearLog } from './types';
import { daysBetween } from './stats';

export type Selection = Partial<Record<Slot, string>>;

/** Toggle an item into its slot; selecting the worn item again takes it off. */
export function toggleInSelection(sel: Selection, item: Pick<Item, 'id' | 'slot'>): Selection {
  const next = { ...sel };
  if (next[item.slot] === item.id) delete next[item.slot];
  else next[item.slot] = item.id;
  return next;
}

export function selectionIds(sel: Selection): string[] {
  return LAYER_ORDER.map((s) => sel[s]).filter((x): x is string => !!x);
}

export function selectionFromItems(items: Pick<Item, 'id' | 'slot'>[]): Selection {
  const sel: Selection = {};
  for (const it of items) sel[it.slot] = it.id;
  return sel;
}

/** Order-independent key that identifies a combination of garments, used to cache try-on images. */
export function outfitKey(itemIds: string[]): string {
  return [...new Set(itemIds)].sort().join('+');
}

export function defaultOutfitName(items: Pick<Item, 'name' | 'slot'>[]): string {
  const ordered = [...items].sort(
    (a, b) => LAYER_ORDER.indexOf(b.slot) - LAYER_ORDER.indexOf(a.slot),
  );
  return ordered.slice(0, 2).map((i) => i.name).join(' + ') || '新穿搭';
}

export interface Suggestion {
  outfit: Outfit;
  /** Days since this outfit was last logged; null if never worn. */
  idleDays: number | null;
  badge: string | null;
}

/**
 * Outfits for the Today page: ones not worn for longest come first so neglected clothes get used.
 * Outfits containing archived/missing items are skipped.
 */
export function todaySuggestions(
  outfits: Outfit[],
  logs: WearLog[],
  activeItemIds: Set<string>,
  today: Date,
): Suggestion[] {
  const lastByOutfit = new Map<string, string>();
  for (const log of logs) {
    if (!log.outfitId) continue;
    const prev = lastByOutfit.get(log.outfitId);
    if (!prev || log.date > prev) lastByOutfit.set(log.outfitId, log.date);
  }
  return outfits
    .filter((o) => o.itemIds.length > 0 && o.itemIds.every((id) => activeItemIds.has(id)))
    .map((outfit) => {
      const last = lastByOutfit.get(outfit.id);
      const idleDays = last ? daysBetween(last, today) : null;
      let badge: string | null = null;
      if (idleDays === null) badge = '还没穿过';
      else if (idleDays >= 14) badge = `${idleDays} 天没穿了`;
      return { outfit, idleDays, badge };
    })
    .sort((a, b) => (b.idleDays ?? Number.MAX_SAFE_INTEGER) - (a.idleDays ?? Number.MAX_SAFE_INTEGER));
}
