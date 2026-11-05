import { keyGarment, layersFor, maskBox, wantsOpen } from '../layers';
import type { GarmentLayer, Item } from '../types';

/** w×h RGBA from rows: '.' studio grey, 'g' chroma green base, 's' skin, '#' garment pixels. */
function image(rows: string[]) {
  const h = rows.length;
  const w = rows[0].length;
  const rgba = new Uint8Array(w * h * 4);
  const px: Record<string, number[]> = { '.': [238, 238, 240], g: [0, 255, 0], s: [224, 180, 150], '#': [40, 40, 44] };
  rows.forEach((row, y) => [...row].forEach((c, x) => rgba.set([...px[c], 255], (y * w + x) * 4)));
  return { rgba, w, h };
}
const alphaAt = (rgba: Uint8Array, w: number, x: number, y: number) => rgba[(y * w + x) * 4 + 3];

describe('keyGarment', () => {
  // 12×12: a border of background, skin at the sides, green base in the middle; the garment covers most of the green.
  const base = image(['............', '............', '..ssggggss..', '..ssggggss..', '..ssggggss..', '..ssggggss..', '..ssggggss..', '..ssggggss..', '..ssggggss..', '..ssggggss..', '............', '............']);
  const dressed = image(['............', '............', '..ss####ss..', '..ss####ss..', '..ss####ss..', '..ss####ss..', '..ss####ss..', '..ss####ss..', '..ss####ss..', '..ssggggss..', '............', '............']);

  it('keeps what the model painted over the green base and drops green, skin and background', () => {
    const out = keyGarment(dressed.rgba, base.rgba, 12, 12, { x: 0, y: 0, w: 1, h: 1 });
    expect(alphaAt(out, 12, 5, 4)).toBe(255); // garment
    expect(alphaAt(out, 12, 5, 9)).toBe(0); // green base still showing
    expect(alphaAt(out, 12, 2, 4)).toBe(0); // skin, unchanged
    expect(alphaAt(out, 12, 0, 0)).toBe(0); // background
    expect(alphaAt(out, 12, 5, 8)).toBe(0); // the garment pixel touching green is eroded: no green rim
  });

  it('ignores everything outside the slot box, even if it changed', () => {
    const out = keyGarment(dressed.rgba, base.rgba, 12, 12, { x: 0, y: 0, w: 1, h: 0.5 });
    expect(alphaAt(out, 12, 5, 4)).toBe(255);
    expect(alphaAt(out, 12, 5, 7)).toBe(0);
  });
});

describe('maskBox', () => {
  it('covers the body part each category sits on', () => {
    expect(maskBox('top')!.y).toBeLessThan(maskBox('bottom')!.y);
    expect(maskBox('outer')!.w).toBeGreaterThan(maskBox('top')!.w);
    expect(maskBox('shoes')!.y + maskBox('shoes')!.h).toBeGreaterThan(0.95);
    expect(maskBox('bag')).toBeNull();
  });
});

describe('wantsOpen', () => {
  const item = (slot: Item['slot'], details = ''): Item => ({ slot, look: { colour: '', material: '', cut: '', details, prints: '', wear: '', creases: '' } }) as Item;
  it('is every outerwear piece, and a top that opens down the front', () => {
    expect(wantsOpen(item('outer'))).toBe(true);
    expect(wantsOpen(item('top', 'Front button placket, chest pocket.'))).toBe(true);
    expect(wantsOpen(item('top', 'Crew neck, kangaroo pocket.'))).toBe(false);
    expect(wantsOpen(item('bottom', 'zip fly'))).toBe(false);
  });
});

describe('layersFor', () => {
  const layer = (itemId: string, variant: GarmentLayer['variant'], view: GarmentLayer['view'] = 'front'): GarmentLayer => ({ itemId, avatarVersion: 'v1', view, variant, uri: `mem://layer/${itemId}-${variant}-${view}` });
  const worn = [{ id: 'jacket', slot: 'outer' }, { id: 'tee', slot: 'top' }, { id: 'jeans', slot: 'bottom' }, { id: 'shoes', slot: 'shoes' }] as Item[];
  const layers = [layer('jacket', 'closed'), layer('jacket', 'open'), layer('tee', 'closed'), layer('jeans', 'closed'), layer('shoes', 'closed')];

  it('stacks bottoms under shoes under tops under outerwear, open when the owner opened it', () => {
    expect(layersFor(worn, { jacket: { open: true } }, 'front', layers).map((l) => l.uri)).toEqual(['mem://layer/jeans-closed-front', 'mem://layer/shoes-closed-front', 'mem://layer/tee-closed-front', 'mem://layer/jacket-open-front']);
    expect(layersFor(worn, {}, 'front', layers).map((l) => l.uri)).toContain('mem://layer/jacket-closed-front');
  });

  it('falls back to the closed layer and names what is still missing', () => {
    const r = layersFor(worn, { tee: { open: true } }, 'front', layers.filter((l) => l.itemId !== 'jeans'));
    expect(r.map((l) => l.uri)).toEqual(['mem://layer/shoes-closed-front', 'mem://layer/tee-closed-front', 'mem://layer/jacket-closed-front']);
    expect(r.missing).toEqual(['jeans']);
  });
});
