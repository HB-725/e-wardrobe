/**
 * Try-on and photo against a real provider for garments that are already catalogued: REAL_AI_ITEMS is a JSON list of
 * `{ name, slot, originalUri, catalogUri }`, REAL_AI_AVATAR_FRONT / REAL_AI_AVATAR_BACK an avatar's pictures. Writes
 * out/ and report.json (try-on front, back and the photo) into REAL_AI_DIR. About $0.10 on gpt-image-1-mini.
 *   REAL_AI_DIR=/path REAL_AI_KEY=sk-... REAL_AI_ITEMS='[...]' REAL_AI_AVATAR_FRONT=... REAL_AI_AVATAR_BACK=... \
 *     npx jest src/ai/__tests__/tryon.real.test.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTestDb } from '@/test/memoryDb';
import { curlFetch, DiskImages } from '@/test/realApi';
import { createItem } from '@/db/items';
import { enqueueJob } from '@/db/jobs';
import { avatarVersion, getAvatar, getTryon, monthSpend, saveAvatar } from '@/db/misc';
import { outfitKey } from '@/domain/outfit';
import type { Item } from '@/domain/types';
import type { ProviderId } from '../catalog';
import { createOpenAiClient } from '../client';
import { ANALYSIS_SCHEMA, ANALYSIS_SYSTEM, type AnalysisResult, analysisText } from '../prompts';
import { type AiDeps, generatePhoto, tryonRef } from '../engine';
import { addKey, markVerified, probeModels, setConsentFor } from '../keys';
import { createGeminiClient } from '../providers/gemini';
import { JobRunner } from '../runner';

const DIR = process.env.REAL_AI_DIR;
const ITEMS = process.env.REAL_AI_ITEMS ? (JSON.parse(process.env.REAL_AI_ITEMS) as Pick<Item, 'name' | 'slot' | 'originalUri' | 'catalogUri' | 'sourceUri' | 'fit'>[]) : [];
/** Analyses each garment first (as intake does) with this vision model, so the try-on gets the brief and fit. */
const ANALYSER = process.env.REAL_AI_ANALYSER;
const PROVIDER: ProviderId = process.env.REAL_AI_PROVIDER === 'gemini' ? 'gemini' : 'openai';
const KEY = process.env.REAL_AI_KEY ?? 'proxy-injected';

(DIR && ITEMS.length && process.env.REAL_AI_AVATAR_FRONT ? it : it.skip)('tries catalogued garments on an avatar and makes a photo', async () => {
  const db = await createTestDb();
  const images = new DiskImages(DIR!);
  const client = (PROVIDER === 'gemini' ? createGeminiClient : createOpenAiClient)({ apiKey: KEY, fetch: curlFetch(DIR!) });
  const deps: AiDeps = { db, images, clientFor: async () => client };
  const secrets = new Map<string, string>();
  const k = await addKey(db, { get: async (n) => secrets.get(n) ?? null, set: async (n, v) => void (v ? secrets.set(n, v) : secrets.delete(n)) }, PROVIDER, KEY);
  await markVerified(db, k.id, await probeModels(PROVIDER, client));
  await setConsentFor(db, PROVIDER);
  const runner = new JobRunner(deps, { concurrency: 3, setTimer: () => null, clearTimer: () => {} });

  const ids: string[] = [];
  const looks: Record<string, unknown> = {};
  for (const it of ITEMS) {
    let look: AnalysisResult | null = null;
    if (ANALYSER) {
      const r = await client.visionJson<AnalysisResult>({ model: ANALYSER, system: ANALYSIS_SYSTEM, text: analysisText(it.slot), images: [await images.toDataUrl(it.originalUri!)], schemaName: 'analysis', schema: ANALYSIS_SCHEMA, detail: 'high' });
      look = r.data;
      looks[it.name] = look;
    }
    ids.push((await createItem(db, { ...it, look, status: 'active' })).id);
  }
  await saveAvatar(db, { frontUri: process.env.REAL_AI_AVATAR_FRONT!, backUri: process.env.REAL_AI_AVATAR_BACK ?? null, sourceUris: [], heightCm: 175, weightKg: 64, build: 'slim', status: 'ready' });
  const prompts: string[] = [];
  const origGenerate = client.imageEdit.bind(client);
  client.imageEdit = async (req) => {
    prompts.push(req.prompt);
    return origGenerate(req);
  };
  const avatar = await getAvatar(db);

  const key = outfitKey(ids);
  await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: ids });
  runner.kick();
  await runner.idle();
  await enqueueJob(db, 'tryon', tryonRef(key, 'back'), { itemIds: ids });
  runner.kick();
  await runner.idle();
  const report: Record<string, unknown> = {
    tryonFront: await getTryon(db, key, 'front', avatarVersion(avatar)),
    tryonBack: await getTryon(db, key, 'back', avatarVersion(avatar)),
  };
  expect(report.tryonFront).toBeTruthy();
  report.photo = await generatePhoto(deps, ids, process.env.REAL_AI_SCENE ?? 'street');
  report.looks = looks;
  report.prompts = prompts;
  report.spend = await monthSpend(db);
  fs.writeFileSync(path.join(DIR!, 'report.json'), JSON.stringify(report, null, 2));
}, 20 * 60 * 1000);
