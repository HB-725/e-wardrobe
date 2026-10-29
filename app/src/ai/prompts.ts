import { SLOT_LABEL } from '@/domain/catalog';
import type { Slot } from '@/domain/types';

/** Shared look of every catalog image; the app's card colour, so pictures blend into the UI. */
export const CATALOG_BG = '#F1F1F2';

// ---------- autofill ----------

export const AUTOFILL_SYSTEM =
  '你是服装整理助手。根据照片识别一件衣物的属性，用简体中文填写。看不清或不确定的字段填 null，不要猜。';

export function autofillText(hasTag: boolean): string {
  return [
    '第 1 张图是衣服本身。',
    hasTag ? '第 2 张图是这件衣服的吊牌或洗标，品牌、尺码、材质优先从吊牌读取，并把读自吊牌的字段名列在 fromTag 里。' : '没有吊牌照片，fromTag 返回空数组。',
    'name：2–6 个字的简短名称，例如「牛仔夹克」「白色衬衫」「直筒牛仔裤」。',
    'slot：outer 外套 / top 上衣 / bottom 下装（裤、裙）/ shoes 鞋 / bag 包 / accessory 配饰（帽、围巾、腰带等）。连衣裙算 top。',
    'subcategory：更细的类别，例如「夹克」「衬衫」「半裙」。',
    'colorName：主色的中文名，例如「靛蓝」「米白」；colorHex：主色的十六进制。',
    'seasons：适合的季节，可多选。',
  ].join('\n');
}

export const AUTOFILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'slot', 'subcategory', 'colorName', 'colorHex', 'seasons', 'brand', 'size', 'material', 'fromTag', 'isGarment'],
  properties: {
    isGarment: { type: 'boolean', description: 'false if the photo does not show a clothing item, shoes or bag' },
    name: { type: 'string' },
    slot: { type: 'string', enum: ['outer', 'top', 'bottom', 'shoes', 'bag', 'accessory'] },
    subcategory: { type: ['string', 'null'] },
    colorName: { type: ['string', 'null'] },
    colorHex: { type: ['string', 'null'] },
    seasons: { type: 'array', items: { type: 'string', enum: ['spring', 'summer', 'autumn', 'winter'] } },
    brand: { type: ['string', 'null'] },
    size: { type: ['string', 'null'] },
    material: { type: ['string', 'null'] },
    fromTag: { type: 'array', items: { type: 'string', enum: ['brand', 'size', 'material'] } },
  },
} as const;

export interface AutofillResult {
  isGarment: boolean;
  name: string;
  slot: Slot;
  subcategory: string | null;
  colorName: string | null;
  colorHex: string | null;
  seasons: ('spring' | 'summer' | 'autumn' | 'winter')[];
  brand: string | null;
  size: string | null;
  material: string | null;
  fromTag: ('brand' | 'size' | 'material')[];
}

// ---------- catalog image ----------

const SLOT_EN: Record<Slot, string> = {
  outer: 'outerwear piece',
  top: 'top',
  bottom: 'bottoms',
  shoes: 'pair of shoes',
  bag: 'bag',
  accessory: 'accessory',
};

export function catalogPrompt(slot: Slot, name: string | null, color?: { name: string | null; hex: string | null }): string {
  const what = SLOT_EN[slot];
  const colorLine = color?.hex
    ? `The main colour measured from the photo is ${color.hex}${color.name ? ` (${color.name})` : ''}; reproduce exactly that colour, correcting only for the photo's lighting cast.`
    : null;
  const framing =
    slot === 'shoes'
      ? 'Show the pair side by side at a slight three-quarter angle, as on an online shop product page.'
      : slot === 'bag' || slot === 'accessory'
        ? 'Show it front-on, upright, as on an online shop product page.'
        : 'Show it front view, laid flat / ghost-mannequin style, symmetrical and straightened, as on an online shop product page.';
  return [
    `Turn the photo into a clean e-commerce catalog image of this exact ${what}${name ? ` (${name})` : ''}.`,
    framing,
    `Perfectly flat, uniform background of exactly ${CATALOG_BG} (RGB 241,241,242) edge to edge: no gradient, no vignette, no floor line, no props, no hanger, no person, no text, no watermark.`,
    'Centered with even margins, the item fills about 80% of the frame height. Soft diffused studio light, only a very faint contact shadow.',
    'Change only the photography: you may smooth wrinkles, straighten the angle, even out the lighting and complete parts that were hidden or folded.',
    'Never change the item itself: keep the exact colour, cut and silhouette, length, number and position of buttons, pockets and zips, prints, logos, stitching and fabric texture.',
    colorLine,
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------- fidelity check ----------

export const FIDELITY_SYSTEM =
  '你是服装商品图质检员。对比原图和生成的商品图，检查生成图有没有改变衣服本身。用简体中文，简短。';

export function fidelityText(candidates: number): string {
  return [
    `第 1 张是用户拍的原图，后面 ${candidates} 张是生成的商品图（方案 1 到 ${candidates}）。`,
    '对每个方案输出 4 项检查，依次是：主色、细节（纽扣/口袋/拉链/印花/logo，写出具体数量或内容）、版型与长度、面料质感。',
    'label 写检查项和看到的内容，例如「纽扣 4 颗、胸袋 2 个」；ok 表示和原图一致；note 写「一致」或差别，不超过 8 个字。',
  ].join('\n');
}

export const FIDELITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['checks'],
        properties: {
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['label', 'ok', 'note'],
              properties: { label: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string' } },
            },
          },
        },
      },
    },
  },
} as const;

export interface FidelityResult {
  candidates: { checks: { label: string; ok: boolean; note: string }[] }[];
}

// ---------- avatar ----------

const BUILD_EN: Record<string, string> = { slim: 'slim', avg: 'average', ath: 'athletic', full: 'full-figured' };

export function avatarFrontPrompt(body: { heightCm: number | null; weightKg: number | null; build: string | null }): string {
  const stats = [
    body.heightCm ? `${body.heightCm} cm tall` : null,
    body.weightKg ? `${body.weightKg} kg` : null,
    body.build ? `${BUILD_EN[body.build] ?? body.build} build` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return [
    'Create a photorealistic full-body studio photo of the same person shown in the reference photos.',
    'Keep their face, hairstyle, skin tone and body proportions exactly' + (stats ? ` (${stats}).` : '.'),
    'Pose: standing straight, facing the camera, arms relaxed slightly away from the body, feet hip-width apart, neutral expression.',
    'Clothing: a plain fitted light-grey crew-neck t-shirt, plain fitted dark-grey shorts, barefoot. No accessories, no bag.',
    `Solid plain ${CATALOG_BG} background, soft even studio light.`,
    'Framing: the whole body from the top of the head to the feet is visible and centered; head top at about 5% from the top edge, feet at about 95%.',
  ].join(' ');
}

export function avatarBackPrompt(): string {
  return [
    'The first image is a person in a studio. Create the same person, same clothing, same lighting, background and framing,',
    'but seen from directly behind (back view), standing in the same pose. If a second image is given, use it as reference for how their back and hair look.',
    'Head top at about 5% from the top edge, feet at about 95%.',
  ].join(' ');
}

// ---------- try-on ----------

export function tryonPrompt(slots: Slot[], view: 'front' | 'back'): string {
  // Seen from behind, the model copies any print it can see; saying each picture is the front helps.
  const side = view === 'back' ? ', photographed from the front' : '';
  const list = slots.map((s, i) => `image ${i + 2}: ${SLOT_EN[s]} (${SLOT_LABEL[s]})${side}`).join('; ');
  // Worded like photoPrompt on purpose: "dress this person ... layer naturally" made the model turn a plain tee
  // into an open overshirt worn over a tee (verified with gpt-image-1-mini).
  return [
    `Image 1 is a person in plain base clothes in a studio. The other images are the garments to put on: ${list}.`,
    `Show this exact person wearing exactly these garments, all ${slots.length} of them (none left out), with the same pose, framing, background and lighting as image 1.`,
    view === 'back'
      ? 'The person is seen from behind, so only the back of each garment is visible. The garment images show only their fronts, and every back is completely plain: same fabric and colour, with no print, logo, heart, emblem, text, buttons or front pockets anywhere on it, even when the front has one. An inner top shows only at the neck or hem if at all, plain.'
      : 'Keep the front view.',
    'The garments replace the matching base clothes; for any category without an image, keep what the person wears in image 1. Shoes replace bare feet.',
    slots.includes('outer') ? 'The outerwear is worn over the top.' : null,
    'Do not add any garment, layer, jacket, overshirt, cardigan or accessory that is not shown in the images.',
    'Keep each garment exactly as shown: colour, pattern, logos and prints (same position and size), buttons, pockets, length and fit.',
    'Keep the face, hair and body shape exactly the same. Photorealistic.',
  ]
    .filter(Boolean)
    .join(' ');
}

export interface Scene {
  id: string;
  label: string;
  prompt: string;
}

export const SCENES: Scene[] = [
  { id: 'cafe', label: '咖啡馆', prompt: 'standing in a bright cozy cafe with large windows, natural daylight' },
  { id: 'street', label: '街头', prompt: 'walking on a city street in the afternoon, shallow depth of field, street-style photo' },
  { id: 'office', label: '办公室', prompt: 'standing in a modern bright office' },
  { id: 'park', label: '公园', prompt: 'standing in a green park on a sunny day' },
  { id: 'studio', label: '纯色棚拍', prompt: `in a fashion photo studio with a plain ${CATALOG_BG} backdrop, editorial lighting` },
];

/**
 * One instruction for dressing the avatar and placing them in a scene. (Chaining the try-on prompt with a
 * "fashion photo" one made the model invent extra layers, e.g. an overshirt over a plain tee.)
 */
export function photoPrompt(slots: Slot[], scene: Scene): string {
  const list = slots.map((s, i) => `image ${i + 2}: ${SLOT_EN[s]} (${SLOT_LABEL[s]})`).join('; ');
  return [
    `Image 1 is a person in plain base clothes. The other images are the garments to put on: ${list}.`,
    `Create a realistic, high-quality full-body fashion photo of this exact person ${scene.prompt}, wearing exactly these garments.`,
    'The garments replace the matching base clothes; for any category without an image, keep what the person wears in image 1. Shoes replace bare feet.',
    'Do not add any garment, layer, jacket, overshirt, cardigan or accessory that is not shown in the images.',
    'Keep each garment exactly as shown: colour, pattern, logos and prints (same position and size), buttons, pockets, length and fit.',
    'Keep the face, hair and body shape exactly the same. Natural relaxed pose, full body visible from head to shoes.',
  ].join(' ');
}

// ---------- mirror photo ----------

export const MIRROR_SYSTEM =
  '你帮用户记录今天穿了哪些衣服。对比镜子照片和衣橱里的单品图，找出照片里穿着的单品。用简体中文。';

export function mirrorText(items: { index: number; name: string; slot: Slot; color: string | null }[]): string {
  return [
    '第 1 张是用户今天的镜子照片。后面依次是衣橱里的单品图，编号如下：',
    ...items.map((it) => `${it.index}. ${SLOT_LABEL[it.slot]} · ${it.name}${it.color ? ` · ${it.color}` : ''}`),
    '逐层检查照片里的外套、上衣、下装、鞋、包和配饰；外套敞开时，里面的上衣也要算。',
    '在 matches 里列出照片中穿着的单品编号，每个品类最多一件。颜色、版型、细节都相符才算匹配。confidence：high / medium / low。',
    'note：如果能看出实际上身效果和单品图不同（更宽松、衣长、裤脚堆积等），写一句不超过 30 字的合身笔记，否则写空字符串。',
    'unmatched：照片中穿着、但衣橱里没有的衣服，简短描述。',
  ].join('\n');
}

export const MIRROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matches', 'unmatched'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'confidence', 'note'],
        properties: {
          index: { type: 'integer' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          note: { type: 'string' },
        },
      },
    },
    unmatched: { type: 'array', items: { type: 'string' } },
  },
} as const;

export interface MirrorResult {
  matches: { index: number; confidence: 'high' | 'medium' | 'low'; note: string }[];
  unmatched: string[];
}
