/**
 * Demo wardrobe for the web preview (open the web build with `?demo=1`). Images are served from `/demo/*.jpg`,
 * which the screenshot script copies next to the exported site; nothing here ships in the Android bundle.
 */
import type { Db } from '@/db/db';
import { createItem } from '@/db/items';
import { putTryon, saveAvatar, setSetting } from '@/db/misc';
import { createOutfit } from '@/db/outfits';
import { logWear } from '@/db/wear';
import { outfitKey } from '@/domain/outfit';
import { toDateKey } from '@/domain/stats';
import type { Item } from '@/domain/types';

const img = (n: string) => `/demo/${n}.jpg`;

export async function seedDemo(db: Db, variant: string): Promise<void> {
  if (variant === 'empty') return;
  const today = new Date();
  const daysAgo = (n: number) => toDateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  const mk = async (p: Partial<Item> & Pick<Item, 'name' | 'slot'>, createdDaysAgo: number) => {
    const it = await createItem(db, { status: 'active', fieldSources: { name: 'ai', colorName: 'ai', seasons: 'ai' }, ...p });
    await db.runAsync('UPDATE items SET created_at = ? WHERE id = ?', [`${daysAgo(createdDaysAgo)}T09:00:00.000Z`, it.id]);
    return it;
  };
  const jacket = await mk({ name: '军绿牛仔夹克', slot: 'outer', subcategory: '夹克', colorName: '军绿', colorHex: '#4B5D33', seasons: ['spring', 'autumn'], size: 'M', material: '棉 100%', priceCents: 39900, purchasedOn: '2025-09-14', location: '卧室衣柜 · 左二层', catalogUri: img('jacket'), originalUri: img('jacket_raw'), fitNotes: '略宽松，落肩，衣长到胯部。', fieldSources: { name: 'ai', colorName: 'ai', seasons: 'ai', size: 'tag', material: 'tag' } }, 200);
  const tee = await mk({ name: '白色爱心T恤', slot: 'top', subcategory: 'T恤', colorName: '纯白', colorHex: '#F3F0EA', seasons: ['spring', 'summer', 'autumn'], priceCents: 9900, catalogUri: img('tee'), originalUri: img('tee_raw') }, 190);
  const jeans = await mk({ name: '黑色直筒牛仔裤', slot: 'bottom', subcategory: '牛仔裤', colorName: '黑色', colorHex: '#151516', seasons: ['spring', 'autumn', 'winter'], priceCents: 29900, catalogUri: img('jeans'), originalUri: img('jeans_raw') }, 180);
  const sneakers = await mk({ name: '白色运动鞋', slot: 'shoes', subcategory: '板鞋', colorName: '白色', colorHex: '#F4F4F2', seasons: ['spring', 'summer', 'autumn'], priceCents: 59900, catalogUri: img('sneakers'), originalUri: img('sneakers_raw') }, 170);
  const coat = await mk({ name: '驼色羊毛大衣', slot: 'outer', subcategory: '大衣', colorName: '驼色', colorHex: '#B38755', seasons: ['autumn', 'winter'], priceCents: 129900, catalogUri: img('coat') }, 160);
  const shirt = await mk({ name: '牛津衬衫', slot: 'top', subcategory: '衬衫', colorName: '浅蓝', colorHex: '#BFD3EA', seasons: ['spring', 'autumn'], catalogUri: img('shirt') }, 150);
  const knit = await mk({ name: '麻花针织衫', slot: 'top', subcategory: '毛衣', colorName: '墨绿', colorHex: '#2F4A3A', seasons: ['autumn', 'winter'], catalogUri: img('knit') }, 140);
  const chinos = await mk({ name: '卡其休闲裤', slot: 'bottom', subcategory: '休闲裤', colorName: '卡其', colorHex: '#C4B697', seasons: ['spring', 'autumn'], catalogUri: img('chinos') }, 130);
  const skirt = await mk({ name: '百褶半裙', slot: 'bottom', subcategory: '半裙', colorName: '炭灰', colorHex: '#3A3A3C', seasons: ['autumn', 'winter'], catalogUri: img('skirt') }, 120);
  const loafers = await mk({ name: '乐福鞋', slot: 'shoes', subcategory: '皮鞋', colorName: '深棕', colorHex: '#4A3426', seasons: ['spring', 'autumn', 'winter'], catalogUri: img('loafers') }, 110);
  const tote = await mk({ name: '帆布托特包', slot: 'bag', subcategory: '托特包', colorName: '米色', colorHex: '#D6C9B0', seasons: ['spring', 'summer', 'autumn'], catalogUri: img('tote') }, 100);
  await createItem(db, {
    name: '连帽羽绒服',
    slot: 'outer',
    subcategory: '羽绒服',
    colorName: '灰褐',
    status: 'review',
    originalUri: img('puffer'),
    candidates: [img('puffer'), img('jacket2')],
    checks: [
      [
        { label: '主色：灰褐', ok: true, note: '一致' },
        { label: '拉链 1 条、侧袋 2 个', ok: true, note: '与原图相同' },
        { label: '版型与衣长', ok: true, note: '一致' },
        { label: '面料光泽', ok: false, note: '略有简化' },
      ],
      [{ label: '主色', ok: false, note: '颜色不同' }],
    ],
    fieldSources: { name: 'ai', colorName: 'ai', subcategory: 'ai' },
  });

  if (variant === 'noavatar') return;
  await saveAvatar(db, { frontUri: img('avatar_front'), backUri: img('avatar_back'), sourceUris: [], heightCm: 175, weightKg: 64, build: 'slim', status: 'ready' });
  await setSetting(db, 'prefs', JSON.stringify({ nickname: '小林', mirrorAutoLog: true, idleDays: 30 }));
  await setSetting(db, 'ai.keyLast4', '8F2A');
  await setSetting(db, 'ai.models', JSON.stringify({ image: 'gpt-image-1-mini', vision: 'gpt-5.4-nano', blocked: [], probedAt: new Date().toISOString() }));

  const weekend = await createOutfit(db, { name: '周末出门', occasions: ['weekend'], itemIds: [jacket.id, tee.id, jeans.id, sneakers.id] });
  const work = await createOutfit(db, { name: '秋日通勤', occasions: ['work'], itemIds: [coat.id, shirt.id, chinos.id, loafers.id, tote.id] });
  const skirtLook = await createOutfit(db, { name: '裙装约会', occasions: ['date', 'work'], itemIds: [knit.id, skirt.id, loafers.id, tote.id] });
  const casual = await createOutfit(db, { name: '轻松卫衣日', occasions: ['weekend', 'travel'], itemIds: [knit.id, jeans.id, sneakers.id] });
  const key = outfitKey(weekend.itemIds);
  await putTryon(db, key, 'front', img('avatar_front'), img('tryon_front'));
  await putTryon(db, key, 'back', img('avatar_front'), img('tryon_back'));

  const plan: [number, typeof weekend][] = [
    [1, work], [2, skirtLook], [3, weekend], [6, work], [8, casual], [9, work], [13, skirtLook], [16, work], [20, weekend], [23, work], [27, casual],
  ];
  for (const [d, o] of plan) await logWear(db, { date: daysAgo(d), itemIds: o.itemIds, outfitId: o.id, source: 'outfit' });
  // A small spend history for the Me page.
  const now = new Date().toISOString();
  for (const [kind, usd] of [['catalog', 0.012], ['catalog', 0.014], ['avatar', 0.045], ['tryon', 0.032], ['photo', 0.032], ['mirror', 0.002]] as const) {
    await db.runAsync('INSERT INTO usage (id, kind, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)', [Math.random().toString(36).slice(2), kind, 'demo', usd, now]);
  }
}
