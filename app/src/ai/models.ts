/** OpenAI models, cheapest first (prices and the 自动 order are in catalog.ts). */
export const IMAGE_MODELS = ['gpt-image-1-mini', 'gpt-image-1', 'gpt-image-1.5', 'gpt-image-2'];
export const VISION_MODELS = ['gpt-5.4-nano', 'gpt-5-nano', 'gpt-4o-mini', 'gpt-5.4-mini', 'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4o'];

/** How 0.5.x stored its single key's probed models ('ai.models'); read only to migrate them. */
export interface ModelChoice {
  image: string | null;
  vision: string | null;
  blocked: string[];
  probedAt: string | null;
}

export const EMPTY_CHOICE: ModelChoice = { image: null, vision: null, blocked: [], probedAt: null };

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** Sum of estimates; unknown if any part is. */
export function addCosts(...xs: (number | null)[]): number | null {
  return xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0);
}

/** Button text for a cost estimate; null means the model's price is not known. */
export function formatEstimate(usd: number | null): string {
  return usd === null ? '价格未知' : `约 ${formatUsd(usd)}`;
}
