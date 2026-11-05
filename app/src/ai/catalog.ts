import type { ChatUsage, ImageUsage } from './client';
import { IMAGE_MODELS, VISION_MODELS } from './models';

/**
 * Which model does what, at what price, and which one each purpose uses (docs/design/multi-provider.md).
 * Pure functions only; settings storage and the screens build on this.
 */

export type ProviderId = 'openai' | 'gemini';
export type Purpose = 'catalog' | 'avatar' | 'tryon' | 'photo' | 'vision' | 'analysis';
export type Route = 'auto' | { keyId: string; model: string };
export type Routes = Record<Purpose, Route>;

export const PURPOSES: { id: Purpose; label: string; kind: 'image' | 'vision' }[] = [
  { id: 'catalog', label: '商品图', kind: 'image' },
  { id: 'avatar', label: '个人形象', kind: 'image' },
  { id: 'tryon', label: '上身效果', kind: 'image' },
  { id: 'photo', label: '真人大片', kind: 'image' },
  { id: 'vision', label: '识别', kind: 'vision' },
  { id: 'analysis', label: '分析衣服', kind: 'vision' },
];

export const AUTO_ROUTES: Routes = { catalog: 'auto', avatar: 'auto', tryon: 'auto', photo: 'auto', vision: 'auto', analysis: 'auto' };

export interface KeyEntry {
  id: string;
  provider: ProviderId;
  label: string;
  last4: string;
  addedAt: string;
  verifiedAt: string | null;
  /** Models this key can use, from the provider's model list at verification. */
  models: string[];
  /** Models that failed in use (removed, no access); skipped until the key is verified again. */
  blocked: string[];
}

/** USD per 1M tokens. Images are billed as tokens by both providers. */
export interface TokenPrice {
  in: number;
  /** Image input, where it differs from text input. */
  imageIn?: number;
  out: number;
}

export interface ModelInfo {
  provider: ProviderId;
  id: string;
  kind: 'image' | 'vision';
  label: string;
  /** null: not in the price table (newer or unusual model); its spend is not counted against the cap. */
  price: TokenPrice | null;
  /** Accepts low / medium / high quality. */
  quality: boolean;
}

// Published list prices (USD per 1M tokens). Keep in step with openai.com/api/pricing and ai.google.dev/pricing.
const KNOWN: ModelInfo[] = [
  { provider: 'openai', id: 'gpt-image-1-mini', kind: 'image', label: 'GPT Image mini', price: { in: 2, imageIn: 2.5, out: 8 }, quality: true },
  { provider: 'openai', id: 'gpt-image-1', kind: 'image', label: 'GPT Image 1', price: { in: 5, imageIn: 10, out: 40 }, quality: true },
  { provider: 'openai', id: 'gpt-image-1.5', kind: 'image', label: 'GPT Image 1.5', price: { in: 5, imageIn: 8, out: 32 }, quality: true },
  { provider: 'openai', id: 'gpt-image-2', kind: 'image', label: 'GPT Image 2', price: { in: 5, imageIn: 8, out: 32 }, quality: true },
  { provider: 'gemini', id: 'gemini-2.5-flash-image', kind: 'image', label: 'Nano Banana（Gemini 2.5 Flash Image）', price: { in: 0.3, out: 30 }, quality: false },
  // Gemini 3 image prices are per image ($0.0336 / $0.067 / $0.134 at 1K); 1120 output tokens per image.
  { provider: 'gemini', id: 'gemini-3.1-flash-lite-image', kind: 'image', label: 'Gemini 3.1 Flash-Lite Image', price: { in: 0.25, out: 30 }, quality: false },
  { provider: 'gemini', id: 'gemini-3.1-flash-image', kind: 'image', label: 'Gemini 3.1 Flash Image', price: { in: 0.5, out: 60 }, quality: false },
  { provider: 'gemini', id: 'gemini-3-pro-image', kind: 'image', label: 'Gemini 3 Pro Image', price: { in: 2, out: 120 }, quality: false },
  { provider: 'openai', id: 'gpt-5.4-nano', kind: 'vision', label: 'GPT-5.4 nano', price: { in: 0.2, out: 1.25 }, quality: false },
  { provider: 'openai', id: 'gpt-5-nano', kind: 'vision', label: 'GPT-5 nano', price: { in: 0.05, out: 0.4 }, quality: false },
  { provider: 'openai', id: 'gpt-4o-mini', kind: 'vision', label: 'GPT-4o mini', price: { in: 0.15, out: 0.6 }, quality: false },
  { provider: 'openai', id: 'gpt-5.4-mini', kind: 'vision', label: 'GPT-5.4 mini', price: { in: 0.75, out: 4.5 }, quality: false },
  { provider: 'openai', id: 'gpt-5-mini', kind: 'vision', label: 'GPT-5 mini', price: { in: 0.25, out: 2 }, quality: false },
  { provider: 'openai', id: 'gpt-4.1-mini', kind: 'vision', label: 'GPT-4.1 mini', price: { in: 0.4, out: 1.6 }, quality: false },
  { provider: 'openai', id: 'gpt-4o', kind: 'vision', label: 'GPT-4o', price: { in: 2.5, out: 10 }, quality: false },
  { provider: 'gemini', id: 'gemini-2.5-flash-lite', kind: 'vision', label: 'Gemini 2.5 Flash-Lite', price: { in: 0.1, out: 0.4 }, quality: false },
  { provider: 'gemini', id: 'gemini-2.5-flash', kind: 'vision', label: 'Gemini 2.5 Flash', price: { in: 0.3, out: 2.5 }, quality: false },
  // The lite models do not think unless asked, so recognition stays cheap; 3 Flash (preview) thinks by default.
  { provider: 'gemini', id: 'gemini-3.1-flash-lite', kind: 'vision', label: 'Gemini 3.1 Flash-Lite', price: { in: 0.25, out: 1.5 }, quality: false },
  { provider: 'gemini', id: 'gemini-3.5-flash-lite', kind: 'vision', label: 'Gemini 3.5 Flash-Lite', price: { in: 0.3, out: 2.5 }, quality: false },
  { provider: 'gemini', id: 'gemini-3-flash-preview', kind: 'vision', label: 'Gemini 3 Flash（预览）', price: { in: 0.5, out: 3 }, quality: false },
  // $0.75 / $3.75 until 2026-12-31, then $1.50 / $7.50.
  { provider: 'gemini', id: 'gemini-3.6-flash', kind: 'vision', label: 'Gemini 3.6 Flash', price: { in: 0.75, out: 3.75 }, quality: false },
  { provider: 'gemini', id: 'gemini-3.8-flash', kind: 'vision', label: 'Gemini 3.8 Flash', price: { in: 0.75, out: 3.75 }, quality: false },
];

/** "自动" tries these in order among the models the user's keys can use. */
const AUTO_ORDER: Record<'image' | 'vision', [ProviderId, string][]> = {
  image: [
    ['openai', 'gpt-image-1-mini'],
    ['gemini', 'gemini-2.5-flash-image'],
    ['gemini', 'gemini-3.1-flash-lite-image'],
    ['gemini', 'gemini-3.1-flash-image'],
    ['openai', 'gpt-image-1.5'],
    ['openai', 'gpt-image-1'],
    ['openai', 'gpt-image-2'],
    ['gemini', 'gemini-3-pro-image'],
  ],
  vision: [
    ['openai', 'gpt-5.4-nano'],
    // Google serves the 2.5 models to older keys only (new keys get 404 "no longer available to new users").
    ['gemini', 'gemini-3.1-flash-lite'],
    ['gemini', 'gemini-3.5-flash-lite'],
    ['gemini', 'gemini-2.5-flash-lite'],
    ['gemini', 'gemini-3-flash-preview'],
    ['gemini', 'gemini-2.5-flash'],
    ...VISION_MODELS.filter((m) => m !== 'gpt-5.4-nano').map((m): [ProviderId, string] => ['openai', m]),
  ],
};

/**
 * Catalog images must keep the garment's real look (fading, washes, logos, exact colour). On 9 real photos and 9
 * models (2026-11-05): gpt-image-1-mini lost it at any quality, and no prompt got it back; gpt-image-2 (low) and
 * Gemini 3.1 Flash-Lite both kept it, at $0.016 and $0.046 a garment (recognition, one picture, check), so
 * gpt-image-2 goes first; gpt-image-1.5 (low) kept it too; Gemini 3.1 Flash and 3 Pro were no better than Lite for
 * 3–5× the price; Gemini 2.5 kept it but with uneven backgrounds. Try-ons and photos keep the cheaper AUTO_ORDER.
 */
/** Purposes where the garment must come out as it really is; the avatar itself keeps the cheaper order. */
const FAITHFUL = new Set<Purpose>(['catalog', 'tryon', 'photo']);

const CATALOG_ORDER: [ProviderId, string][] = [
  ['openai', 'gpt-image-2'],
  ['gemini', 'gemini-3.1-flash-lite-image'],
  ['openai', 'gpt-image-1.5'],
  ['gemini', 'gemini-3.1-flash-image'],
  ['gemini', 'gemini-2.5-flash-image'],
  ['openai', 'gpt-image-1-mini'],
  ['openai', 'gpt-image-1'],
];

/**
 * The garment analysis before a catalog image describes wear, cut and prints for the image model. gpt-5.4-nano
 * cannot see sun-fade or acid wash (2026-11-05, 2 garments × 9 models); Gemini 3.1 Flash-Lite and gpt-5.4-mini up
 * describe them well, Lite for about the price of nano. Nano only when nothing else is on any key.
 */
const ANALYSIS_ORDER: [ProviderId, string][] = [
  ['gemini', 'gemini-3.1-flash-lite'],
  ['gemini', 'gemini-3.5-flash-lite'],
  ['openai', 'gpt-5.4-mini'],
  ['gemini', 'gemini-3-flash-preview'],
  ['gemini', 'gemini-2.5-flash'],
  ['openai', 'gpt-4o'],
  ['openai', 'gpt-5-mini'],
];

/**
 * What a model from a provider's list can be used for. Gemini names are matched by pattern rather than a fixed list,
 * so newer image models (…-image, …-image-preview) show up without an app update.
 */
export function modelKind(provider: ProviderId, id: string): 'image' | 'vision' | null {
  const known = KNOWN.find((m) => m.provider === provider && m.id === id);
  if (known) return known.kind;
  if (provider === 'openai') return IMAGE_MODELS.includes(id) || /^gpt-image-/.test(id) ? 'image' : VISION_MODELS.includes(id) ? 'vision' : null;
  if (!/^gemini-/.test(id) || /embedding|tts|audio|live|native-audio|aqa/.test(id)) return null;
  return /image/.test(id) ? 'image' : /flash|pro/.test(id) ? 'vision' : null;
}

/** The ids from a provider's model list that this app can use. */
export function usableModels(provider: ProviderId, ids: string[]): string[] {
  return ids.filter((id) => modelKind(provider, id) !== null);
}

export function modelInfo(provider: ProviderId, id: string): ModelInfo | null {
  const known = KNOWN.find((m) => m.provider === provider && m.id === id);
  if (known) return known;
  const kind = modelKind(provider, id);
  // Unknown OpenAI image models still take the quality setting; Gemini ones do not.
  return kind ? { provider, id, kind, label: id, price: null, quality: provider === 'openai' && kind === 'image' } : null;
}

/** The models of one kind a key offers, recommended ones first. */
export function modelsFor(key: KeyEntry, kind: 'image' | 'vision'): ModelInfo[] {
  const order = AUTO_ORDER[kind].filter(([p]) => p === key.provider).map(([, m]) => m);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return key.models
    .filter((m) => !key.blocked.includes(m))
    .map((m) => modelInfo(key.provider, m))
    .filter((m): m is ModelInfo => !!m && m.kind === kind)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

export interface Resolved {
  keyId: string;
  provider: ProviderId;
  model: string;
  /** The user's own choice could not be used (key removed, model gone) and 自动 picked this instead. */
  fellBack: boolean;
}

/** The key and model a purpose uses now, or null when no key can do it. */
export function resolveRoute(purpose: Purpose, routes: Routes, keys: KeyEntry[]): Resolved | null {
  const kind = PURPOSES.find((p) => p.id === purpose)!.kind;
  const usable = (k: KeyEntry, model: string) => k.verifiedAt !== null && k.models.includes(model) && !k.blocked.includes(model) && modelKind(k.provider, model) === kind;
  const chosen = routes[purpose];
  if (chosen !== 'auto') {
    const k = keys.find((x) => x.id === chosen.keyId);
    if (k && usable(k, chosen.model)) return { keyId: k.id, provider: k.provider, model: chosen.model, fellBack: false };
  }
  const pick = (): Omit<Resolved, 'fellBack'> | null => {
    for (const [provider, model] of FAITHFUL.has(purpose) ? CATALOG_ORDER : purpose === 'analysis' ? ANALYSIS_ORDER : AUTO_ORDER[kind]) {
      const k = keys.find((x) => x.provider === provider && usable(x, model));
      if (k) return { keyId: k.id, provider, model };
    }
    // Nothing recommended: any model of the right kind, so a key with only newer models still works.
    for (const k of keys) {
      const m = k.verifiedAt ? modelsFor(k, kind)[0] : undefined;
      if (m) return { keyId: k.id, provider: k.provider, model: m.id };
    }
    return null;
  };
  const auto = pick();
  return auto ? { ...auto, fellBack: chosen !== 'auto' } : null;
}

const M = 1_000_000;

/** Cost of a finished call, or null when the model's price is not known. */
export function callCost(provider: ProviderId, model: string, usage: ImageUsage | ChatUsage): number | null {
  const p = modelInfo(provider, model)?.price;
  if (!p) return null;
  if ('textIn' in usage) return (usage.textIn * p.in + usage.imageIn * (p.imageIn ?? p.in) + usage.out * p.out) / M;
  return (usage.in * p.in + usage.out * p.out) / M;
}

/**
 * Estimate shown on buttons before a paid image request. OpenAI output tokens for a 1024×1536 image: low ≈ 410,
 * medium ≈ 1590, high ≈ 6210; Gemini bills about 1290 output tokens per image and ≈ 260 input tokens per image sent.
 */
export function estimateCost(provider: ProviderId, model: string, opts: { inputImages: number; quality: 'low' | 'medium' | 'high'; n?: number }): number | null {
  const n = opts.n ?? 1;
  if (provider === 'gemini') return callCost(provider, model, { textIn: (300 + 260 * opts.inputImages) * n, imageIn: 0, out: 1290 * n });
  const out = { low: 410, medium: 1590, high: 6210 }[opts.quality] * n;
  return callCost(provider, model, { textIn: 300, imageIn: 400 * opts.inputImages, out });
}

export interface Routing {
  keys: KeyEntry[];
  routes: Routes;
}

/** Estimate for an image purpose with the model it would use now; before any key is added, the default model's. */
export function estimateFor(routing: Routing, purpose: Purpose, opts: { inputImages: number; quality: 'low' | 'medium' | 'high'; n?: number }): number | null {
  const r = resolveRoute(purpose, routing.routes, routing.keys);
  return r ? estimateCost(r.provider, r.model, opts) : estimateCost('openai', (FAITHFUL.has(purpose) ? CATALOG_ORDER.find(([p]) => p === 'openai')! : AUTO_ORDER.image[0])[1], opts);
}
