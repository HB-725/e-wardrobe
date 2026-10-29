import type { Item, Outfit, WearLog } from '../types';
import { computeItemStats, dateParts, formatYuan, idleItems, monthGrid, statsById, toDateKey, wearRank, weekOf } from '../stats';
import { defaultOutfitName, outfitKey, selectionFromItems, selectionIds, todaySuggestions, toggleInSelection } from '../outfit';

function item(id: string, extra: Partial<Item> = {}): Item {
  return {
    id, name: id, slot: 'top', subcategory: null, colorName: null, colorHex: null, seasons: [], brand: null,
    size: null, material: null, priceCents: null, purchasedOn: null, channel: null, location: null, fitNotes: null,
    status: 'active', originalUri: null, catalogUri: null, tagUri: null, fieldSources: {}, error: null,
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
  it('toggles one item per slot', () => {
    let sel = toggleInSelection({}, { id: 'a', slot: 'top' });
    sel = toggleInSelection(sel, { id: 'b', slot: 'top' });
    expect(sel).toEqual({ top: 'b' });
    sel = toggleInSelection(sel, { id: 'b', slot: 'top' });
    expect(sel).toEqual({});
  });

  it('orders selection inner to outer and keys are order-independent', () => {
    const sel = selectionFromItems([{ id: 'o', slot: 'outer' }, { id: 's', slot: 'shoes' }, { id: 't', slot: 'top' }]);
    expect(selectionIds(sel)).toEqual(['s', 't', 'o']);
    expect(outfitKey(['b', 'a', 'a'])).toBe(outfitKey(['a', 'b']));
  });

  it('names outfits after the outermost pieces', () => {
    expect(defaultOutfitName([{ name: 'T恤', slot: 'top' }, { name: '夹克', slot: 'outer' }, { name: '鞋', slot: 'shoes' }])).toBe('夹克 + T恤');
    expect(defaultOutfitName([])).toBe('新穿搭');
  });

  it('suggests never-worn and long-idle outfits first and skips ones with inactive items', () => {
    const o = (id: string, itemIds: string[]): Outfit => ({ id, name: id, occasions: [], itemIds, createdAt: '' });
    const outfits = [o('recent', ['a']), o('old', ['a']), o('never', ['a']), o('broken', ['a', 'gone'])];
    const logs = [log('2026-10-28', ['a'], 'recent'), log('2026-10-01', ['a'], 'old')];
    const s = todaySuggestions(outfits, logs, new Set(['a']), TODAY);
    expect(s.map((x) => x.outfit.id)).toEqual(['never', 'old', 'recent']);
    expect(s[0].badge).toBe('还没穿过');
    expect(s[1].badge).toBe('28 天没穿了');
    expect(s[2].badge).toBeNull();
  });
});
