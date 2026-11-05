/**
 * Intake only, against a real provider, on every photo in REAL_AI_DIR (jpg / png / webp): recognise, cut out, make
 * the catalog candidates and check them. A photo with several garments takes the biggest, as the picker would.
 * Writes out/ (crops and candidates) and report.json. About $0.02 per photo on OpenAI, $0.09 on Gemini.
 *   REAL_AI_DIR=/path [REAL_AI_PROVIDER=gemini] REAL_AI_KEY=... npx jest src/ai/__tests__/catalog.real.test.ts
 * REAL_AI_QUALITY=low|medium|high and REAL_AI_MODEL=<image model id> override the catalog settings for a comparison.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTestDb } from '@/test/memoryDb';
import { curlFetch, DiskImages } from '@/test/realApi';
import { createItem, listItems, updateItem } from '@/db/items';
import { enqueueJob } from '@/db/jobs';
import { monthSpend } from '@/db/misc';
import { boxArea } from '@/domain/crop';
import { confirmPicks } from '@/state/actions';
import type { ProviderId } from '../catalog';
import { createOpenAiClient } from '../client';
import type { AiDeps } from '../engine';
import { saveAiSettings } from '../config';
import { addKey, getRoutes, markVerified, probeModels, saveRoutes, setConsentFor } from '../keys';
import { createGeminiClient } from '../providers/gemini';
import { JobRunner } from '../runner';

const DIR = process.env.REAL_AI_DIR;
const PROVIDER: ProviderId = process.env.REAL_AI_PROVIDER === 'gemini' ? 'gemini' : 'openai';
const KEY = process.env.REAL_AI_KEY ?? 'proxy-injected';

(DIR ? describe : describe.skip)(`real ${PROVIDER} intake`, () => {
  jest.setTimeout(20 * 60 * 1000);

  it('recognises every photo, cuts the garment out and makes catalog candidates', async () => {
    const db = await createTestDb();
    const images = new DiskImages(DIR!);
    // Every image prompt sent, to see what the recognition told the image model.
    const logPrompt = (body: string) => {
      const prompt = /"prompt":"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
      if (prompt) fs.appendFileSync(path.join(DIR!, 'prompts.txt'), `${JSON.parse(`"${prompt}"`)}\n\n`);
    };
    const client = (PROVIDER === 'gemini' ? createGeminiClient : createOpenAiClient)({ apiKey: KEY, fetch: curlFetch(DIR!, logPrompt) });
    const deps: AiDeps = { db, images, clientFor: async () => client };
    const secrets = new Map<string, string>();
    const k = await addKey(db, { get: async (n) => secrets.get(n) ?? null, set: async (n, v) => void (v ? secrets.set(n, v) : secrets.delete(n)) }, PROVIDER, KEY);
    await markVerified(db, k.id, await probeModels(PROVIDER, client));
    await setConsentFor(db, PROVIDER);
    const quality = process.env.REAL_AI_QUALITY as 'low' | 'medium' | 'high' | undefined;
    if (quality) await saveAiSettings(db, { catalogQuality: quality });
    if (process.env.REAL_AI_MODEL) await saveRoutes(db, { ...(await getRoutes(db)), catalog: { keyId: k.id, model: process.env.REAL_AI_MODEL } });
    const runner = new JobRunner(deps, { concurrency: 3, setTimer: () => null, clearTimer: () => {} });

    const photos = fs.readdirSync(DIR!).filter((f) => /\.(jpe?g|png|webp)$/i.test(f) && !f.startsWith('p_'));
    for (const f of photos) {
      const item = await createItem(db, { name: '新衣服', slot: 'top', status: 'processing', originalUri: path.join(DIR!, f) });
      await enqueueJob(db, 'catalog', item.id);
    }
    runner.kick();
    await runner.idle();

    const picks: Record<string, string[]> = {};
    for (const it of await listItems(db, ['pick'])) {
      picks[path.basename(it.originalUri!)] = it.detections.map((d) => `${d.name} (${d.slot})`);
      const main = it.detections.reduce((a, b) => (boxArea(b.box) > boxArea(a.box) ? b : a));
      await updateItem(db, it.id, { detections: it.detections.map((d) => ({ ...d, selected: d === main })) });
      await confirmPicks({ db, images, runner }, it.id);
    }
    await runner.idle();

    const items: Record<string, unknown> = {};
    for (const it of await listItems(db)) {
      const photo = path.basename(it.sourceUri ?? it.originalUri!);
      items[photo] = {
        status: it.status,
        error: it.error,
        name: it.name,
        slot: it.slot,
        subcategory: it.subcategory,
        color: it.colorName,
        hex: it.colorHex,
        seasons: it.seasons,
        brand: it.brand,
        material: it.material,
        crop: it.sourceUri ? path.basename(it.originalUri!) : null,
        candidates: it.candidates.map((c) => path.basename(c)),
        checks: it.checks,
      };
    }
    const usage = await db.getAllAsync('SELECT kind, model, cost_usd AS usd FROM usage ORDER BY created_at');
    fs.writeFileSync(path.join(DIR!, 'report.json'), JSON.stringify({ provider: PROVIDER, quality: quality ?? 'default', model: process.env.REAL_AI_MODEL ?? 'auto', picks, items, spend: await monthSpend(db), usage }, null, 2));
    expect(Object.values(items).every((i) => (i as { status: string }).status === 'review')).toBe(true);
  });
});
