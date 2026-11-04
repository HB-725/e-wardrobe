import type { Item, Outfit, Slot, WearLog } from '../types';
import { computeItemStats, dateParts, formatYuan, idleItems, monthGrid, statsById, toDateKey, wearRank, weekOf } from '../stats';
import { EMPTY_LOOK, idsOfKey, layersOf, type Look, lookFrom, lookFromGarments, lookKey, MAX_ACCESSORIES, MAX_LAYERS, moveLayer, replaceWith, setStyling, takeOff, wear, withoutMakeupKey } from '../look';
import { customMakeup, makeupKey, makeupLabel, makeupPromptText } from '../makeup';
import { defaultOutfitName, outfitKey, todaySuggestions } from '../outfit';
import { boxArea, dragBox, fromBox2d, handleAt, overlap, padBox, toPixels } from '../crop';

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id, name: id, slot: 'top', subcategory: null, colorName: null, colorHex: null, seasons: [], brand: null,
    size: null, material: null, priceCents: null, purchasedOn: null, channel: null, location: null, fitNotes: null,
    status: 'active', originalUri: null, catalogUri: null, tagUri: null, sourceUri: null, crop: null, detections: [], candidates: [], checks: [], fieldSources: {}, error: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...extra,
  };
}
function log(date: string, itemIds: string[], outfitId: string | null = null): WearLog {
  return { id: date, date, itemIds, outfitId, source: 'manual', photoUri: null, createdAt: date };
}
const TODAY = new Date(2026, 9, 29); // Thu 29 Oct 2026

describe('stats', () => {
  it('counts wears, last worn, cost per wear and idle days', () => {
    const a = item('a', { priceCents: 39900 });
    const s = computeItemStats(a, [log('2026-10-01', ['a']), log('2026-10-19', ['a', 'b']), log('2026-10-20', ['b'])], TODAY);
    expect(s.wears).toBe(2);
    expect(s.lastWorn).toBe('2026-10-19');
    expect(s.costPerWearCents).toBe(19950);
    expect(s.idleDays).toBe(10);
  });

  it('never-worn items are idle since they were added and have no cost per wear', () => {
    const s = computeItemStats(item('a', { priceCents: 100 }), [], TODAY);
    expect(s.wears).toBe(0);
    expect(s.costPerWearCents).toBeNull();
    expect(s.idleDays).toBe(58);
  });

  it('ranks by wears with ties sharing a rank', () => {
    const items = [item('a'), item('b'), item('c')];
    const stats = statsById(items, [log('2026-10-01', ['a', 'b']), log('2026-10-02', ['a'])], TODAY);
    expect(wearRank('a', stats)).toBe(1);
    expect(wearRank('b', stats)).toBe(2);
    expect(wearRank('c', stats)).toBe(3);
  });

  it('lists idle items longest first, excluding non-active', () => {
    const items = [item('a'), item('b', { status: 'review' }), item('c')];
    const stats = statsById(items, [log('2026-10-28', ['c'])], TODAY);
    expect(idleItems(items, stats, 14, 3).map((x) => x.item.id)).toEqual(['a']);
  });

  it('formats yuan', () => {
    expect(formatYuan(null)).toBe('—');
    expect(formatYuan(39900)).toBe('¥399');
    expect(formatYuan(2850)).toBe('¥28.5');
  });

  it('builds a Monday-first week and month grid', () => {
    const w = weekOf(TODAY, new Set(['2026-10-26']));
    expect(w.map((d) => d.dateKey)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    expect(w[3].isToday).toBe(true);
    expect(w[0].logged).toBe(true);
    const g = monthGrid(2026, 9);
    expect(g.slice(0, 3).every((c) => c.day === null)).toBe(true);
    expect(g[3].dateKey).toBe('2026-10-01');
    expect(g.filter((c) => c.day).length).toBe(31);
  });

  it('date parts in Chinese', () => {
    expect(dateParts(TODAY)).toEqual({ day: 29, monthCn: '十月', monthEn: 'OCTOBER', weekdayCn: '星期四' });
    expect(toDateKey(TODAY)).toBe('2026-10-29');
  });
});

describe('outfit', () => {
  it('keys are order-independent', () => {
    expect(outfitKey(['b', 'a', 'a'])).toBe(outfitKey(['a', 'b']));
  });

  it('names outfits after the outermost pieces', () => {
    expect(defaultOutfitName([{ name: 'T恤', slot: 'top' }, { name: '夹克', slot: 'outer' }, { name: '鞋', slot: 'shoes' }])).toBe('夹克 + T恤');
    expect(defaultOutfitName([])).toBe('新穿搭');
  });

  it('suggests never-worn and long-idle outfits first and skips ones with inactive items', () => {
    const o = (id: string, itemIds: string[]): Outfit => ({ id, name: id, occasions: [], itemIds, styling: {}, makeup: null, createdAt: '' });
    const outfits = [o('recent', ['a']), o('old', ['a']), o('never', ['a']), o('broken', ['a', 'gone'])];
    const logs = [log('2026-10-28', ['a'], 'recent'), log('2026-10-01', ['a'], 'old')];
    const s = todaySuggestions(outfits, logs, new Set(['a']), TODAY);
    expect(s.map((x) => x.outfit.id)).toEqual(['never', 'old', 'recent']);
    expect(s[0].badge).toBe('还没穿过');
    expect(s[1].badge).toBe('28 天没穿了');
    expect(s[2].badge).toBeNull();
  });
});

describe('what is worn (layers)', () => {
  const SLOTS: Record<string, Slot> = { tee: 'top', shirt: 'top', jacket: 'outer', vest: 'outer', coat: 'outer', jeans: 'bottom', chinos: 'bottom', shoes: 'shoes' };
  const slotOf = (id: string) => SLOTS[id];
  const g = (id: string) => ({ id, slot: SLOTS[id] });
  const put = (ids: string[]) => ids.reduce((l, id) => wear(l, g(id), slotOf).look, EMPTY_LOOK);

  it('stacks upper-body garments innermost first and says what a same-category one went over', () => {
    let r = wear(EMPTY_LOOK, g('tee'), slotOf);
    expect(r.look.ids).toEqual(['tee']);
    r = wear(r.look, g('shirt'), slotOf);
    expect(r.look.ids).toEqual(['tee', 'shirt']);
    expect(!r.full && r.stackedOver).toBe('tee');
    r = wear(r.look, g('jacket'), slotOf);
    expect(!r.full && r.stackedOver).toBeUndefined();
    r = wear(r.look, g('vest'), slotOf);
    expect(layersOf(r.look, slotOf)).toEqual(['tee', 'shirt', 'jacket', 'vest']);
    expect(!r.full && r.stackedOver).toBe('jacket');
  });

  it('swaps other categories, takes a worn garment off, and replaces on request', () => {
    let look = put(['jeans', 'tee', 'chinos']);
    expect(look.ids).toEqual(['chinos', 'tee']);
    look = wear(look, g('tee'), slotOf).look;
    expect(look.ids).toEqual(['chinos']);
    look = put(['tee', 'jacket']);
    look = wear(look, g('coat'), slotOf, 'replace').look;
    expect(look.ids).toEqual(['tee', 'coat']);
    expect(wear(put(['jeans']), g('jacket'), slotOf, 'replace').look.ids).toEqual(['jeans', 'jacket']);
  });

  it('caps the upper body at five layers', () => {
    const SL: Record<string, Slot> = { a: 'top', b: 'top', c: 'top', d: 'outer', e: 'outer', f: 'outer' };
    const so = (id: string) => SL[id];
    let look = EMPTY_LOOK;
    for (const id of ['a', 'b', 'c', 'd', 'e']) look = wear(look, { id, slot: SL[id] }, so).look;
    expect(look.ids.length).toBe(MAX_LAYERS);
    const r = wear(look, { id: 'f', slot: 'outer' }, so);
    expect(r.full).toBe(true);
    expect(r.look).toBe(look);
  });

  it('moves layers, swaps in place and keeps how each one is worn', () => {
    let look = put(['tee', 'jeans', 'shirt', 'jacket']);
    look = setStyling(look, 'shirt', { open: true });
    look = moveLayer(look, 'jacket', 1, slotOf);
    expect(look.ids).toEqual(['tee', 'jeans', 'jacket', 'shirt']);
    expect(layersOf(look, slotOf)).toEqual(['tee', 'jacket', 'shirt']);
    look = replaceWith(look, 'shirt', 'vest');
    expect(look.ids).toEqual(['tee', 'jeans', 'jacket', 'vest']);
    expect(look.styling).toEqual({});
    look = setStyling(look, 'vest', { open: false });
    look = setStyling(look, 'vest', { tucked: true });
    expect(look.styling.vest).toEqual({ open: false, tucked: true });
    look = setStyling(look, 'vest', { open: undefined, tucked: undefined });
    expect(look.styling).toEqual({});
    expect(takeOff(setStyling(look, 'tee', { tucked: true }), 'tee').styling).toEqual({});
  });

  it('keeps the old try-on key for one top under one jacket worn as pictured', () => {
    const plain = lookKey(['tee', 'jacket', 'jeans'], {}, slotOf);
    expect(plain).toBe(outfitKey(['tee', 'jacket', 'jeans']));
    expect(lookKey(['jacket', 'tee'], {}, slotOf)).not.toBe(outfitKey(['jacket', 'tee']));
    const layered = lookKey(['tee', 'shirt', 'jacket'], {}, slotOf);
    expect(layered).toBe(`${outfitKey(['tee', 'shirt', 'jacket'])}~tee>shirt>jacket`);
    expect(lookKey(['tee', 'jacket'], { jacket: { open: true } }, slotOf)).toBe(`${outfitKey(['tee', 'jacket'])}~tee>jacket:o`);
    expect(idsOfKey(layered).sort()).toEqual(['jacket', 'shirt', 'tee']);
    expect(idsOfKey(plain).sort()).toEqual(['jacket', 'jeans', 'tee']);
  });

  it('builds looks from saved outfits and from unordered garments', () => {
    expect(lookFrom(['a', 'b', 'a'], { b: { open: true }, gone: { open: false } })).toEqual({ ids: ['a', 'b'], styling: { b: { open: true } } });
    expect(lookFromGarments([g('jacket'), g('jeans'), g('tee')]).ids).toEqual(['tee', 'jacket', 'jeans']);
    expect(lookFrom(['a'], {}, 'natural')).toEqual({ ids: ['a'], styling: {}, makeup: 'natural' });
    expect(lookFrom(['a'], {}, null)).toEqual({ ids: ['a'], styling: {} });
  });

  it('wears several accessories, offers the swap and stops at the cap', () => {
    const SL: Record<string, Slot> = { hat: 'accessory', scarf: 'accessory', watch: 'accessory', ring: 'accessory', belt: 'accessory', tee: 'top' };
    const so = (id: string) => SL[id];
    const ga = (id: string) => ({ id, slot: SL[id] });
    let r = wear(EMPTY_LOOK, ga('hat'), so);
    expect(!r.full && r.stackedOver).toBeUndefined();
    r = wear(r.look, ga('scarf'), so);
    expect(r.look.ids).toEqual(['hat', 'scarf']);
    expect(!r.full && r.stackedOver).toBe('hat');
    r = wear(wear(r.look, ga('watch'), so).look, ga('ring'), so);
    expect(r.look.ids.length).toBe(MAX_ACCESSORIES);
    const full = wear(r.look, ga('belt'), so);
    expect(full.full).toBe(true);
    expect(full.look).toBe(r.look);
    // 去试穿 from another page makes room by swapping the last one.
    expect(wear(r.look, ga('belt'), so, 'replace').look.ids).toEqual(['hat', 'scarf', 'watch', 'belt']);
  });

  it('keeps a garment on when it is tried on again from another page', () => {
    const look = put(['tee', 'jeans']);
    expect(wear(look, g('tee'), slotOf, 'replace').look).toBe(look);
    expect(wear(look, g('tee'), slotOf).look.ids).toEqual(['jeans']);
  });

  it('keeps makeup through changes and keys it last', () => {
    let look: Look = { ...put(['tee', 'jacket']), makeup: 'natural' };
    look = takeOff(wear(look, g('jeans'), slotOf).look, 'jacket');
    expect(look.makeup).toBe('natural');
    expect(replaceWith(look, 'tee', 'shirt').makeup).toBe('natural');
    const plain = lookKey(['tee', 'jacket'], {}, slotOf);
    const made = lookKey(['tee', 'jacket'], {}, slotOf, 'natural');
    expect(made).toBe(`${plain}~mk:natural`);
    expect(withoutMakeupKey(made)).toBe(plain);
    const layered = lookKey(['tee', 'shirt'], {}, slotOf, 'date');
    expect(withoutMakeupKey(layered)).toBe(lookKey(['tee', 'shirt'], {}, slotOf));
    expect(idsOfKey(made).sort()).toEqual(['jacket', 'tee']);
    expect(lookKey([], {}, slotOf, 'natural')).toBe('~mk:natural');
  });
});

describe('makeup', () => {
  it('names presets and the user\'s own words, with a key free of the try-on separators', () => {
    expect(makeupLabel('redlip')).toBe('复古红唇');
    const mine = customMakeup('  橘色腮红|棕色眼线 ');
    expect(makeupLabel(mine)).toBe('橘色腮红|棕色眼线');
    expect(makeupPromptText(mine)).toContain('橘色腮红|棕色眼线');
    expect(makeupPromptText('redlip')).toContain('red lipstick');
    expect(makeupKey('redlip')).toBe('redlip');
    expect(makeupKey(mine)).toMatch(/^c[0-9a-z]+$/);
    expect(makeupKey(mine)).toBe(makeupKey(customMakeup('橘色腮红|棕色眼线')));
    expect(makeupKey(mine)).not.toBe(makeupKey(customMakeup('橘色腮红')));
  });
});

describe('crop boxes', () => {
  it('reads model boxes, pads, measures and converts to pixels', () => {
    const near = (b: { x: number; y: number; w: number; h: number } | null) => b && [b.x, b.y, b.w, b.h].map((v) => Math.round(v * 1000) / 1000);
    expect(near(fromBox2d([100, 200, 600, 700]))).toEqual([0.2, 0.1, 0.5, 0.5]);
    expect(near(fromBox2d([600, 700, 100, -50]))).toEqual([0, 0.1, 0.7, 0.5]);
    expect(fromBox2d([100, 100, 100, 500])).toBeNull();
    expect(fromBox2d([1, 2, 3])).toBeNull();
    expect(fromBox2d('x')).toBeNull();

    const p = padBox({ x: 0.2, y: 0.1, w: 0.5, h: 0.5 });
    expect(p.x).toBeCloseTo(0.17);
    expect(p.w).toBeCloseTo(0.56);
    expect(padBox({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });

    expect(boxArea({ x: 0, y: 0, w: 0.5, h: 0.4 })).toBeCloseTo(0.2);
    const a = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(overlap(a, a)).toBe(1);
    expect(overlap(a, { x: 0.6, y: 0.6, w: 0.2, h: 0.2 })).toBe(0);
    expect(overlap(a, { x: 0.25, y: 0, w: 0.5, h: 0.5 })).toBeCloseTo(1 / 3);

    expect(toPixels({ x: 0.2, y: 0.1, w: 0.5, h: 0.5 }, 1000, 2000)).toEqual({ originX: 200, originY: 200, width: 500, height: 1000 });
    expect(toPixels({ x: 0.999, y: 0.999, w: 0.0001, h: 0.0001 }, 100, 100)).toEqual({ originX: 99, originY: 99, width: 1, height: 1 });
  });
});

describe('dragging the crop box', () => {
  const b = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  it('grabs corners before the body, and nothing outside', () => {
    expect(handleAt(b, 0.21, 0.19, 0.03, 0.03)).toBe('tl');
    expect(handleAt(b, 0.6, 0.6, 0.03, 0.03)).toBe('br');
    expect(handleAt(b, 0.4, 0.4, 0.03, 0.03)).toBe('move');
    expect(handleAt(b, 0.9, 0.9, 0.03, 0.03)).toBeNull();
  });
  it('moves inside the photo and resizes with a minimum size', () => {
    expect(dragBox(b, 'move', 0.9, -0.9)).toEqual({ x: 0.6, y: 0, w: 0.4, h: 0.4 });
    const r = dragBox(b, 'br', 0.1, 0.1);
    expect([r.x, r.y, r.w, r.h].map((v) => Math.round(v * 100))).toEqual([20, 20, 50, 50]);
    const tiny = dragBox(b, 'tl', 0.9, 0.9);
    expect(Math.round(tiny.w * 100)).toBe(5);
    expect(Math.round(tiny.x * 100)).toBe(55);
  });
});
