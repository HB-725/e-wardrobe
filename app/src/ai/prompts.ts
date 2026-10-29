import type { Slot } from '@/domain/types';

export const CATALOG_BG = '#F1F1F2';

const SLOT_EN: Record<Slot, string> = {
  outer: 'outerwear (jacket or coat)',
  top: 'top',
  bottom: 'bottoms (trousers, jeans, shorts or skirt)',
  shoes: 'pair of shoes',
  bag: 'bag',
  accessory: 'accessory',
};

const SLOT_FRAMING: Record<Slot, string> = {
  outer: 'Front view, shown as an invisible-mannequin (ghost mannequin) product shot, closed or naturally open as in the photo, sleeves relaxed at the sides.',
  top: 'Front view, shown as an invisible-mannequin (ghost mannequin) product shot, sleeves relaxed at the sides.',
  bottom: 'Front view, shown flat and straight as a product shot, legs/hem fully visible.',
  shoes: 'Show the pair side by side in a three-quarter side view, as a product shot.',
  bag: 'Front view, upright, handles or strap arranged neatly above the bag, as a product shot.',
  accessory: 'Front view, as a clean product shot.',
};

/** Product-shot prompt. "Change the photography, never the garment." */
export function catalogPrompt(slot: Slot | null): string {
  const what = slot ? SLOT_EN[slot] : 'clothing item';
  const framing = slot ? SLOT_FRAMING[slot] : 'Front view, as a clean product shot.';
  return [
    `Create a clean e-commerce catalog photo of the exact ${what} shown in the reference photo.`,
    framing,
    'Show only this one item: no person, no body parts, no hanger, no props, no text, no watermark.',
    `Seamless solid light gray background (${CATALOG_BG}), soft even studio lighting, a subtle soft shadow beneath the item.`,
    'Centered, the whole item visible with even margins, filling about 75% of the frame height.',
    'Preserve the item exactly: identical color and shade, fabric texture, cut, length and proportions; the same number and position of buttons, zips, pockets, seams and straps; identical prints, patterns, logos and lettering. Never add, remove or invent any detail or logo.',
    'You may smooth out wrinkles, straighten it, correct the angle and lighting, and complete parts that were hidden or folded, consistent with what is visible.',
  ].join('\n');
}

export const AUTOFILL_SYSTEM = [
  '你是服装识别助手。根据用户拍的衣服照片（可能还有吊牌或洗标照片），识别这件单品的信息。',
  '规则：',
  '- name 用 2 到 8 个字的中文常用叫法，例如「牛仔夹克」「白色运动鞋」「灰色针织衫」。',
  '- slot 只能是 outer（外套）/ top（上衣）/ bottom（下装，含裙子）/ shoes（鞋）/ bag（包）/ accessory（配饰）。',
  '- color_name 用中文颜色名，color_hex 是主色的十六进制值。',
  '- seasons 选这件衣服适合的季节。',
  '- brand / size / material 只在照片上清楚可见（例如吊牌、洗标、明显 logo）时填写，看不清就填 null，绝不猜测。',
  '- 如果照片里不是衣服、鞋或包，is_clothing 填 false。',
].join('\n');

export const AUTOFILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_clothing', 'slot', 'name', 'subcategory', 'color_name', 'color_hex', 'seasons', 'brand', 'size', 'material'],
  properties: {
    is_clothing: { type: 'boolean' },
    slot: { type: 'string', enum: ['outer', 'top', 'bottom', 'shoes', 'bag', 'accessory'] },
    name: { type: 'string' },
    subcategory: { type: ['string', 'null'] },
    color_name: { type: ['string', 'null'] },
    color_hex: { type: ['string', 'null'] },
    seasons: { type: 'array', items: { type: 'string', enum: ['spring', 'summer', 'autumn', 'winter'] } },
    brand: { type: ['string', 'null'] },
    size: { type: ['string', 'null'] },
    material: { type: ['string', 'null'] },
  },
} as const;

export interface AutofillResult {
  is_clothing: boolean;
  slot: Slot;
  name: string;
  subcategory: string | null;
  color_name: string | null;
  color_hex: string | null;
  seasons: ('spring' | 'summer' | 'autumn' | 'winter')[];
  brand: string | null;
  size: string | null;
  material: string | null;
}

export const FIDELITY_SYSTEM = [
  '你是服装质检员。图 1 是用户拍的原始照片，图 2 是 AI 生成的商品图。',
  '判断图 2 里是不是同一件衣服，并逐项对比：颜色、版型与长度、纽扣拉链、口袋、图案印花、logo 与文字。',
  '照片里看不到的部分不算错误。褶皱、角度、光线、背景的差异不算错误。',
  'note 用一句简短中文说明差异，没有差异就写「一致」。',
].join('\n');

export const FIDELITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['same_item', 'checks'],
  properties: {
    same_item: { type: 'boolean' },
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
} as const;

export interface FidelityResult {
  same_item: boolean;
  checks: { label: string; ok: boolean; note: string }[];
}

export function avatarPrompt(opts: { heightCm: number | null; weightKg: number | null; build: string | null; photoCount: number }): string {
  const body = [
    opts.heightCm ? `height about ${opts.heightCm} cm` : null,
    opts.weightKg ? `weight about ${opts.weightKg} kg` : null,
    opts.build ? `${opts.build} build` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return [
    `The reference photo${opts.photoCount > 1 ? 's show' : ' shows'} one real person. Create a full-body studio photo of this same person.`,
    'Keep their face, hairstyle, skin tone, body shape and proportions identical to the reference.' + (body ? ` Body: ${body}.` : ''),
    'Pose: standing straight, facing the camera, arms relaxed slightly away from the body, feet slightly apart, neutral expression.',
    'Clothing: a plain fitted light gray crew-neck t-shirt, plain fitted dark gray shorts, plain white low sneakers. No logos, no accessories.',
    `Seamless solid light gray background (${CATALOG_BG}), soft even studio lighting.`,
    'Entire body from head to feet visible, centered, with a small margin above the head and below the feet.',
  ].join('\n');
}

export function tryonPrompt(garments: { slot: Slot; name: string }[], view: 'front' | 'back'): string {
  const list = garments.map((g, i) => `- Image ${i + 2}: ${g.name} (${SLOT_EN[g.slot]})`).join('\n');
  const hasOuter = garments.some((g) => g.slot === 'outer');
  return [
    'Image 1 is a full-body photo of a person. The other images are clothing items:',
    list,
    `Create a photo of the person from image 1 wearing all of these items together${view === 'back' ? ', seen from directly behind (back view)' : ''}.`,
    'Replace their current clothes with these items; anything not listed stays as plain as in image 1.',
    hasOuter ? 'Wear the outerwear on top of the other garments, open at the front if it was shown open.' : '',
    'Each item must keep its exact color, pattern, texture, length and details. Fit them naturally to this person’s body.',
    view === 'front'
      ? 'Keep the person’s face, hair, body shape, pose, framing and the light gray background identical to image 1.'
      : 'Keep the person’s hair, body shape, framing and the light gray background consistent with image 1.',
    'Full body from head to feet visible.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const MIRROR_SYSTEM = [
  '你会看到一张用户的镜子自拍照，以及用户衣橱里的单品清单（JSON）。',
  '找出照片里这个人身上穿着、或手里拿着的、属于清单中的单品。只返回你有把握的匹配，confidence 取 0 到 1。',
  '同一个 slot 最多匹配一件。照片里有但清单中找不到的单品，用中文简短描述写进 unmatched。',
  '对每个匹配到的上衣、外套、下装，用一句中文写出实际上身效果（宽松或修身、衣长到哪里、裤脚状态等），写进 fit_notes。',
].join('\n');

export const MIRROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['matches', 'unmatched', 'fit_notes'],
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'confidence'],
        properties: { id: { type: 'string' }, confidence: { type: 'number' } },
      },
    },
    unmatched: { type: 'array', items: { type: 'string' } },
    fit_notes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'note'],
        properties: { id: { type: 'string' }, note: { type: 'string' } },
      },
    },
  },
} as const;

export interface MirrorResult {
  matches: { id: string; confidence: number }[];
  unmatched: string[];
  fit_notes: { id: string; note: string }[];
}
