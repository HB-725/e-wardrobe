/**
 * The fitting room's layers against a real provider: garments already catalogued (REAL_AI_ITEMS, as in
 * tryon.real.test) are painted onto a green copy of the avatar (REAL_AI_AVATAR_GREEN, made with GREEN_PROMPT) and
 * keyed; every layer lands in REAL_AI_DIR/out and report.json lists them. About $0.03 a layer on gpt-image-2.
 *   REAL_AI_DIR=/path REAL_AI_KEY=sk-... REAL_AI_ITEMS='[...]' REAL_AI_AVATAR_FRONT=... REAL_AI_AVATAR_GREEN=... \
 *     [REAL_AI_ANALYSER=gpt-5.4-mini] npx jest src/ai/__tests__/layers.real.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTestDb } from '@/test/memoryDb';
import { curlFetch, DiskImages } from '@/test/realApi';
import { createItem } from '@/db/items';
import { avatarVersion, getAvatar, listLayers, monthSpend, saveAvatar } from '@/db/misc';
import type { Item } from '@/domain/types';
import { ensureLayers } from '@/state/actions';
import { createOpenAiClient } from '../client';
import type { AiDeps } from '../engine';
import { addKey, markVerified, probeModels, setConsentFor } from '../keys';
import { ANALYSIS_SCHEMA, ANALYSIS_SYSTEM, type AnalysisResult, analysisText } from '../prompts';
import { JobRunner } from '../runner';

const DIR = process.env.REAL_AI_DIR;
const ITEMS = process.env.REAL_AI_ITEMS ? (JSON.parse(process.env.REAL_AI_ITEMS) as Pick<Item, 'name' | 'slot' | 'originalUri' | 'catalogUri' | 'sourceUri' | 'fit'>[]) : [];
const KEY = process.env.REAL_AI_KEY ?? 'proxy-injected';

(DIR && ITEMS.length && process.env.REAL_AI_AVATAR_GREEN ? it : it.skip)('paints every garment onto the green avatar and keys the layers', async () => {
  const db = await createTestDb();
  const images = new DiskImages(DIR!);
  const client = createOpenAiClient({ apiKey: KEY, fetch: curlFetch(DIR!) });
  const deps: AiDeps = { db, images, clientFor: async () => client };
  const secrets = new Map<string, string>();
  const k = await addKey(db, { get: async (n) => secrets.get(n) ?? null, set: async (n, v) => void (v ? secrets.set(n, v) : secrets.delete(n)) }, 'openai', KEY);
  await markVerified(db, k.id, await probeModels('openai', client));
  await setConsentFor(db, 'openai');
  const runner = new JobRunner(deps, { concurrency: 3, setTimer: () => null, clearTimer: () => {} });

  const ids: string[] = [];
  for (const it of ITEMS) {
    let look: AnalysisResult | null = null;
    if (process.env.REAL_AI_ANALYSER) {
      look = (await client.visionJson<AnalysisResult>({ model: process.env.REAL_AI_ANALYSER, system: ANALYSIS_SYSTEM, text: analysisText(it.slot), images: [await images.toDataUrl(it.originalUri!)], schemaName: 'analysis', schema: ANALYSIS_SCHEMA, detail: 'high' })).data;
    }
    ids.push((await createItem(db, { ...it, look, status: 'active' })).id);
  }
  await saveAvatar(db, { frontUri: process.env.REAL_AI_AVATAR_FRONT!, backUri: process.env.REAL_AI_AVATAR_BACK ?? null, greenFrontUri: process.env.REAL_AI_AVATAR_GREEN!, greenBackUri: process.env.REAL_AI_AVATAR_GREEN_BACK ?? null, sourceUris: [], heightCm: 175, weightKg: 64, build: 'slim', status: 'ready' });

  const queued = await ensureLayers({ db, images, runner }, ids);
  runner.kick();
  await runner.idle();
  const layers = await listLayers(db, ids, avatarVersion(await getAvatar(db)));
  const report = { queued, layers, spend: await monthSpend(db) };
  fs.writeFileSync(path.join(DIR!, 'report.json'), JSON.stringify(report, null, 2));
  expect(layers.length).toBeGreaterThan(0);
}, 20 * 60 * 1000);
