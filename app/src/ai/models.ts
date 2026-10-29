import type { ChatUsage, ImageUsage } from './client';

/** Cheapest first. A model listed by /v1/models can still be deprecated; it is then blocked and the next one used. */
export const IMAGE_MODELS = ['gpt-image-1-mini', 'gpt-image-1', 'gpt-image-1.5', 'gpt-image-2'];
export const VISION_MODELS = ['gpt-5.4-nano', 'gpt-5-nano', 'gpt-4o-mini', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o'];

export interface ModelChoice {
  image: string | null;
  vision: string | null;
  /** Models that failed with "not found / deprecated"; skipped on later picks. */
  blocked: string[];
  probedAt: string | null;
}

export const EMPTY_CHOICE: ModelChoice = { image: null, vision: null, blocked: [], probedAt: null };

export function pickModels(available: string[], blocked: string[] = []): Pick<ModelChoice, 'image' | 'vision'> {
  const have = new Set(available);
  const ok = (m: string) => have.has(m) && !blocked.includes(m);
  return { image: IMAGE_MODELS.find(ok) ?? null, vision: VISION_MODELS.find(ok) ?? null };
}

/** Block a model and move to the next preferred one of the same kind. */
export function blockModel(choice: ModelChoice, model: string, available: string[]): ModelChoice {
  const blocked = choice.blocked.includes(model) ? choice.blocked : [...choice.blocked, model];
  return { ...choice, ...pickModels(available.length ? available : [...IMAGE_MODELS, ...VISION_MODELS], blocked), blocked };
}

// ---- pricing (USD per 1M tokens; estimates for display and the monthly cap) ----

interface ImagePrice {
  textIn: number;
  imageIn: number;
  out: number;
}
interface ChatPrice {
  in: number;
  out: number;
}

const IMAGE_PRICES: Record<string, ImagePrice> = {
  'gpt-image-1-mini': { textIn: 2, imageIn: 2.5, out: 8 },
  'gpt-image-1': { textIn: 5, imageIn: 10, out: 40 },
  'gpt-image-1.5': { textIn: 5, imageIn: 8, out: 32 },
  'gpt-image-2': { textIn: 5, imageIn: 8, out: 32 },
};

const CHAT_PRICES: Record<string, ChatPrice> = {
  'gpt-5.4-nano': { in: 0.2, out: 1.25 },
  'gpt-5-nano': { in: 0.05, out: 0.4 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-5.4-mini': { in: 0.75, out: 4.5 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4o': { in: 2.5, out: 10 },
};

const M = 1_000_000;

export function imageCost(model: string, u: ImageUsage): number {
  const p = IMAGE_PRICES[model] ?? IMAGE_PRICES['gpt-image-1'];
  return (u.textIn * p.textIn + u.imageIn * p.imageIn + u.out * p.out) / M;
}

export function chatCost(model: string, u: ChatUsage): number {
  const p = CHAT_PRICES[model] ?? { in: 2.5, out: 10 };
  return (u.in * p.in + u.out * p.out) / M;
}

/**
 * Rough pre-flight estimate shown before the user starts a paid action.
 * Output tokens for a 1024x1536 image: low ≈ 400, medium ≈ 1600, high ≈ 6200.
 */
export function estimateImageCost(model: string | null, opts: { inputImages: number; quality: 'low' | 'medium' | 'high'; n?: number }): number {
  const out = { low: 410, medium: 1590, high: 6210 }[opts.quality] * (opts.n ?? 1);
  return imageCost(model ?? 'gpt-image-1-mini', { textIn: 300, imageIn: 400 * opts.inputImages, out });
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}
