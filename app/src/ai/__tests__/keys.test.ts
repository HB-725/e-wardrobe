import type { Db } from '@/db/db';
import { setSetting } from '@/db/misc';
import { createTestDb } from '@/test/memoryDb';
import { resolveRoute } from '../catalog';
import { saveModelChoice } from '../config';
import {
  addKey,
  blockModelForKey,
  getKeySecret,
  getRoutes,
  hasConsentFor,
  LEGACY_KEY,
  listKeys,
  markVerified,
  migrateLegacyKey,
  removeKey,
  saveRoutes,
  type SecretStore,
  setConsentFor,
} from '../keys';

function memorySecrets(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const store: SecretStore & { map: Map<string, string> } = {
    map,
    async get(name) {
      return map.get(name) ?? null;
    },
    async set(name, value) {
      if (value) map.set(name, value);
      else map.delete(name);
    },
  };
  return store;
}

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe('API keys', () => {
  it('keeps the secret in secure storage only and labels repeat providers', async () => {
    const secrets = memorySecrets();
    const a = await addKey(db, secrets, 'gemini', '  AIzaSyABCDwxyz  ');
    const b = await addKey(db, secrets, 'gemini', 'AIzaSyOTHER1234');
    expect(a).toMatchObject({ provider: 'gemini', label: 'Google Gemini', last4: 'wxyz', verifiedAt: null, models: [] });
    expect(b.label).toBe('Google Gemini 2');
    expect(await getKeySecret(secrets, a.id)).toBe('AIzaSyABCDwxyz');
    const stored = await db.getAllAsync<{ value: string }>('SELECT value FROM settings');
    expect(JSON.stringify(stored)).not.toContain('AIzaSy');
  });

  it('verification records the models and clears blocked ones', async () => {
    const secrets = memorySecrets();
    const k = await addKey(db, secrets, 'openai', 'sk-test-0001');
    await blockModelForKey(db, k.id, 'gpt-image-1-mini');
    expect((await listKeys(db))[0].blocked).toEqual(['gpt-image-1-mini']);
    await markVerified(db, k.id, ['gpt-image-1-mini', 'gpt-5.4-nano'], '2026-10-30T01:00:00Z');
    expect((await listKeys(db))[0]).toMatchObject({ verifiedAt: '2026-10-30T01:00:00Z', models: ['gpt-image-1-mini', 'gpt-5.4-nano'], blocked: [] });
  });

  it('removing a key deletes its secret and sends purposes that used it back to 自动', async () => {
    const secrets = memorySecrets();
    const o = await addKey(db, secrets, 'openai', 'sk-test-0001');
    const g = await addKey(db, secrets, 'gemini', 'AIza-0002');
    await saveRoutes(db, { ...(await getRoutes(db)), catalog: { keyId: g.id, model: 'gemini-2.5-flash-image' }, tryon: { keyId: o.id, model: 'gpt-image-1' } });
    await removeKey(db, secrets, g.id);
    expect((await listKeys(db)).map((k) => k.id)).toEqual([o.id]);
    expect(await getKeySecret(secrets, g.id)).toBeNull();
    const routes = await getRoutes(db);
    expect(routes.catalog).toBe('auto');
    expect(routes.tryon).toEqual({ keyId: o.id, model: 'gpt-image-1' });
  });

  it('records consent per provider', async () => {
    await setConsentFor(db, 'openai');
    expect(await hasConsentFor(db, 'openai')).toBe(true);
    expect(await hasConsentFor(db, 'gemini')).toBe(false);
  });
});

describe('moving the single 0.5.x key', () => {
  it('moves the key, its models and the photo consent, then removes the old secret', async () => {
    const secrets = memorySecrets({ [LEGACY_KEY]: 'sk-legacy-8F2A' });
    await saveModelChoice(db, { image: 'gpt-image-1-mini', vision: 'gpt-5.4-nano', blocked: ['gpt-4.1-nano'], probedAt: '2026-10-28T00:00:00Z' });
    await setSetting(db, 'privacy.photoConsent', '1');
    await migrateLegacyKey(db, secrets);
    const [k] = await listKeys(db);
    expect(k).toMatchObject({ provider: 'openai', label: 'OpenAI', last4: '8F2A', verifiedAt: '2026-10-28T00:00:00Z', models: ['gpt-image-1-mini', 'gpt-5.4-nano'], blocked: ['gpt-4.1-nano'] });
    expect(await getKeySecret(secrets, k.id)).toBe('sk-legacy-8F2A');
    expect(secrets.map.has(LEGACY_KEY)).toBe(false);
    expect(await hasConsentFor(db, 'openai')).toBe(true);
    // Same models as before the move: 自动 picks what 0.5.x used.
    expect(resolveRoute('catalog', await getRoutes(db), [k])).toMatchObject({ model: 'gpt-image-1-mini' });
    expect(resolveRoute('vision', await getRoutes(db), [k])).toMatchObject({ model: 'gpt-5.4-nano' });
  });

  it('runs once, and resumes an interrupted run without a second copy of the key', async () => {
    const secrets = memorySecrets({ [LEGACY_KEY]: 'sk-legacy-8F2A' });
    // Interrupted after copying the key but before finishing.
    const partial = await addKey(db, secrets, 'openai', 'sk-legacy-8F2A');
    await migrateLegacyKey(db, secrets);
    expect((await listKeys(db)).map((k) => k.id)).toEqual([partial.id]);
    expect(secrets.map.has(LEGACY_KEY)).toBe(false);
    // A later start does nothing, even if something wrote the old name again.
    secrets.map.set(LEGACY_KEY, 'sk-other');
    await migrateLegacyKey(db, secrets);
    expect(await listKeys(db)).toHaveLength(1);
  });

  it('a fresh install has nothing to move', async () => {
    const secrets = memorySecrets();
    await migrateLegacyKey(db, secrets);
    expect(await listKeys(db)).toEqual([]);
    expect(await hasConsentFor(db, 'openai')).toBe(false);
  });
});
