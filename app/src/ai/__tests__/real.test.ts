/**
 * End-to-end check against a real provider. Skipped unless REAL_AI_DIR points at a folder with sample photos
 * (jacket.jpg, tee.jpg, jeans.jpg, sneakers.jpg, p_front.jpg, p_side.jpg, p_back.jpg). About $0.10 on OpenAI, $0.50 on Gemini.
 *   REAL_AI_DIR=/path [REAL_AI_PROVIDER=gemini] [REAL_AI_KEY=...] npx jest src/ai/__tests__/real.test.ts
 * Without REAL_AI_KEY the key is expected to be injected by a proxy (the cloud build box).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTestDb } from '@/test/memoryDb';
import { curlFetch, DiskImages } from '@/test/realApi';
import { createItem, getItem, listItems, updateItem } from '@/db/items';
import { enqueueJob } from '@/db/jobs';
import { avatarVersion, getAvatar, getTryon, monthSpend, saveAvatar } from '@/db/misc';
import { boxArea } from '@/domain/crop';
import { outfitKey } from '@/domain/outfit';
import { confirmPicks } from '@/state/actions';
import type { ProviderId } from '../catalog';
import { createOpenAiClient } from '../client';
import { type AiDeps, generatePhoto, matchMirror, tryonRef } from '../engine';
import { addKey, markVerified, probeModels, setConsentFor } from '../keys';
import { createGeminiClient } from '../providers/gemini';
import { JobRunner } from '../runner';

const DIR = process.env.REAL_AI_DIR;
const maybe = DIR ? describe : describe.skip;
const PROVIDER: ProviderId = process.env.REAL_AI_PROVIDER === 'gemini' ? 'gemini' : 'openai';
const KEY = process.env.REAL_AI_KEY ?? 'proxy-injected';
/** What the outfit checks answered, for the report (the engine keeps only the picture). */
const outfitChecks: string[] = [];

maybe(`real ${PROVIDER} pipeline`, () => {
  jest.setTimeout(15 * 60 * 1000);

  it('catalogs garments, builds an avatar, tries an outfit on, matches a mirror photo and makes a photo', async () => {
    const db = await createTestDb();
    const images = new DiskImages(DIR!);
    const fetch = curlFetch(DIR!, (body, text) => {
      if (body.includes('穿搭照片有没有画错')) outfitChecks.push(text.replace(/\s+/g, ' ').slice(0, 600));
    });
    const client = (PROVIDER === 'gemini' ? createGeminiClient : createOpenAiClient)({ apiKey: KEY, fetch });
    const deps: AiDeps = { db, images, clientFor: async () => client };
    const secrets = new Map<string, string>();
    const k = await addKey(db, { get: async (n) => secrets.get(n) ?? null, set: async (n, v) => void (v ? secrets.set(n, v) : secrets.delete(n)) }, PROVIDER, KEY);
    await markVerified(db, k.id, await probeModels(PROVIDER, client));
    await setConsentFor(db, PROVIDER);
    const runner = new JobRunner(deps, { concurrency: 3, setTimer: () => null, clearTimer: () => {} });

    for (const name of ['jacket', 'tee', 'jeans', 'sneakers']) {
      const item = await createItem(db, { name: '新衣服', slot: 'top', status: 'processing', originalUri: path.join(DIR!, `${name}.jpg`) });
      await enqueueJob(db, 'catalog', item.id);
    }
    await saveAvatar(db, {
      sourceUris: ['p_front', 'p_side', 'p_back'].map((n) => path.join(DIR!, `${n}.jpg`)),
      heightCm: 175,
      weightKg: 64,
      build: 'slim',
      status: 'processing',
    });
    await enqueueJob(db, 'avatar', 'me');
    runner.kick();
    await runner.idle();

    // A photo with several garments waits for the user to choose; choose the biggest, as whoever took it would.
    const report: Record<string, unknown> = {};
    const picks: Record<string, string[]> = {};
    for (const it of await listItems(db, ['pick'])) {
      picks[path.basename(it.originalUri!)] = it.detections.map((d) => `${d.name} (${d.slot})`);
      const main = it.detections.reduce((a, b) => (boxArea(b.box) > boxArea(a.box) ? b : a));
      await updateItem(db, it.id, { detections: it.detections.map((d) => ({ ...d, selected: d === main })) });
      await confirmPicks({ db, images, runner }, it.id);
    }
    report.picks = picks;
    await runner.idle();

    const items = await listItems(db);
    for (const it of items) {
      report[it.name] = { status: it.status, error: it.error, slot: it.slot, color: it.colorName, hex: it.colorHex, seasons: it.seasons, candidates: it.candidates, checks: it.checks };
      expect(it.status).toBe('review');
      await updateItem(db, it.id, { status: 'active', catalogUri: it.candidates[0] });
    }
    const avatar = await getAvatar(db);
    report.avatar = avatar;
    expect(avatar.status).toBe('ready');

    const ids = (await listItems(db, ['active'])).map((i) => i.id);
    const key = outfitKey(ids);
    // Front first: a back queued at the same time would draw its own front (the runner here runs 3 jobs at once).
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: ids });
    runner.kick();
    await runner.idle();
    await enqueueJob(db, 'tryon', tryonRef(key, 'back'), { itemIds: ids });
    runner.kick();
    await runner.idle();
    report.tryonFront = await getTryon(db, key, 'front', avatarVersion(avatar));
    report.tryonBack = await getTryon(db, key, 'back', avatarVersion(avatar));
    expect(report.tryonFront).toBeTruthy();

    const mirror = await matchMirror(deps, report.tryonFront as string);
    report.mirror = await Promise.all(mirror.matches.map(async (m) => ({ ...m, name: (await getItem(db, m.itemId))?.name })));
    report.photo = await generatePhoto(deps, ids, 'street');
    report.outfitChecks = outfitChecks;
    report.spend = await monthSpend(db);
    report.usage = await db.getAllAsync('SELECT kind, model, cost_usd AS usd FROM usage ORDER BY created_at');
    fs.writeFileSync(path.join(DIR!, 'report.json'), JSON.stringify(report, null, 2));
  });
});
