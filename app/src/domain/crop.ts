import type { Detection } from './types';

/** A rectangle on a photo, 0–1 relative to its width and height. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Vision models answer [ymin, xmin, ymax, xmax] on a 0–1000 grid; null when it does not describe an area. */
export function fromBox2d(b: unknown): Box | null {
  if (!Array.isArray(b) || b.length !== 4 || b.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const [y0, x0, y1, x1] = (b as number[]).map((v) => clamp01(v / 1000));
  const box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  return box.w > 0 && box.h > 0 ? box : null;
}

/** Grows the box by `pad` of its size on every side (models cut garments tight), staying on the photo. */
export function padBox(b: Box, pad = 0.06): Box {
  const x0 = clamp01(b.x - b.w * pad);
  const y0 = clamp01(b.y - b.h * pad);
  const x1 = clamp01(b.x + b.w * (1 + pad));
  const y1 = clamp01(b.y + b.h * (1 + pad));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const boxArea = (b: Box) => b.w * b.h;

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** How much of `inner` lies inside `outer`, 0–1. */
function inside(inner: Box, outer: Box): number {
  const w = Math.max(0, Math.min(inner.x + inner.w, outer.x + outer.w) - Math.max(inner.x, outer.x));
  const h = Math.max(0, Math.min(inner.y + inner.h, outer.y + outer.h) - Math.max(inner.y, outer.y));
  return (w * h) / boxArea(inner);
}

/**
 * Models list what they see, not what you own: a pair of shoes comes back as two shoes, a chest print as an
 * "accessory". A pair side by side becomes one garment spanning both; an accessory lying on a garment is dropped.
 */
export function tidyGarments<T extends { slot: Detection['slot']; box: Box }>(found: T[]): T[] {
  const out: T[] = [];
  for (const g of found) {
    const pair = g.slot === 'shoes' ? out.find((o) => o.slot === 'shoes' && boxArea(union(o.box, g.box)) < 3 * (boxArea(o.box) + boxArea(g.box))) : undefined;
    if (pair) {
      pair.box = union(pair.box, g.box);
      continue;
    }
    // A print, logo or cuff listed as a garment of the same kind sits inside the real one; so does an "accessory"
    // that is really a print. ponytail: a belt worn on a person is also inside the outfit; the prompt covers that.
    const part = (o: T) => o !== g && inside(g.box, o.box) >= 0.85 && (o.slot === g.slot ? boxArea(o.box) > boxArea(g.box) : g.slot === 'accessory' && o.slot !== 'accessory');
    if (found.some(part)) continue;
    out.push({ ...g });
  }
  return out;
}

/** Intersection over union: 1 for the same box, 0 when they do not touch. */
export function overlap(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = w * h;
  return inter / (boxArea(a) + boxArea(b) - inter || 1);
}

/** Whole-pixel crop rectangle inside a `width` × `height` image. */
export function toPixels(b: Box, width: number, height: number): { originX: number; originY: number; width: number; height: number } {
  const originX = Math.min(width - 1, Math.round(b.x * width));
  const originY = Math.min(height - 1, Math.round(b.y * height));
  return {
    originX,
    originY,
    width: Math.max(1, Math.min(width - originX, Math.round(b.w * width))),
    height: Math.max(1, Math.min(height - originY, Math.round(b.h * height))),
  };
}

/** The detection with a box the user moved; far from where the AI put it, its AI fields may describe something else. */
export function withBox(d: Detection, box: Box): Detection {
  return { ...d, box, edited: d.edited || (!d.manual && overlap(d.box, box) < 0.7) };
}

/** What a touch on the crop box grabs: a corner, the whole box, or nothing. */
export type Handle = 'move' | 'tl' | 'tr' | 'bl' | 'br';

/** `tolX` / `tolY`: how far from a corner (0–1 of the photo) still grabs it; corners win over moving. */
export function handleAt(b: Box, x: number, y: number, tolX: number, tolY: number): Handle | null {
  const near = (px: number, py: number) => Math.abs(x - px) <= tolX && Math.abs(y - py) <= tolY;
  if (near(b.x, b.y)) return 'tl';
  if (near(b.x + b.w, b.y)) return 'tr';
  if (near(b.x, b.y + b.h)) return 'bl';
  if (near(b.x + b.w, b.y + b.h)) return 'br';
  return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h ? 'move' : null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The box after dragging `handle` by (dx, dy), staying on the photo and at least `min` wide and tall. */
export function dragBox(b: Box, handle: Handle, dx: number, dy: number, min = 0.05): Box {
  if (handle === 'move') return { ...b, x: clamp(b.x + dx, 0, 1 - b.w), y: clamp(b.y + dy, 0, 1 - b.h) };
  let x0 = b.x;
  let y0 = b.y;
  let x1 = b.x + b.w;
  let y1 = b.y + b.h;
  if (handle === 'tl' || handle === 'bl') x0 = clamp(x0 + dx, 0, x1 - min);
  else x1 = clamp(x1 + dx, x0 + min, 1);
  if (handle === 'tl' || handle === 'tr') y0 = clamp(y0 + dy, 0, y1 - min);
  else y1 = clamp(y1 + dy, y0 + min, 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
