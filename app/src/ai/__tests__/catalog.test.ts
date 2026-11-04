import { AUTO_ROUTES, callCost, estimateCost, estimateFor, type KeyEntry, modelInfo, modelKind, modelsFor, resolveRoute, type Routes, usableModels } from '../catalog';
import { addCosts, formatEstimate } from '../models';

const key = (id: string, provider: KeyEntry['provider'], models: string[], extra: Partial<KeyEntry> = {}): KeyEntry => ({
  id,
  provider,
  label: provider,
  last4: '1234',
  addedAt: '2026-10-30T00:00:00Z',
  verifiedAt: '2026-10-30T00:00:00Z',
  models,
  blocked: [],
  ...extra,
});

const openai = key('k1', 'openai', ['gpt-image-1-mini', 'gpt-image-1', 'gpt-5.4-nano', 'gpt-4o-mini', 'whisper-1']);
const gemini = key('k2', 'gemini', ['gemini-2.5-flash-image', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'text-embedding-004', 'gemini-3.1-flash-image-preview']);

describe('model catalog', () => {
  it('sorts provider models into image and vision, including newer Gemini image models', () => {
    expect(modelKind('gemini', 'gemini-3.1-flash-image-preview')).toBe('image');
    expect(modelKind('gemini', 'gemini-2.5-flash-preview-tts')).toBeNull();
    expect(modelKind('gemini', 'text-embedding-004')).toBeNull();
    expect(modelKind('gemini', 'gemini-2.5-pro')).toBe('vision');
    expect(modelKind('openai', 'gpt-image-9')).toBe('image');
    expect(modelKind('openai', 'whisper-1')).toBeNull();
    expect(modelInfo('gemini', 'gemini-3.1-flash-image-preview')).toMatchObject({ kind: 'image', price: null, quality: false });
    expect(modelInfo('openai', 'gpt-image-1-mini')).toMatchObject({ quality: true });
  });

  it('lists a key\'s models for one use, recommended first, without blocked ones', () => {
    expect(modelsFor(gemini, 'image').map((m) => m.id)).toEqual(['gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview']);
    expect(modelsFor({ ...openai, blocked: ['gpt-image-1-mini'] }, 'image').map((m) => m.id)).toEqual(['gpt-image-1']);
    expect(modelsFor(openai, 'vision').map((m) => m.id)).toEqual(['gpt-5.4-nano', 'gpt-4o-mini']);
  });
});

describe('resolveRoute', () => {
  it('auto keeps today\'s behaviour for an OpenAI-only user', () => {
    expect(resolveRoute('catalog', AUTO_ROUTES, [openai])).toEqual({ keyId: 'k1', provider: 'openai', model: 'gpt-image-1-mini', fellBack: false });
    expect(resolveRoute('vision', AUTO_ROUTES, [openai])).toMatchObject({ model: 'gpt-5.4-nano' });
  });

  it('auto uses Gemini when it is the only key, and nothing without a verified key', () => {
    expect(resolveRoute('tryon', AUTO_ROUTES, [gemini])).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash-image' });
    expect(resolveRoute('vision', AUTO_ROUTES, [gemini])).toMatchObject({ model: 'gemini-2.5-flash-lite' });
    expect(resolveRoute('catalog', AUTO_ROUTES, [{ ...openai, verifiedAt: null }])).toBeNull();
    expect(resolveRoute('catalog', AUTO_ROUTES, [])).toBeNull();
  });

  it('honours a mixed choice per purpose', () => {
    const routes: Routes = { ...AUTO_ROUTES, catalog: { keyId: 'k2', model: 'gemini-2.5-flash-image' } };
    expect(resolveRoute('catalog', routes, [openai, gemini])).toEqual({ keyId: 'k2', provider: 'gemini', model: 'gemini-2.5-flash-image', fellBack: false });
    expect(resolveRoute('tryon', routes, [openai, gemini])).toMatchObject({ provider: 'openai', model: 'gpt-image-1-mini' });
  });

  it('falls back to auto (and says so) when the chosen key or model is gone', () => {
    const routes: Routes = { ...AUTO_ROUTES, tryon: { keyId: 'k2', model: 'gemini-2.5-flash-image' } };
    expect(resolveRoute('tryon', routes, [openai])).toEqual({ keyId: 'k1', provider: 'openai', model: 'gpt-image-1-mini', fellBack: true });
    expect(resolveRoute('tryon', routes, [openai, { ...gemini, blocked: ['gemini-2.5-flash-image'] }])).toMatchObject({ provider: 'openai', fellBack: true });
    // A vision model chosen for an image purpose is never used.
    expect(resolveRoute('photo', { ...AUTO_ROUTES, photo: { keyId: 'k1', model: 'gpt-5.4-nano' } }, [openai])).toMatchObject({ model: 'gpt-image-1-mini', fellBack: true });
  });

  it('uses any model of the right kind when none of the recommended ones is offered', () => {
    const newer = key('k3', 'gemini', ['gemini-3.1-flash-image-preview']);
    expect(resolveRoute('avatar', AUTO_ROUTES, [newer])).toMatchObject({ model: 'gemini-3.1-flash-image-preview' });
  });
});

describe('catalog images', () => {
  // On 9 real garment photos (2026-11-05, 9 models) gpt-image-1-mini lost fading, washes, logos and colours at any
  // quality. Gemini 3.1 Flash-Lite Image kept them with a clean background at $0.034 a picture; gpt-image-2 and
  // gpt-image-1.5 (low) kept them too; Gemini 2.5 did but with uneven backgrounds. Try-ons keep the cheaper order.
  it('prefers Gemini 3.1 Flash-Lite, then gpt-image-2 / 1.5, over mini for catalog images only', () => {
    const k = key('k6', 'openai', ['gpt-image-1-mini', 'gpt-image-1.5', 'gpt-5.4-nano']);
    expect(resolveRoute('catalog', AUTO_ROUTES, [k])).toMatchObject({ model: 'gpt-image-1.5' });
    expect(resolveRoute('tryon', AUTO_ROUTES, [k])).toMatchObject({ model: 'gpt-image-1-mini' });
    const g3 = key('k7', 'gemini', ['gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image']);
    expect(resolveRoute('catalog', AUTO_ROUTES, [k, g3])).toMatchObject({ model: 'gemini-3.1-flash-lite-image' });
    const o2 = key('k8', 'openai', ['gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2']);
    expect(resolveRoute('catalog', AUTO_ROUTES, [o2])).toMatchObject({ model: 'gpt-image-2' });
    expect(resolveRoute('catalog', AUTO_ROUTES, [openai, gemini])).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash-image' });
    expect(resolveRoute('catalog', AUTO_ROUTES, [openai])).toMatchObject({ model: 'gpt-image-1-mini' });
  });
});

describe('Gemini 3', () => {
  // Google stopped serving the 2.5 models to new keys (404 "no longer available to new users") in late 2026.
  const g3 = key('k4', 'gemini', ['gemini-2.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash']);

  it('recognises with the 3.x lite models first (no thinking by default), the 2.5 ones only as a fallback', () => {
    expect(modelsFor(g3, 'vision').map((m) => m.id)).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-flash']);
    expect(resolveRoute('vision', AUTO_ROUTES, [g3])).toMatchObject({ model: 'gemini-3.1-flash-lite' });
    expect(resolveRoute('vision', AUTO_ROUTES, [{ ...g3, blocked: ['gemini-3.1-flash-lite'] }])).toMatchObject({ model: 'gemini-3.5-flash-lite' });
  });

  it('draws with 2.5 Flash Image first, then the 3.1 image models', () => {
    const k = key('k5', 'gemini', ['gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-2.5-flash-image', 'gemini-3-pro-image']);
    expect(modelsFor(k, 'image').map((m) => m.id)).toEqual(['gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image', 'gemini-3-pro-image']);
  });

  it('prices the 3.x models (aistudio.google.com/docs/pricing, 2026-11)', () => {
    expect(callCost('gemini', 'gemini-3.1-flash-lite', { in: 1000, out: 200 })).toBeCloseTo(0.00055, 10);
    expect(callCost('gemini', 'gemini-3.5-flash-lite', { in: 1000, out: 200 })).toBeCloseTo(0.0008, 10);
    expect(callCost('gemini', 'gemini-3-flash-preview', { in: 5637, out: 1047 })).toBeCloseTo(0.0059595, 10);
    // $0.0336 per 1K image = 1120 output tokens.
    expect(callCost('gemini', 'gemini-3.1-flash-lite-image', { textIn: 500, imageIn: 0, out: 1120 })).toBeCloseTo(0.033725, 10);
    expect(callCost('gemini', 'gemini-3.1-flash-image', { textIn: 0, imageIn: 0, out: 1120 })).toBeCloseTo(0.0672, 10);
    expect(callCost('gemini', 'gemini-3-pro-image', { textIn: 0, imageIn: 0, out: 1120 })).toBeCloseTo(0.1344, 10);
  });
});

describe('costs', () => {
  it('keeps the OpenAI pricing of 0.5.x', () => {
    expect(callCost('openai', 'gpt-image-1-mini', { textIn: 32, imageIn: 256, out: 408 })).toBeCloseTo(0.00397, 4);
    expect(callCost('openai', 'gpt-image-1-mini', { textIn: 300, imageIn: 800, out: 1590 })).toBeCloseTo(0.01532, 10);
    expect(callCost('openai', 'gpt-5.4-nano', { in: 1000, out: 200 })).toBeCloseTo(0.00045, 10);
    expect(estimateCost('openai', 'gpt-image-1-mini', { inputImages: 3, quality: 'medium', n: 2 })).toBeCloseTo(0.02904, 10);
  });

  it('estimates with the model a purpose would use, and says so when the price is unknown', () => {
    const opts = { inputImages: 2, quality: 'low' as const };
    expect(estimateFor({ keys: [], routes: AUTO_ROUTES }, 'tryon', opts)).toBe(estimateCost('openai', 'gpt-image-1-mini', opts));
    expect(estimateFor({ keys: [gemini], routes: AUTO_ROUTES }, 'tryon', opts)).toBe(estimateCost('gemini', 'gemini-2.5-flash-image', opts));
    const preview: Routes = { ...AUTO_ROUTES, tryon: { keyId: 'k2', model: 'gemini-3.1-flash-image-preview' } };
    expect(formatEstimate(addCosts(0.01, estimateFor({ keys: [gemini], routes: preview }, 'tryon', opts)))).toBe('价格未知');
    expect(formatEstimate(addCosts(0.01, 0.02))).toBe('约 $0.03');
    expect(usableModels('openai', openai.models)).not.toContain('whisper-1');
  });

  it('prices Gemini images by output tokens and reports unknown prices as null', () => {
    // 1290 output tokens at $30/M ≈ $0.039 per image, plus a little input.
    expect(estimateCost('gemini', 'gemini-2.5-flash-image', { inputImages: 1, quality: 'high' })).toBeCloseTo((560 * 0.3 + 1290 * 30) / 1e6, 10);
    expect(estimateCost('gemini', 'gemini-3.1-flash-image-preview', { inputImages: 1, quality: 'low' })).toBeNull();
    expect(callCost('gemini', 'gemini-9-pro', { in: 1, out: 1 })).toBeNull();
  });
});
