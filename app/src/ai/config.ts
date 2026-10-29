import type { Db } from '@/db/db';
import { parseJson } from '@/db/db';
import { getSetting, setSetting } from '@/db/misc';
import { EMPTY_CHOICE, type ModelChoice } from './models';

export type QualityLevel = 'economy' | 'standard' | 'high';

export interface AiSettings {
  /** Monthly spend cap in USD; new AI work pauses once reached. */
  capUsd: number;
  quality: QualityLevel;
  /** How many catalog candidates to generate per garment. */
  candidates: number;
}

export const DEFAULT_AI_SETTINGS: AiSettings = { capUsd: 5, quality: 'standard', candidates: 2 };

const K = {
  settings: 'ai.settings',
  models: 'ai.models',
  blocked: 'ai.blocked',
} as const;

export async function getAiSettings(db: Db): Promise<AiSettings> {
  return { ...DEFAULT_AI_SETTINGS, ...parseJson<Partial<AiSettings>>(await getSetting(db, K.settings), {}) };
}

export async function saveAiSettings(db: Db, patch: Partial<AiSettings>): Promise<AiSettings> {
  const next = { ...(await getAiSettings(db)), ...patch };
  await setSetting(db, K.settings, JSON.stringify(next));
  return next;
}

export async function getModelChoice(db: Db): Promise<ModelChoice> {
  return { ...EMPTY_CHOICE, ...parseJson<Partial<ModelChoice>>(await getSetting(db, K.models), {}) };
}

export async function saveModelChoice(db: Db, choice: ModelChoice): Promise<void> {
  await setSetting(db, K.models, JSON.stringify(choice));
}

/** Why background AI work is paused (no key, bad key, no credit, cap); null when running normally. */
export async function getAiBlocked(db: Db): Promise<string | null> {
  const v = await getSetting(db, K.blocked);
  return v ? v : null;
}

export async function setAiBlocked(db: Db, reason: string | null): Promise<void> {
  await setSetting(db, K.blocked, reason ?? '');
}

export type ImageTask = 'catalog' | 'avatar' | 'tryon' | 'photo';

export function qualityFor(level: QualityLevel, task: ImageTask): 'low' | 'medium' | 'high' {
  if (level === 'economy') return 'low';
  if (level === 'high') return task === 'catalog' ? 'medium' : 'high';
  return task === 'catalog' ? 'low' : 'medium';
}

// ---------- preferences that are not AI-specific ----------

export interface Prefs {
  /** Logging a mirror photo counts as a wear (the toggle on the Me page). */
  mirrorAutoLog: boolean;
  /** Items idle at least this many days show up in "好久没穿了". */
  idleDays: number;
  nickname: string;
}

export const DEFAULT_PREFS: Prefs = { mirrorAutoLog: true, idleDays: 30, nickname: '' };

export async function getPrefs(db: Db): Promise<Prefs> {
  return { ...DEFAULT_PREFS, ...parseJson<Partial<Prefs>>(await getSetting(db, 'prefs'), {}) };
}

export async function savePrefs(db: Db, patch: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await getPrefs(db)), ...patch };
  await setSetting(db, 'prefs', JSON.stringify(next));
  return next;
}
