import type { TokenUsage } from './openai';

/** Cheapest first. The first one the account can use wins. */
export const IMAGE_MODEL_PREFERENCE = ['gpt-image-1-mini', 'gpt-image-1', 'gpt-image-1.5'];
export const VISION_MODEL_PREFERENCE = ['gpt-4.1-mini', 'gpt-5-mini', 'gpt-4o-mini', 'gpt-5-nano', 'gpt-4.1-nano', 'gpt-4o'];

export interface ModelChoice {
  image: string;
  vision: string;
}

export const DEFAULT_MODELS: ModelChoice = { image: IMAGE_MODEL_PREFERENCE[0], vision: VISION_MODEL_PREFERENCE[0] };

export function pickModels(available: string[]): ModelChoice {
  const set = new Set(available);
  const pick = (prefs: string[]) => prefs.find((m) => set.has(m)) ?? null;
  const image = pick(IMAGE_MODEL_PREFERENCE);
  const vision = pick(VISION_MODEL_PREFERENCE);
  if (!image) throw new Error('这个 API Key 无法使用任何图像生成模型（需要 gpt-image 系列）');
  if (!vision) throw new Error('这个 API Key 无法使用任何识图模型');
  return { image, vision };
}

/** USD per 1M tokens: [input, output]. Image models: [text input, image output] plus image-input rate below. */
const TOKEN_PRICES: Record<string, { input: number; output: number; imageInput?: number }> = {
  'gpt-image-1-mini': { input: 2, output: 8, imageInput: 2.5 },
  'gpt-image-1': { input: 5, output: 40, imageInput: 10 },
  'gpt-image-1.5': { input: 5, output: 32, imageInput: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
};

/** Estimated cost of one call from reported token usage. Unknown models fall back to a conservative rate. */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const p = TOKEN_PRICES[model] ?? { input: 5, output: 40, imageInput: 10 };
  const cost =
    (usage.inputTokens * p.input + usage.outputTokens * p.output + (usage.imageInputTokens ?? 0) * (p.imageInput ?? p.input)) /
    1_000_000;
  return Math.round(cost * 10000) / 10000;
}

/** Rough per-action estimates shown to the user before spending, in USD. */
export const ACTION_ESTIMATE_USD = {
  catalog: 0.02,
  autofill: 0.002,
  avatar: 0.03,
  tryon: 0.03,
  mirror: 0.003,
};

export function supportsInputFidelity(imageModel: string): boolean {
  return imageModel === 'gpt-image-1' || imageModel === 'gpt-image-1.5';
}
