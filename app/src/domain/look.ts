import { makeupKey } from './makeup';
import { outfitKey } from './outfit';
import type { Slot, Styling } from './types';

export type { Styling };

/**
 * What is on the avatar. Upper-body garments (tops and outerwear) can be layered and are kept innermost first;
 * accessories can be several; every other category holds one garment.
 */
export interface Look {
  ids: string[];
  styling: Record<string, Styling>;
  /** See domain/makeup; unset is the avatar's own face. */
  makeup?: string;
}

export const EMPTY_LOOK: Look = { ids: [], styling: {} };
export const MAX_LAYERS = 5;
/** With 5 layers, bottoms, shoes and a bag, a try-on then sends 13 pictures (the avatar included). */
export const MAX_ACCESSORIES = 4;

export const isUpper = (slot: Slot) => slot === 'top' || slot === 'outer';

type SlotOf = (id: string) => Slot | undefined;
type Garment = { id: string; slot: Slot };

/** Upper-body ids, innermost first. */
export function layersOf(look: Look, slotOf: SlotOf): string[] {
  return look.ids.filter((id) => {
    const s = slotOf(id);
    return !!s && isUpper(s);
  });
}

function without(look: Look, id: string): Look {
  const { [id]: _gone, ...styling } = look.styling;
  return { ...look, ids: look.ids.filter((x) => x !== id), styling };
}

export function takeOff(look: Look, id: string): Look {
  return without(look, id);
}

/** The outermost worn garment of this category, if any. */
function outermostOf(look: Look, slot: Slot, slotOf: SlotOf, except?: string): string | undefined {
  return [...look.ids].reverse().find((id) => id !== except && slotOf(id) === slot);
}

export type WearResult =
  | { look: Look; stackedOver?: string; full?: false }
  /** Already MAX_LAYERS on the upper body (or MAX_ACCESSORIES); nothing changed. */
  | { look: Look; full: true };

/**
 * Tapping a garment: a worn one comes off. An upper-body garment goes on as the new outermost layer
 * (`stackedOver` names the same-category garment now under it, so the screen can offer to swap instead);
 * with `replace` (去试穿 from another page) it takes the place of that garment, and one already on stays on.
 * Accessories are added next to the ones already on (`stackedOver` is the last one, to offer the swap);
 * `replace` swaps the last one only when there is no room. Other categories always swap.
 */
export function wear(look: Look, item: Garment, slotOf: SlotOf, mode: 'stack' | 'replace' = 'stack'): WearResult {
  if (look.ids.includes(item.id)) return { look: mode === 'replace' ? look : without(look, item.id) };
  // The garment may have been worn under its old category before being edited.
  const sameSlot = outermostOf(look, item.slot, slotOf);
  if (item.slot === 'accessory') {
    if (look.ids.filter((id) => slotOf(id) === 'accessory').length < MAX_ACCESSORIES) return { look: { ...look, ids: [...look.ids, item.id] }, stackedOver: sameSlot };
    return mode === 'replace' && sameSlot ? { look: replaceWith(look, sameSlot, item.id) } : { look, full: true };
  }
  if (!isUpper(item.slot) || (mode === 'replace' && sameSlot)) {
    if (!sameSlot) return { look: { ...look, ids: [...look.ids, item.id] } };
    return { look: replaceWith(look, sameSlot, item.id) };
  }
  if (layersOf(look, slotOf).length >= MAX_LAYERS) return { look, full: true };
  return { look: { ...look, ids: [...look.ids, item.id] }, stackedOver: sameSlot };
}

/** Puts `newId` where `oldId` was (same layer), dropping how the old one was worn. */
export function replaceWith(look: Look, oldId: string, newId: string): Look {
  const base = without(look, newId);
  const at = base.ids.indexOf(oldId);
  if (at < 0) return { ...base, ids: [...base.ids, newId] };
  const ids = [...base.ids];
  ids[at] = newId;
  return { ...without({ ...base, ids }, oldId), ids };
}

/** Moves an upper-body layer to position `to` (0 = innermost) among the layers. */
export function moveLayer(look: Look, id: string, to: number, slotOf: SlotOf): Look {
  const layers = layersOf(look, slotOf);
  const from = layers.indexOf(id);
  if (from < 0) return look;
  const next = layers.filter((x) => x !== id);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
  // Layers keep their slots in ids; the rest keep their place.
  let k = 0;
  return { ...look, ids: look.ids.map((x) => (layers.includes(x) ? next[k++] : x)) };
}

export function setStyling(look: Look, id: string, patch: Styling): Look {
  const merged = { ...look.styling[id], ...patch };
  const clean: Styling = {};
  if (merged.open !== undefined) clean.open = merged.open;
  if (merged.tucked !== undefined) clean.tucked = merged.tucked;
  const { [id]: _old, ...rest } = look.styling;
  return { ...look, styling: Object.keys(clean).length ? { ...rest, [id]: clean } : rest };
}

/** A look from garments in their stored order (a saved outfit), keeping only the ones still worn. */
export function lookFrom(ids: string[], styling: Record<string, Styling> = {}, makeup?: string | null): Look {
  const unique = [...new Set(ids)];
  const look: Look = { ids: unique, styling: Object.fromEntries(Object.entries(styling).filter(([id]) => unique.includes(id))) };
  return makeup ? { ...look, makeup } : look;
}

/** Garments in no particular order (e.g. a wear log): tops go under outerwear. */
export function lookFromGarments(items: Garment[]): Look {
  const rank = (s: Slot) => (s === 'top' ? 0 : s === 'outer' ? 1 : 2);
  return lookFrom([...items].sort((a, b) => rank(a.slot) - rank(b.slot)).map((i) => i.id));
}

const flags = (s: Styling | undefined) => `${s?.open === undefined ? '' : s.open ? 'o' : 'c'}${s?.tucked === undefined ? '' : s.tucked ? 't' : 'u'}`;

/**
 * Identifies how a look is drawn, to cache try-ons. One top under one jacket worn as the picture shows is what
 * every look was before layering, so it keeps the old key and its cached try-ons. Makeup comes last (`~mk:`):
 * the made-up picture is drawn from the one without it.
 */
export function lookKey(ids: string[], styling: Record<string, Styling>, slotOf: SlotOf, makeup?: string | null): string {
  const key = garmentsKey(ids, styling, slotOf);
  return makeup ? `${key}~mk:${makeupKey(makeup)}` : key;
}

/** The key of the same look without makeup. */
export function withoutMakeupKey(key: string): string {
  return key.replace(/~mk:[^~]*$/, '');
}

function garmentsKey(ids: string[], styling: Record<string, Styling>, slotOf: SlotOf): string {
  const base = outfitKey(ids);
  const layers = ids.filter((id) => {
    const s = slotOf(id);
    return !!s && isUpper(s);
  });
  const slots = layers.map((id) => slotOf(id));
  const plain =
    slots.filter((s) => s === 'top').length <= 1 &&
    slots.filter((s) => s === 'outer').length <= 1 &&
    !(slots[0] === 'outer' && slots[1] === 'top') &&
    layers.every((id) => !flags(styling[id]));
  if (plain) return base;
  return `${base}~${layers.map((id) => `${id}${flags(styling[id]) ? `:${flags(styling[id])}` : ''}`).join('>')}`;
}

/** The garment ids a try-on key covers (old keys and layered ones). */
export function idsOfKey(key: string): string[] {
  return key.split('~')[0].split('+').filter(Boolean);
}
