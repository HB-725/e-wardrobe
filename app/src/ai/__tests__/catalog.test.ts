import { AUTO_ROUTES, callCost, estimateCost, type KeyEntry, modelInfo, modelKind, modelsFor, resolveRoute, type Routes } from '../catalog';
import { chatCost, estimateImageCost, imageCost } from '../models';

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

describe('costs', () => {
  it('matches the existing OpenAI pricing', () => {
    const u = { textIn: 300, imageIn: 800, out: 1590 };
    expect(callCost('openai', 'gpt-image-1-mini', u)).toBeCloseTo(imageCost('gpt-image-1-mini', u), 10);
    expect(callCost('openai', 'gpt-5.4-nano', { in: 1000, out: 200 })).toBeCloseTo(chatCost('gpt-5.4-nano', { in: 1000, out: 200 }), 10);
    expect(estimateCost('openai', 'gpt-image-1-mini', { inputImages: 3, quality: 'medium', n: 2 })).toBeCloseTo(estimateImageCost('gpt-image-1-mini', { inputImages: 3, quality: 'medium', n: 2 }), 10);
  });

  it('prices Gemini images by output tokens and reports unknown prices as null', () => {
    // 1290 output tokens at $30/M ≈ $0.039 per image, plus a little input.
    expect(estimateCost('gemini', 'gemini-2.5-flash-image', { inputImages: 1, quality: 'high' })).toBeCloseTo((560 * 0.3 + 1290 * 30) / 1e6, 10);
    expect(estimateCost('gemini', 'gemini-3.1-flash-image-preview', { inputImages: 1, quality: 'low' })).toBeNull();
    expect(callCost('gemini', 'gemini-9-pro', { in: 1, out: 1 })).toBeNull();
  });
});
