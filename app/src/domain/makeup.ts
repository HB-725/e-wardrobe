/**
 * Makeup on the avatar: a preset id, or `custom:` followed by the user's own words. It is drawn as a second edit
 * of the dressed front view (see engine), so the outfit underneath stays the same picture.
 */
export interface MakeupPreset {
  id: string;
  label: string;
  /** For the image prompt. */
  en: string;
  /** Shown on the choice, roughly the lip / eye colour. */
  swatch: string;
}

export const MAKEUPS: MakeupPreset[] = [
  { id: 'natural', label: '自然淡妆', en: 'a natural, barely-there everyday makeup: even skin, soft brown brows, light mascara, sheer nude-pink lips', swatch: '#E3AE9C' },
  { id: 'office', label: '通勤妆', en: 'polished office makeup: matte even skin, defined brows, soft taupe eyeshadow, thin eyeliner, rosy-nude lipstick', swatch: '#C4877A' },
  { id: 'date', label: '约会妆', en: 'soft romantic makeup: dewy skin, peach blush, shimmering champagne eyeshadow, glossy rose-pink lips', swatch: '#E2919F' },
  { id: 'redlip', label: '复古红唇', en: 'classic retro makeup: matte skin, winged black eyeliner, a bold classic red lipstick', swatch: '#B3242E' },
  { id: 'smoky', label: '烟熏妆', en: 'evening smoky-eye makeup: blended dark grey-brown eyeshadow, black eyeliner, nude lips', swatch: '#4A4048' },
  { id: 'party', label: '派对妆', en: 'glamorous party makeup: luminous skin, glittery eyeshadow, full lashes, highlighted cheekbones, berry lipstick', swatch: '#8E3A6B' },
];

const CUSTOM = 'custom:';

export const customMakeup = (words: string) => `${CUSTOM}${words.trim()}`;

export const isCustomMakeup = (m: string) => m.startsWith(CUSTOM);

const preset = (m: string) => MAKEUPS.find((p) => p.id === m);

export function makeupLabel(m: string): string {
  return preset(m)?.label ?? m.slice(CUSTOM.length);
}

export function makeupPromptText(m: string): string {
  const p = preset(m);
  return p ? p.en : `this makeup, as the user described it (their words, possibly Chinese): "${m.slice(CUSTOM.length)}"`;
}

/** Short and free of the try-on key's separators (`~ | + >`): a preset id, or a hash of the user's words. */
export function makeupKey(m: string): string {
  if (preset(m)) return m;
  let h = 5381;
  for (const ch of m) h = (Math.imul(h, 33) ^ ch.codePointAt(0)!) >>> 0;
  return `c${h.toString(36)}`;
}
