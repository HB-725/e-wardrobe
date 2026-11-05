/**
 * Garment layers for the fitting room ("green-screen 2.5D"): every garment is painted once onto a copy of the avatar
 * that wears flat chroma-green base clothes, inside the box of the body part it sits on; the green and everything
 * that did not change are keyed out, and what is left is the garment exactly as worn by that body, in the avatar's
 * own coordinates. Putting an outfit on is then just stacking those layers — no model call, no wait.
 */
import { decode as decodeJpeg } from 'jpeg-js';
import UPNG from 'upng-js';
import type { Box } from './crop';
import type { GarmentLayer, Item, Slot, Styling } from './types';

/** The flat colour of the base clothes on the green copy of the avatar; anything this green is not garment. */
export const CHROMA = '#00FF00';

// ponytail: generous boxes on the standard full-body front/back framing (head to below the shoes); the key does the
// precise work inside them.
const MASKS: Partial<Record<Slot, Box>> = {
  top: { x: 0.2, y: 0.16, w: 0.6, h: 0.46 },
  outer: { x: 0.12, y: 0.14, w: 0.76, h: 0.56 },
  bottom: { x: 0.26, y: 0.45, w: 0.48, h: 0.545 },
  shoes: { x: 0.26, y: 0.86, w: 0.48, h: 0.135 },
  accessory: { x: 0.3, y: 0.0, w: 0.4, h: 0.2 },
};

/** Where on the avatar a garment of this category is painted; null for categories that are not laid on (bags). */
export function maskBox(slot: Slot): Box | null {
  return MASKS[slot] ?? null;
}

/** Whether a garment gets a second, worn-open layer: outerwear always, a top only when it opens down the front. */
export function wantsOpen(item: Pick<Item, 'slot' | 'look'>): boolean {
  if (item.slot === 'outer') return true;
  if (item.slot !== 'top') return false;
  return /\b(zip|zipper|button|placket|cardigan|snap)/i.test(item.look?.details ?? '') || /拉链|纽扣|开衫|门襟/.test(item.look?.details ?? '');
}

const isGreen = (r: number, g: number, b: number) => g > 90 && g > r * 1.3 && g > b * 1.3;

/**
 * Alpha for the garment: inside the box, not chroma green, and different from the green base picture; specks
 * dropped, pinholes filled, then a one-pixel erosion where the garment meets green (the zip edge keeps a green rim
 * otherwise). Both pictures are RGBA at w×h.
 */
export function keyGarment(dressed: Uint8Array, base: Uint8Array, w: number, h: number, box: Box, threshold = 70): Uint8Array {
  const n = w * h;
  const x0 = Math.floor(box.x * w);
  const x1 = Math.ceil((box.x + box.w) * w);
  const y0 = Math.floor(box.y * h);
  const y1 = Math.ceil((box.y + box.h) * h);
  let alpha = new Uint8Array(n);
  const greenish = new Uint8Array(n);
  for (let y = y0; y < Math.min(h, y1); y++) {
    for (let x = x0; x < Math.min(w, x1); x++) {
      const p = y * w + x;
      const i = p * 4;
      const [r, g, b] = [dressed[i], dressed[i + 1], dressed[i + 2]];
      if (isGreen(r, g, b)) {
        greenish[p] = 1;
        continue;
      }
      const d = Math.abs(r - base[i]) + Math.abs(g - base[i + 1]) + Math.abs(b - base[i + 2]);
      if (d > threshold || isGreen(base[i], base[i + 1], base[i + 2])) alpha[p] = 255;
    }
  }
  const around = (A: Uint8Array, p: number) => {
    const x = p % w;
    let c = 0;
    for (const [dx, dy] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
      const X = x + dx;
      const Y = (p - x) / w + dy;
      if (X >= 0 && X < w && Y >= 0 && Y < h && A[Y * w + X]) c++;
    }
    return c;
  };
  for (let pass = 0; pass < 3; pass++) {
    const next = new Uint8Array(alpha);
    for (let p = 0; p < n; p++) {
      const c = around(alpha, p);
      if (alpha[p] && c < 4) next[p] = 0;
      else if (!alpha[p] && c >= 6) next[p] = 255;
    }
    alpha = next;
  }
  const eroded = new Uint8Array(alpha);
  for (let p = 0; p < n; p++) if (alpha[p] && around(greenish, p) > 0) eroded[p] = 0;
  const out = new Uint8Array(dressed);
  for (let p = 0; p < n; p++) out[p * 4 + 3] = eroded[p];
  return out;
}

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** JPEG (OpenAI) or PNG (Gemini, masks) bytes → RGBA. */
export function decodeImage(bytes: Uint8Array): Rgba {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    const img = UPNG.decode(bytes);
    return { width: img.width, height: img.height, data: new Uint8Array(UPNG.toRGBA8(img)[0]) };
  }
  const img = decodeJpeg(bytes, { useTArray: true });
  return { width: img.width, height: img.height, data: img.data };
}

export function encodePng(rgba: Uint8Array, w: number, h: number): Uint8Array {
  return new Uint8Array(UPNG.encode([rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength) as ArrayBuffer], w, h, 0));
}

/** Nearest-neighbour resample, for a base picture stored at another size than the model's output. */
export function resample(src: Rgba, w: number, h: number): Uint8Array {
  if (src.width === w && src.height === h) return src.data;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y / h) * src.height));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x / w) * src.width));
      out.set(src.data.subarray((sy * src.width + sx) * 4, (sy * src.width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return out;
}

/** The PNG mask the image API wants: opaque where the picture stays, transparent where the garment may be painted. */
export function maskPng(w: number, h: number, box: Box): Uint8Array {
  const rgba = new Uint8Array(w * h * 4).fill(255);
  for (let y = Math.floor(box.y * h); y < Math.min(h, (box.y + box.h) * h); y++) {
    for (let x = Math.floor(box.x * w); x < Math.min(w, (box.x + box.w) * w); x++) rgba[(y * w + x) * 4 + 3] = 0;
  }
  return encodePng(rgba, w, h);
}

/** The model's dressed picture and the green base picture (any sizes) → the garment layer as PNG bytes. */
export function layerPng(dressedBytes: Uint8Array, baseBytes: Uint8Array, box: Box): Uint8Array {
  const dressed = decodeImage(dressedBytes);
  const base = resample(decodeImage(baseBytes), dressed.width, dressed.height);
  return encodePng(keyGarment(dressed.data, base, dressed.width, dressed.height, box), dressed.width, dressed.height);
}

/** Stacking order on the avatar, back to front. */
const Z: Record<Slot, number> = { bottom: 0, shoes: 1, top: 2, outer: 3, accessory: 4, bag: 5 };

/**
 * The layers to stack for what is worn, in order, choosing the open variant where the owner opened a garment and
 * the closed one otherwise (or when open was never painted); `missing` lists garments with no layer yet.
 */
export function layersFor(worn: Pick<Item, 'id' | 'slot'>[], styling: Record<string, Styling>, view: GarmentLayer['view'], layers: GarmentLayer[]): GarmentLayer[] & { missing: string[] } {
  const out: GarmentLayer[] = [];
  const missing: string[] = [];
  for (const g of [...worn].sort((a, b) => Z[a.slot] - Z[b.slot])) {
    if (g.slot === 'bag') continue;
    const mine = layers.filter((l) => l.itemId === g.id && l.view === view);
    const pick = (styling[g.id]?.open ? mine.find((l) => l.variant === 'open') : undefined) ?? mine.find((l) => l.variant === 'closed');
    if (pick) out.push(pick);
    else missing.push(g.id);
  }
  return Object.assign(out, { missing });
}
