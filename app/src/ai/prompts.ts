import { SLOT_LABEL } from '@/domain/catalog';
import type { Slot, Styling } from '@/domain/types';

/** Shared look of every catalog image; the app's card colour, so pictures blend into the UI. */
export const CATALOG_BG = '#F1F1F2';

// ---------- autofill ----------

export const AUTOFILL_SYSTEM =
  '你是服装整理助手。根据照片识别一件衣物的属性，用简体中文填写。看不清或不确定的字段填 null，不要猜。';

const FIELD_LINES = [
  'name：2–6 个字的简短名称，例如「牛仔夹克」「白色衬衫」「直筒牛仔裤」。',
  'slot：outer 外套 / top 上衣 / bottom 下装（裤、裙）/ shoes 鞋 / bag 包 / accessory 配饰（帽、围巾、腰带等）。连衣裙算 top。',
  'subcategory：更细的类别，例如「夹克」「衬衫」「半裙」。',
  'colorName：主色的中文名，例如「靛蓝」「米白」；colorHex：主色的十六进制。',
  'seasons：适合的季节，可多选。',
  'printText：衣服上印的文字、logo 字样，逐字抄写（含大小写）；没有文字填 null。',
];

const tagLine = (hasTag: boolean) =>
  hasTag ? '第 2 张图是这件衣服的吊牌或洗标，品牌、尺码、材质优先从吊牌读取，并把读自吊牌的字段名列在 fromTag 里。' : '没有吊牌照片，fromTag 返回空数组。';

export function autofillText(hasTag: boolean): string {
  return ['第 1 张图是衣服本身。', tagLine(hasTag), ...FIELD_LINES].join('\n');
}

export const AUTOFILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'slot', 'subcategory', 'colorName', 'colorHex', 'seasons', 'brand', 'size', 'material', 'printText', 'fromTag', 'isGarment'],
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
    printText: { type: ['string', 'null'] },
    fromTag: { type: 'array', items: { type: 'string', enum: ['brand', 'size', 'material'] } },
  },
} as const;

// ---------- every garment on a photo ----------

export const DETECT_SYSTEM =
  '你是服装整理助手。找出照片里的每一件衣物，给出位置并识别属性，用简体中文填写。看不清或不确定的字段填 null，不要猜。';

export function detectText(hasTag: boolean): string {
  return [
    '第 1 张图是用户要录入衣橱的照片，可能是单件衣物，也可能是一个人的穿搭照。',
    '在 garments 里列出照片里的每一件衣物（衣服、裤裙、鞋、包、配饰），每件单独一项，最显眼的在前。',
    '只算人身上穿戴的，或照片的主体（平铺、挂着、模特身上的）。店里货架上的、背景里的、别人身上的都不算；镜子里和本人重复出现的只算一次。外套敞开时，里面的上衣单独一项。',
    '一双鞋、一副手套算一件，框住两只。衣服上的印花、图案、logo、文字是衣服的一部分，不要单独列成一项。吊牌、洗标、衣架、包装袋、鞋盒不是衣物，不要列出。搭在椅子、沙发、床上或放在旁边的毯子、围巾、衣服不算。',
    'box_2d：这件衣物在照片里的范围 [ymin, xmin, ymax, xmax]，按 0–1000 归一化，左上角是 (0, 0)。框要包住整件，包括被手、包带挡住的部分，不要包进别的衣物。',
    tagLine(hasTag),
    ...FIELD_LINES,
  ].join('\n');
}

const AUTOFILL_FIELDS = (({ isGarment: _skip, ...rest }) => rest)(AUTOFILL_SCHEMA.properties);

export const DETECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['garments'],
  properties: {
    garments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['box_2d', ...AUTOFILL_SCHEMA.required.filter((k) => k !== 'isGarment')],
        properties: {
          box_2d: { type: 'array', items: { type: 'integer' }, description: '[ymin, xmin, ymax, xmax], 0–1000' },
          ...AUTOFILL_FIELDS,
        },
      },
    },
  },
} as const;

export type GarmentFields = Omit<AutofillResult, 'isGarment'>;

export interface DetectResult {
  garments: (GarmentFields & { box_2d: number[] })[];
}

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
  /** Text printed on the garment, letter for letter; the image models misspell it otherwise. */
  printText: string | null;
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

export function catalogPrompt(slot: Slot, name: string | null, color?: { name: string | null; hex: string | null }, hint?: string | null, printText?: string | null): string {
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
    `Turn the photo into a clean e-commerce catalog image of this exact ${what}${name ? ` (${name})` : ''}, as it really is.`,
    framing,
    `Perfectly flat, uniform background of exactly ${CATALOG_BG} (RGB 241,241,242) edge to edge: no gradient, no vignette, no floor line, no props, no hanger, no person, no text, no watermark.`,
    'Centered with even margins, the item fills about 80% of the frame height. Soft diffused studio light, only a very faint contact shadow.',
    'Change only the photography: smooth out creases from folding, straighten the angle, even out the lighting cast. Where a part is hidden or folded, show it only as this garment must have it, adding nothing.',
    // Image models tend to draw a new garment from the shop; the owner wants their own one, wear included.
    "This is the owner's own garment, possibly worn and washed: keep every sign of wear exactly as in the photo (fading, stone or acid wash, faded or cracked prints, distressing, raw hems, pilling). A faded black stays faded, heather stays heather; do not make it look new and do not change its shade.",
    'Keep the exact cut and silhouette, length, collar, number and position of buttons, pockets and zips, stitching and fabric texture.',
    'Any text, logo or label: copy it character for character from the photo, same font, size and place. If it is too small to read, keep it as an illegible mark of the same size in the same place rather than inventing words.',
    colorLine,
    printText?.trim() ? `The print on it reads exactly "${printText.trim()}": reproduce that text letter for letter, in the same font, size and place.` : null,
    // Last, so it wins over the generic rules: the owner knows the real garment.
    hint?.trim() ? `Notes from the owner of this garment, follow them: ${hint.trim()}` : null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Added to a catalog prompt when the last image sent is an existing catalog image of another garment. */
export const STYLE_REF_NOTE =
  'The last image is a different garment from the same catalog, given only as a style reference: match its background, lighting, framing and scale. Do not copy anything of that garment; draw only the item from the first photo.';

// ---------- fidelity check ----------

export const FIDELITY_SYSTEM =
  '你是服装商品图质检员。对比原图和生成的商品图，检查生成图有没有改变衣服本身。用简体中文，简短。';

export function fidelityText(candidates: number): string {
  return [
    `第 1 张是用户拍的原图，后面 ${candidates} 张是生成的商品图（方案 1 到 ${candidates}）。`,
    '对每个方案输出 4 项检查，依次是：主色、细节（纽扣/口袋/拉链/印花/logo，写出具体数量或内容；有文字时逐字对，差一个字母也算不一致）、版型与长度（领型、袖长、裤腿宽窄、松紧、衣长都要对）、面料质感。',
    'label 写检查项和看到的内容，例如「纽扣 4 颗、胸袋 2 个」；ok 表示和原图一致，拿不准就填 false；note 写「一致」或差别，不超过 8 个字。',
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

/** A garment as it goes into a try-on or photo prompt: its category and how it is worn. */
export interface Worn {
  slot: Slot;
  styling?: Styling;
}

const isUpperSlot = (s: Slot) => s === 'top' || s === 'outer';

/**
 * Layering lines for the upper body (images numbered from 2, in the order given). One top under one outerwear
 * piece worn as pictured keeps the wording verified before layering existed.
 */
function layering(garments: Worn[]): string[] {
  const upper = garments.map((g, i) => ({ ...g, image: i + 2 })).filter((g) => isUpperSlot(g.slot));
  const styled = upper.some((g) => g.styling && (g.styling.open !== undefined || g.styling.tucked !== undefined));
  const plain = upper.length === 2 && upper[0].slot === 'top' && upper[1].slot === 'outer' && !styled;
  if (upper.length < 2 && !styled) return [];
  if (plain) return ['The outerwear is worn over the top.'];
  const lines: string[] = [];
  if (upper.length >= 2) {
    lines.push(
      `Upper-body layers from innermost to outermost: ${upper.map((g) => `image ${g.image} (${SLOT_EN[g.slot]})`).join(', then ')}.`,
      'Each layer is worn over the one before it; an inner layer shows only where the layers over it leave it visible (collar, hem, cuffs, an open front).',
    );
  }
  for (const g of upper) {
    const how: string[] = [];
    if (g.styling?.open === true) how.push('worn open (unbuttoned / unzipped)');
    if (g.styling?.open === false) how.push('worn closed (buttoned / zipped up)');
    if (g.styling?.tucked === true) how.push('tucked into the bottoms');
    if (g.styling?.tucked === false) how.push('worn untucked');
    if (how.length) lines.push(`The garment in image ${g.image} is ${how.join(' and ')}.`);
  }
  return lines;
}

/** Several accessories: each one goes where it is normally worn, and none is left out. */
function accessories(garments: Worn[]): string | null {
  const images = garments.map((g, i) => (g.slot === 'accessory' ? i + 2 : 0)).filter(Boolean);
  return images.length > 1 ? `Wear all ${images.length} accessories (images ${images.join(', ')}) together, each where it is normally worn.` : null;
}

/** Last, so it wins over the generic rules (as in catalogPrompt). */
const notes = (hint?: string | null) => (hint?.trim() ? `Notes from the user, follow them: ${hint.trim()}` : null);

const fixLine = (fix?: string | null) => (fix ? `A previous attempt went wrong (${fix}); avoid that this time.` : null);

export function tryonPrompt(garments: Worn[], hint?: string | null, fix?: string | null): string {
  const slots = garments.map((g) => g.slot);
  const list = slots.map((s, i) => `image ${i + 2}: ${SLOT_EN[s]} (${SLOT_LABEL[s]})`).join('; ');
  // Worded like photoPrompt on purpose: "dress this person ... layer naturally" made the model turn a plain tee
  // into an open overshirt worn over a tee (verified with gpt-image-1-mini).
  return [
    `Image 1 is a person in plain base clothes in a studio. The other images are the garments to put on: ${list}.`,
    `Show this exact person wearing exactly these garments, all ${slots.length} of them (none left out), with the same front view, pose, framing, background and lighting as image 1.`,
    'The garments replace the matching base clothes; for any category without an image, keep what the person wears in image 1. Shoes replace bare feet.',
    ...layering(garments),
    accessories(garments),
    'Do not add any garment, layer, jacket, overshirt, cardigan or accessory that is not shown in the images.',
    'Keep each garment exactly as shown: colour, pattern, logos and prints (same position and size), buttons, pockets, length and fit.',
    'Keep the face, hair and body shape exactly the same. The whole body is in frame, from above the top of the head to below the shoes. Photorealistic.',
    notes(hint),
    fixLine(fix),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The back view turns the front try-on around. Given flat product shots instead, the model kept copying chest
 * prints onto the back whatever the prompt said; from the dressed front it gets them right (7/7 in tests).
 */
export function tryonBackPrompt(garments: { slot: Slot; colorHex: string | null }[], hint?: string | null): string {
  const list = garments.map((g) => SLOT_EN[g.slot]).join(', ');
  const upper = garments.filter((g) => isUpperSlot(g.slot));
  // Without the measured colours a second generation drifts (a cream tee came back beige).
  const colours = garments.filter((g) => g.colorHex).map((g) => `${SLOT_EN[g.slot]} ${g.colorHex}`);
  return [
    'Image 1 shows a person from behind in plain base clothes, in a studio. Image 2 shows the same person from the front, wearing an outfit',
    `(${list}).`,
    'Show the person from behind exactly as in image 1 (same pose, framing, background and lighting), now wearing every garment of the outfit in image 2, shoes included, as that outfit really looks from behind. Shoes replace bare feet.',
    upper.length > 2 ? `The upper body is layered (${upper.map((g) => SLOT_EN[g.slot]).join(' under ')}); from behind mostly the outermost layer shows, with inner layers only at the hem, collar or sleeves as in image 2.` : null,
    'Repeating all-over patterns continue across the back. Anything placed on the front of a garment (a chest print, logo, heart, emblem, text, buttons, front pockets) cannot be seen from behind and must not appear on the back.',
    colours.length ? `Each garment keeps exactly its colour from image 2: ${colours.join(', ')}; do not darken, warm or tint them.` : null,
    "Keep each garment's colour, fabric, length and fit. Do not add any garment that is not in image 2. Photorealistic.",
    notes(hint),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Makeup as an edit of a picture that is already right (the dressed front view, or the avatar): only the face
 * changes. The engine then has a vision model check that it is still the same person.
 */
export function makeupPrompt(makeup: string, withOriginal: boolean, hint?: string | null): string {
  return [
    `Apply makeup to the person in image 1: ${makeup}.`,
    'Change only the makeup on the face: skin finish, brows, eyes, lashes, cheeks and lips.',
    'Keep everything else exactly as in image 1: the face shape, the features and their proportions, the expression, the skin tone underneath, the hair, the body, every garment and accessory, the pose, framing, background and lighting.',
    withOriginal ? 'Image 2 shows the same person without makeup, only so the face stays recognisably theirs.' : null,
    'Photorealistic makeup that suits the lighting of image 1.',
    notes(hint),
  ]
    .filter(Boolean)
    .join(' ');
}

export const FACE_SYSTEM = '你检查两张照片里是不是同一个人。只看长相，不看妆容、衣服和背景。';

export const FACE_TEXT =
  '图 1 是这个人原本的样子（没化妆）。图 2 是给这个人化妆后的照片。除了妆容本身（粉底、眉毛、眼影、睫毛、腮红、口红），脸型、五官和它们的比例、肤色、发型、年龄感还是不是同一个人？一眼看上去像换了一个人就算不是。';

export const FACE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['samePerson', 'note'],
  properties: {
    samePerson: { type: 'boolean' },
    note: { type: 'string', description: '不是同一个人时，哪里不一样（简短）' },
  },
} as const;

export interface FaceResult {
  samePerson: boolean;
  note: string;
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
/** `dressed`: image 1 is the front try-on, already wearing the outfit, so only the scene changes (fewer wrong garments). */
export function photoPrompt(garments: Worn[], scene: Scene, makeup?: string | null, opts: { dressed?: boolean; fix?: string | null } = {}): string {
  const list = garments.map((g, i) => `image ${i + 2}: ${SLOT_EN[g.slot]} (${SLOT_LABEL[g.slot]})`).join('; ');
  return [
    opts.dressed
      ? `Image 1 shows this exact person already wearing the outfit. The other images show each garment on its own, for reference: ${list}.`
      : `Image 1 is a person in plain base clothes. The other images are the garments to put on: ${list}.`,
    opts.dressed
      ? `Create a realistic, high-quality full-body fashion photo of this exact person ${scene.prompt}, wearing exactly what they wear in image 1: the same garments, colours, lengths, layering and fit.`
      : `Create a realistic, high-quality full-body fashion photo of this exact person ${scene.prompt}, wearing exactly these garments.`,
    opts.dressed ? null : 'The garments replace the matching base clothes; for any category without an image, keep what the person wears in image 1. Shoes replace bare feet.',
    ...(opts.dressed ? [] : layering(garments)),
    accessories(garments),
    'Do not add any garment, layer, jacket, overshirt, cardigan or accessory that is not shown in the images.',
    'Keep each garment exactly as shown: colour, pattern, logos and prints (same position and size), buttons, pockets, length and fit.',
    'Keep the face, hair and body shape exactly the same. Natural relaxed pose, full body visible from head to shoes.',
    makeup ? `The person wears ${makeup}; only the makeup differs from image 1, the face itself stays the same.` : null,
    fixLine(opts.fix),
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------- outfit check ----------

export const OUTFIT_SYSTEM = '你检查一张 AI 生成的穿搭照片有没有画错。用简体中文，简短。';

export function outfitText(garments: { slot: Slot; name: string; color: string | null }[]): string {
  return [
    `第 1 张是生成的照片，后面 ${garments.length} 张依次是应该穿在身上的单品图：`,
    ...garments.map((g, i) => `${i + 2}. ${SLOT_LABEL[g.slot]} · ${g.name}${g.color ? ` · ${g.color}` : ''}`),
    'fullBody：照片里的人从头顶到鞋是否完整，没有被裁掉。',
    'problems：每件单品和单品图对不上的地方（没穿上、多了别的衣服、颜色不同、长裤变短裤这类长度或版型变化、印花文字不同），每条不超过 15 个字；都对就返回空数组。褶皱、光线、姿势的差别不算。',
  ].join('\n');
}

export const OUTFIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fullBody', 'problems'],
  properties: { fullBody: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } },
} as const;

export interface OutfitResult {
  fullBody: boolean;
  problems: string[];
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
