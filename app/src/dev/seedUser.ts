/**
 * `?demo=user`: the owner's own nine garments as the app catalogued them on 2026-11-05 (gpt-image-2 after a Gemini
 * 3.1 Flash-Lite analysis), served from `/demo/user/`. The photos are personal and stay out of the repository.
 */
import type { Db } from '@/db/db';
import { createItem } from '@/db/items';
import { avatarVersion, putLayer, putTryon, saveAvatar, setSetting } from '@/db/misc';
import { createOutfit } from '@/db/outfits';
import { logWear } from '@/db/wear';
import { outfitKey } from '@/domain/outfit';
import { toDateKey } from '@/domain/stats';
import type { Item } from '@/domain/types';

const img = (n: string) => `/demo/${n}.jpg`;
const u = (n: string) => `/demo/user/${n}.jpg`;

export async function seedUser(db: Db): Promise<void> {
  const today = new Date();
  const daysAgo = (n: number) => toDateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  const mk = async (p: Partial<Item> & Pick<Item, 'name' | 'slot'>, createdDaysAgo: number) => {
    const sources = Object.fromEntries((['name', 'subcategory', 'colorName', 'seasons', 'brand', 'material'] as const).filter((k) => p[k] != null).map((k) => [k, 'ai' as const]));
    const it = await createItem(db, { status: 'active', fieldSources: sources, ...p });
    await db.runAsync('UPDATE items SET created_at = ? WHERE id = ?', [`${daysAgo(createdDaysAgo)}T09:00:00.000Z`, it.id]);
    return it;
  };
  const hoodie = await mk({ name: '连帽卫衣', slot: 'top', subcategory: '卫衣', colorName: '炭灰', colorHex: '#36363A', seasons: ['spring', 'autumn', 'winter'], brand: 'drew house', fit: { width: 'loose', length: 'short' }, catalogUri: u('catalog-2'), originalUri: u('drew_hoodie') }, 9);
  const nb = await mk({ name: '灰色连帽卫衣', slot: 'top', subcategory: '卫衣', colorName: '浅灰', colorHex: '#B8B8B8', seasons: ['spring', 'autumn', 'winter'], brand: 'New Balance', catalogUri: u('catalog-9'), originalUri: u('nb_hoodie') }, 8);
  const tee = await mk({ name: '黑色短袖T恤', slot: 'top', subcategory: 'T恤', colorName: '黑色', colorHex: '#000000', seasons: ['spring', 'summer'], brand: 'Lacoste', catalogUri: u('catalog-7'), originalUri: u('original-6'), sourceUri: u('lacoste_tee') }, 7);
  const knit = await mk({ name: '灰色针织衫', slot: 'top', subcategory: '针织衫', colorName: '炭灰', colorHex: '#59595B', seasons: ['spring', 'autumn', 'winter'], brand: 'Kith', catalogUri: u('catalog-5'), originalUri: u('original-3'), sourceUri: u('kith_knit') }, 6);
  const levis = await mk({ name: '羊羔毛牛仔外套', slot: 'outer', subcategory: '夹克', colorName: '蓝色', colorHex: '#668FB4', seasons: ['autumn', 'winter'], brand: "Levi's", material: '牛仔', catalogUri: u('catalog-8'), originalUri: u('levis_sherpa') }, 5);
  const carhartt = await mk({ name: '卡哈特工装夹克', slot: 'outer', subcategory: '夹克', colorName: '褪色黑', colorHex: '#3E3D38', seasons: ['spring', 'autumn', 'winter'], brand: 'Carhartt', catalogUri: u('catalog-15'), originalUri: u('original-13'), sourceUri: u('carhartt_selfie') }, 4);
  const parka = await mk({ name: '黑色连帽冲锋衣', slot: 'outer', subcategory: '冲锋衣', colorName: '黑色', colorHex: '#1A1A1A', seasons: ['autumn', 'winter'], catalogUri: u('catalog-14'), originalUri: u('original-12'), sourceUri: u('parka_selfie') }, 3);
  const pants = await mk({ name: '黑色运动裤', slot: 'bottom', subcategory: '运动裤', colorName: '黑色', colorHex: '#1A1A1C', seasons: ['spring', 'autumn', 'winter'], brand: 'Nike', catalogUri: u('catalog-11'), originalUri: u('original-10'), sourceUri: u('nike_pants') }, 2);
  // The ninth is still waiting for its owner's check, with what the check found.
  await createItem(db, {
    name: '飞行员夹克',
    slot: 'outer',
    subcategory: '夹克',
    colorName: '黑色',
    colorHex: '#000000',
    seasons: ['autumn', 'winter'],
    brand: 'Kith',
    status: 'review',
    originalUri: u('original-1'),
    sourceUri: u('kith_bomber'),
    candidates: [u('catalog-4')],
    checks: [
      [
        { label: '主色 黑色', ok: true, note: '一致' },
        { label: '胸前翻盖袋 2 个、左胸小字 logo', ok: true, note: '一致' },
        { label: '罗纹领、短款、长袖', ok: true, note: '一致' },
        { label: '尼龙面料微光泽', ok: true, note: '一致' },
      ],
    ],
    fieldSources: { name: 'ai', subcategory: 'ai', colorName: 'ai', seasons: 'ai', brand: 'ai' },
  });

  const avatar = await saveAvatar(db, { frontUri: img('avatar_front'), backUri: img('avatar_back'), greenFrontUri: `/demo/avatar_green.png`, sourceUris: [], heightCm: 175, weightKg: 64, build: 'slim', status: 'ready' });
  // The fitting room's layers for the three garments of 周末出门, painted by the real pipeline on 2026-11-05.
  const version = avatarVersion(avatar);
  for (const [itemId, name, variant] of [[hoodie.id, 'hoodie', 'closed'], [carhartt.id, 'jacket', 'closed'], [carhartt.id, 'jacket', 'open'], [pants.id, 'pants', 'closed']] as const) {
    await putLayer(db, { itemId, avatarVersion: version, view: 'front', variant, uri: `/demo/user/out/layer-${name}-${variant}.png` });
  }
  await setSetting(db, 'prefs', JSON.stringify({ nickname: '小林', mirrorAutoLog: true, idleDays: 30 }));
  const now = new Date().toISOString();
  await setSetting(db, 'ai.keys', JSON.stringify([
    { id: 'openai', provider: 'openai', label: 'OpenAI（内置）', last4: '8F2A', addedAt: now, verifiedAt: now, models: ['gpt-image-2', 'gpt-image-1-mini', 'gpt-5.4-mini', 'gpt-5.4-nano'], blocked: [] },
    { id: 'gemini', provider: 'gemini', label: 'Gemini（内置）', last4: 'Q3bK', addedAt: now, verifiedAt: now, models: ['gemini-3.1-flash-lite', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image'], blocked: [] },
  ]));

  // Tops before outerwear: upper-body garments are stored innermost first.
  const weekend = await createOutfit(db, { name: '周末出门', occasions: ['weekend'], itemIds: [hoodie.id, carhartt.id, pants.id] });
  const work = await createOutfit(db, { name: '秋日通勤', occasions: ['work'], itemIds: [knit.id, parka.id, pants.id] });
  const casual = await createOutfit(db, { name: '轻松卫衣日', occasions: ['weekend', 'travel'], itemIds: [nb.id, levis.id, pants.id] });
  const summer = await createOutfit(db, { name: '初夏简单', occasions: ['date'], itemIds: [tee.id, pants.id] });
  const key = outfitKey(weekend.itemIds);
  await putTryon(db, key, 'front', img('avatar_front'), u('out/tryon_front'));
  await putTryon(db, key, 'back', img('avatar_front'), u('out/tryon_back'));

  const plan: [number, typeof weekend][] = [
    [1, work], [2, casual], [3, weekend], [5, work], [6, summer], [8, casual], [9, work], [12, weekend], [15, work], [19, casual], [22, work], [26, weekend],
  ];
  for (const [d, o] of plan) await logWear(db, { date: daysAgo(d), itemIds: o.itemIds, outfitId: o.id, source: 'outfit' });
  // What catalogueing the nine cost (gpt-image-2 after a Gemini analysis, 2026-11-05) and one try-on.
  for (const [kind, model, usd] of [
    ...Array.from({ length: 9 }, () => ['catalog', 'gpt-image-2', 0.0185] as const),
    ['tryon', 'gpt-image-1-mini', 0.028] as const,
    ['photo', 'gpt-image-1-mini', 0.031] as const,
  ]) {
    await db.runAsync('INSERT INTO usage (id, kind, model, cost_usd, created_at) VALUES (?, ?, ?, ?, ?)', [Math.random().toString(36).slice(2), kind, model, usd, now]);
  }
}
