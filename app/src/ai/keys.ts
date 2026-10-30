import type { Db } from '@/db/db';
import { newId, nowIso, parseJson } from '@/db/db';
import { getSetting, setSetting } from '@/db/misc';
import { AUTO_ROUTES, type KeyEntry, type ProviderId, type Routes } from './catalog';
import { getModelChoice } from './config';

/**
 * API keys from several providers (docs/design/multi-provider.md). The keys themselves live only in the platform's
 * secure storage under `ai.key.<id>`; SQLite keeps their descriptions, never the secret.
 */

export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string | null): Promise<void>;
}

/** Where 0.5.x kept its single OpenAI key. */
export const LEGACY_KEY = 'openai_api_key';
const secretName = (id: string) => `ai.key.${id}`;

const S = {
  keys: 'ai.keys',
  routes: 'ai.routes',
  consent: 'privacy.consent',
  migrated: 'ai.keysMigrated',
  legacyConsent: 'privacy.photoConsent',
} as const;

export const PROVIDER_LABEL: Record<ProviderId, string> = { openai: 'OpenAI', gemini: 'Google Gemini' };

export async function listKeys(db: Db): Promise<KeyEntry[]> {
  return parseJson<KeyEntry[]>(await getSetting(db, S.keys), []);
}

async function saveKeys(db: Db, keys: KeyEntry[]): Promise<void> {
  await setSetting(db, S.keys, JSON.stringify(keys));
}

export async function getRoutes(db: Db): Promise<Routes> {
  return { ...AUTO_ROUTES, ...parseJson<Partial<Routes>>(await getSetting(db, S.routes), {}) };
}

export async function saveRoutes(db: Db, routes: Routes): Promise<void> {
  await setSetting(db, S.routes, JSON.stringify(routes));
}

export async function getKeySecret(secrets: SecretStore, id: string): Promise<string | null> {
  return secrets.get(secretName(id));
}

/** Adds a key (unverified until its model list is read) and returns its description. */
export async function addKey(db: Db, secrets: SecretStore, provider: ProviderId, apiKey: string, label?: string): Promise<KeyEntry> {
  const key = apiKey.trim();
  const keys = await listKeys(db);
  const sameProvider = keys.filter((k) => k.provider === provider).length;
  const entry: KeyEntry = {
    id: newId(),
    provider,
    label: label?.trim() || (sameProvider ? `${PROVIDER_LABEL[provider]} ${sameProvider + 1}` : PROVIDER_LABEL[provider]),
    last4: key.slice(-4),
    addedAt: nowIso(),
    verifiedAt: null,
    models: [],
    blocked: [],
  };
  // Secret first: a description without its secret would be a key that can never work.
  await secrets.set(secretName(entry.id), key);
  await saveKeys(db, [...keys, entry]);
  return entry;
}

/** Records a successful verification: the models this key can use, and a clean slate for blocked ones. */
export async function markVerified(db: Db, id: string, models: string[], at = nowIso()): Promise<void> {
  const keys = await listKeys(db);
  await saveKeys(db, keys.map((k) => (k.id === id ? { ...k, models, verifiedAt: at, blocked: [] } : k)));
}

/** A model that failed in use (removed, no access) is skipped for this key until it is verified again. */
export async function blockModelForKey(db: Db, id: string, model: string): Promise<void> {
  const keys = await listKeys(db);
  await saveKeys(db, keys.map((k) => (k.id === id && !k.blocked.includes(model) ? { ...k, blocked: [...k.blocked, model] } : k)));
}

export async function renameKey(db: Db, id: string, label: string): Promise<void> {
  const keys = await listKeys(db);
  await saveKeys(db, keys.map((k) => (k.id === id ? { ...k, label: label.trim() || k.label } : k)));
}

/** Removes a key; purposes that used it go back to 自动. */
export async function removeKey(db: Db, secrets: SecretStore, id: string): Promise<void> {
  const keys = await listKeys(db);
  await saveKeys(db, keys.filter((k) => k.id !== id));
  const routes = await getRoutes(db);
  const next = Object.fromEntries(Object.entries(routes).map(([p, r]) => [p, r !== 'auto' && r.keyId === id ? 'auto' : r])) as Routes;
  await saveRoutes(db, next);
  await secrets.set(secretName(id), null);
}

// ---------- consent, per provider ----------

/** Whether the user agreed that their photos are sent to this provider (asked before the first send to each). */
export async function hasConsentFor(db: Db, provider: ProviderId): Promise<boolean> {
  return !!parseJson<Partial<Record<ProviderId, string>>>(await getSetting(db, S.consent), {})[provider];
}

export async function setConsentFor(db: Db, provider: ProviderId, at = nowIso()): Promise<void> {
  const all = parseJson<Partial<Record<ProviderId, string>>>(await getSetting(db, S.consent), {});
  await setSetting(db, S.consent, JSON.stringify({ ...all, [provider]: at }));
}

// ---------- one-time move from the single OpenAI key ----------

/**
 * Moves 0.5.x's single OpenAI key, its probed models and the photo consent into the multi-key settings. Safe to run
 * on every start: it does nothing once done, and if it is interrupted it resumes without duplicating the key. The old
 * secret is removed only after everything else is written.
 */
export async function migrateLegacyKey(db: Db, secrets: SecretStore): Promise<void> {
  if ((await getSetting(db, S.migrated)) === '1') return;
  const legacy = (await secrets.get(LEGACY_KEY))?.trim() || null;
  if (legacy) {
    const keys = await listKeys(db);
    // A run that stopped half-way may already have copied it.
    let existing: KeyEntry | undefined;
    for (const k of keys.filter((x) => x.provider === 'openai')) if ((await secrets.get(secretName(k.id))) === legacy) existing = k;
    if (!existing) {
      const choice = await getModelChoice(db);
      const entry: KeyEntry = {
        id: newId(),
        provider: 'openai',
        label: PROVIDER_LABEL.openai,
        last4: legacy.slice(-4),
        addedAt: nowIso(),
        // The old probe kept only the chosen models; the full list is read again at the next verification.
        verifiedAt: choice.probedAt,
        models: [choice.image, choice.vision].filter((m): m is string => !!m),
        blocked: choice.blocked,
      };
      await secrets.set(secretName(entry.id), legacy);
      await saveKeys(db, [...keys, entry]);
    }
  }
  if ((await getSetting(db, S.legacyConsent)) === '1' && !(await hasConsentFor(db, 'openai'))) await setConsentFor(db, 'openai');
  await setSetting(db, S.migrated, '1');
  if (legacy) await secrets.set(LEGACY_KEY, null);
}
