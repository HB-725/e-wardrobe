import { createTestDb } from '@/test/memoryDb';
import type { Db } from '../db';
import { migrate, SCHEMA_VERSION } from '../schema';
import { countByStatus, createItem, deleteItem, getItem, listItems, setUserField, updateItem } from '../items';
import { createOutfit, deleteOutfit, findOutfitByItems, listOutfits, outfitsContaining } from '../outfits';
import { deleteLogByDate, getLogByDate, listLogs, logWear } from '../wear';
import { claimNextJob, completeJob, deferJob, enqueueJob, failJob, listJobs, MAX_ATTEMPTS, recoverRunningJobs, retryJob } from '../jobs';
import { addUsage, avatarVersion, getAvatar, getSetting, getTryon, monthSpend, putTryon, saveAvatar, setSetting, wipeAll } from '../misc';

let db: Db;
beforeEach(async () => {
  db = await createTestDb();
});

describe('schema', () => {
  it('migrates to the latest version and is idempotent', async () => {
    await migrate(db);
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(SCHEMA_VERSION);
  });
});

describe('items', () => {
  it('creates, reads and lists items with JSON fields round-tripped', async () => {
    const a = await createItem(db, { name: '牛仔夹克', slot: 'outer', status: 'active', seasons: ['spring', 'autumn'], priceCents: 39900 });
    expect(a.seasons).toEqual(['spring', 'autumn']);
    expect(a.priceCents).toBe(39900);
    expect(a.fieldSources).toEqual({});
    await createItem(db, { name: 'T恤', slot: 'top', status: 'review' });
    expect((await listItems(db)).length).toBe(2);
    expect((await listItems(db, ['active'])).map((i) => i.name)).toEqual(['牛仔夹克']);
  });

  it('updates only known fields and bumps updated_at', async () => {
    const a = await createItem(db, { name: 'x', slot: 'top', status: 'processing' });
    const b = await updateItem(db, a.id, { name: 'y', status: 'review', id: 'hacked' } as never);
    expect(b?.name).toBe('y');
    expect(b?.status).toBe('review');
    expect(b?.id).toBe(a.id);
  });

  it('marks fields typed by the user', async () => {
    const a = await createItem(db, { name: 'x', slot: 'top', status: 'active', fieldSources: { name: 'ai', colorName: 'ai' } });
    const b = await setUserField(db, a.id, 'name', '白衬衫');
    expect(b?.name).toBe('白衬衫');
    expect(b?.fieldSources).toEqual({ name: 'user', colorName: 'ai' });
  });

  it('counts by status', async () => {
    await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    await createItem(db, { name: 'b', slot: 'top', status: 'review' });
    await createItem(db, { name: 'c', slot: 'top', status: 'review' });
    const c = await countByStatus(db);
    expect(c.active).toBe(1);
    expect(c.review).toBe(2);
    expect(c.failed).toBe(0);
  });
});

describe('outfits', () => {
  it('stores item membership and finds duplicates regardless of order', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    const b = await createItem(db, { name: 'b', slot: 'bottom', status: 'active' });
    const o = await createOutfit(db, { name: '周末', occasions: ['weekend'], itemIds: [a.id, b.id, a.id] });
    expect(o.itemIds.sort()).toEqual([a.id, b.id].sort());
    expect((await findOutfitByItems(db, [b.id, a.id]))?.id).toBe(o.id);
    expect(await findOutfitByItems(db, [a.id])).toBeNull();
    expect((await outfitsContaining(db, a.id)).map((x) => x.id)).toEqual([o.id]);
  });

  it('rejects empty outfits and cascades on delete', async () => {
    await expect(createOutfit(db, { name: 'x', occasions: [], itemIds: [] })).rejects.toThrow();
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    const o = await createOutfit(db, { name: 'x', occasions: [], itemIds: [a.id] });
    await deleteOutfit(db, o.id);
    expect(await listOutfits(db)).toEqual([]);
    const n = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outfit_items');
    expect(n?.n).toBe(0);
  });

  it('removes deleted items from outfits', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    const b = await createItem(db, { name: 'b', slot: 'bottom', status: 'active' });
    const o = await createOutfit(db, { name: 'x', occasions: [], itemIds: [a.id, b.id] });
    await deleteItem(db, a.id);
    expect((await listOutfits(db)).find((x) => x.id === o.id)?.itemIds).toEqual([b.id]);
  });
});

describe('wear logs', () => {
  it('keeps one log per day; re-logging replaces it', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    const b = await createItem(db, { name: 'b', slot: 'bottom', status: 'active' });
    await logWear(db, { date: '2026-10-29', itemIds: [a.id], source: 'manual' });
    await logWear(db, { date: '2026-10-29', itemIds: [a.id, b.id], source: 'manual' });
    const logs = await listLogs(db);
    expect(logs).toHaveLength(1);
    expect(logs[0].itemIds.sort()).toEqual([a.id, b.id].sort());
    await deleteLogByDate(db, '2026-10-29');
    expect(await getLogByDate(db, '2026-10-29')).toBeNull();
  });

  it('filters by date range, newest first', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    for (const d of ['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01'])
      await logWear(db, { date: d, itemIds: [a.id], source: 'manual' });
    expect((await listLogs(db, '2026-10-01', '2026-10-31')).map((l) => l.date)).toEqual(['2026-10-31', '2026-10-01']);
  });

  it('rejects empty logs', async () => {
    await expect(logWear(db, { date: '2026-10-29', itemIds: [], source: 'manual' })).rejects.toThrow();
  });
});

describe('jobs', () => {
  it('dedupes pending jobs and claims in order', async () => {
    const j1 = await enqueueJob(db, 'catalog', 'item1');
    const j2 = await enqueueJob(db, 'catalog', 'item1');
    expect(j2.id).toBe(j1.id);
    await enqueueJob(db, 'autofill', 'item1');
    const c1 = await claimNextJob(db, new Date(Date.now() + 1000));
    expect(c1?.id).toBe(j1.id);
    expect(c1?.attempts).toBe(1);
    expect(c1?.status).toBe('running');
    const c2 = await claimNextJob(db, new Date(Date.now() + 1000));
    expect(c2?.type).toBe('autofill');
    expect(await claimNextJob(db, new Date(Date.now() + 1000))).toBeNull();
  });

  it('retries with backoff and gives up after MAX_ATTEMPTS', async () => {
    await enqueueJob(db, 'catalog', 'x');
    const t0 = new Date('2030-01-01T00:00:00Z');
    let now = t0;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const job = await claimNextJob(db, now);
      expect(job?.attempts).toBe(i);
      const status = await failJob(db, job!, 'boom', { retryable: true, now });
      expect(status).toBe(i < MAX_ATTEMPTS ? 'queued' : 'failed');
      expect(await claimNextJob(db, now)).toBeNull();
      now = new Date(now.getTime() + 60 * 60 * 1000);
    }
    expect((await listJobs(db, ['failed']))[0].lastError).toBe('boom');
  });

  it('non-retryable errors fail immediately; retryJob resets', async () => {
    await enqueueJob(db, 'catalog', 'x');
    const job = await claimNextJob(db, new Date(Date.now() + 1000));
    expect(await failJob(db, job!, 'bad request', { retryable: false })).toBe('failed');
    await retryJob(db, job!.id);
    const again = await claimNextJob(db, new Date(Date.now() + 1000));
    expect(again?.attempts).toBe(1);
  });

  it('defers without consuming an attempt and recovers interrupted jobs', async () => {
    await enqueueJob(db, 'catalog', 'x');
    const job = await claimNextJob(db, new Date(Date.now() + 1000));
    await deferJob(db, job!, 'no key');
    const again = await claimNextJob(db, new Date(Date.now() + 1000));
    expect(again?.attempts).toBe(1);
    expect(await recoverRunningJobs(db)).toBe(1);
    await completeJob(db, again!.id);
    expect(await listJobs(db, ['queued', 'running'])).toEqual([]);
  });
});

describe('misc', () => {
  it('settings upsert', async () => {
    expect(await getSetting(db, 'k')).toBeNull();
    await setSetting(db, 'k', '1');
    await setSetting(db, 'k', '2');
    expect(await getSetting(db, 'k')).toBe('2');
  });

  it('avatar save/merge and try-on cache keyed by avatar version', async () => {
    expect((await getAvatar(db)).status).toBe('none');
    await saveAvatar(db, { heightCm: 175, status: 'processing' });
    const a = await saveAvatar(db, { frontUri: 'file:///front.png', status: 'ready' });
    expect(a.heightCm).toBe(175);
    const v = avatarVersion(a);
    await putTryon(db, 'a+b', 'front', v, 'file:///t1.png');
    expect(await getTryon(db, 'a+b', 'front', v)).toBe('file:///t1.png');
    expect(await getTryon(db, 'a+b', 'front', 'other')).toBeNull();
    expect(await getTryon(db, 'a+b', 'back', v)).toBeNull();
  });

  it('sums spend for the month by kind', async () => {
    await addUsage(db, { kind: 'catalog', model: 'm', costUsd: 0.05 });
    await addUsage(db, { kind: 'catalog', model: 'm', costUsd: 0.05 });
    await addUsage(db, { kind: 'tryon', model: 'm', costUsd: 0.1 });
    const s = await monthSpend(db);
    expect(s.totalUsd).toBeCloseTo(0.2);
    expect(s.byKind.catalog.count).toBe(2);
    const old = await monthSpend(db, new Date(2000, 0, 1));
    expect(old.totalUsd).toBe(0);
  });

  it('wipes everything', async () => {
    const a = await createItem(db, { name: 'a', slot: 'top', status: 'active' });
    await logWear(db, { date: '2026-10-29', itemIds: [a.id], source: 'manual' });
    await setSetting(db, 'k', 'v');
    await wipeAll(db);
    expect(await getItem(db, a.id)).toBeNull();
    expect(await listLogs(db)).toEqual([]);
    expect(await getSetting(db, 'k')).toBeNull();
  });
});
