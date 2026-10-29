/**
 * End-to-end check against the real OpenAI API. Skipped unless REAL_AI_DIR points at a folder with sample photos
 * (jacket.jpg, tee.jpg, jeans.jpg, sneakers.jpg, p_front.jpg, p_side.jpg, p_back.jpg). Costs about $0.10.
 *   REAL_AI_DIR=/path npx jest src/ai/__tests__/real.test.ts
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTestDb } from '@/test/memoryDb';
import { createItem, getItem, listItems, updateItem } from '@/db/items';
import { enqueueJob } from '@/db/jobs';
import { avatarVersion, getAvatar, getTryon, monthSpend, saveAvatar } from '@/db/misc';
import { outfitKey } from '@/domain/outfit';
import { createOpenAiClient, type FetchLike } from '../client';
import { type AiDeps, generatePhoto, matchMirror, tryonRef } from '../engine';
import type { ImageStore } from '../imageStore';
import { JobRunner } from '../runner';

const DIR = process.env.REAL_AI_DIR;
const maybe = DIR ? describe : describe.skip;

/** Node in Jest has no proxy-aware fetch; curl honours HTTPS_PROXY. */
const curlFetch: FetchLike = async (url, init) => {
  const bodyFile = path.join(DIR!, `.body-${Date.now()}-${Math.random()}.json`);
  const args = ['-sS', '-X', init.method, url, '-w', '\n%{http_code}'];
  for (const [k, v] of Object.entries(init.headers)) args.push('-H', `${k}: ${v}`);
  if (init.body) {
    fs.writeFileSync(bodyFile, init.body);
    args.push('--data-binary', `@${bodyFile}`);
  }
  try {
    const out = execFileSync('curl', args, { maxBuffer: 200 * 1024 * 1024 }).toString();
    const i = out.lastIndexOf('\n');
    const status = Number(out.slice(i + 1));
    return { ok: status >= 200 && status < 300, status, text: async () => out.slice(0, i) };
  } finally {
    if (fs.existsSync(bodyFile)) fs.unlinkSync(bodyFile);
  }
};

class DiskImages implements ImageStore {
  private n = 0;
  constructor(private readonly dir: string) {}
  async toDataUrl(uri: string) {
    return `data:image/jpeg;base64,${fs.readFileSync(uri).toString('base64')}`;
  }
  async saveBase64(b64: string, folder: string) {
    const p = path.join(this.dir, 'out', `${folder}-${++this.n}.jpg`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    return p;
  }
  async importPhoto(uri: string) {
    return uri;
  }
  async remove() {}
  async wipe() {}
}

maybe('real OpenAI pipeline', () => {
  jest.setTimeout(15 * 60 * 1000);

  it('catalogs garments, builds an avatar, tries an outfit on, matches a mirror photo and makes a photo', async () => {
    const db = await createTestDb();
    const images = new DiskImages(DIR!);
    const client = createOpenAiClient({ apiKey: 'proxy-injected', fetch: curlFetch });
    const deps: AiDeps = { db, images, getClient: async () => client };
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

    const items = await listItems(db);
    const report: Record<string, unknown> = {};
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
    await enqueueJob(db, 'tryon', tryonRef(key, 'front'), { itemIds: ids });
    await enqueueJob(db, 'tryon', tryonRef(key, 'back'), { itemIds: ids });
    runner.kick();
    await runner.idle();
    report.tryonFront = await getTryon(db, key, 'front', avatarVersion(avatar));
    report.tryonBack = await getTryon(db, key, 'back', avatarVersion(avatar));
    expect(report.tryonFront).toBeTruthy();

    const mirror = await matchMirror(deps, report.tryonFront as string);
    report.mirror = await Promise.all(mirror.matches.map(async (m) => ({ ...m, name: (await getItem(db, m.itemId))?.name })));
    report.photo = await generatePhoto(deps, ids, 'street');
    report.spend = await monthSpend(db);
    fs.writeFileSync(path.join(DIR!, 'report.json'), JSON.stringify(report, null, 2));
  });
});
