import { createTestDb } from '@/test/memoryDb';
import type { ImageFolder, ImageStore } from '@/ai/imageStore';
import { createItem, getItem, listItems } from '@/db/items';
import { enqueueJob, listJobs } from '@/db/jobs';
import { avatarVersion, getAvatar, getSetting, getTryon, putTryon, saveAvatar, setSetting } from '@/db/misc';
import { getLogByDate, logWear } from '@/db/wear';
import { createOutfit, listOutfits } from '@/db/outfits';
import { type BackupStorage, createBackup, readBackupInfo, restoreBackup } from '../backup';

class Disk {
  files = new Map<string, string>();
}

/** App image store whose files live in a shared fake disk. */
class Images implements ImageStore {
  removed: string[] = [];
  n = 0;
  constructor(private readonly disk: Disk, private readonly prefix: string) {}
  async toDataUrl(u: string) {
    return u;
  }
  async saveBase64(b64: string, folder: ImageFolder) {
    const uri = `${this.prefix}/${folder}/${++this.n}.jpg`;
    this.disk.files.set(uri, b64);
    return uri;
  }
  async importPhoto(u: string, folder: ImageFolder) {
    return this.saveBase64(this.disk.files.get(u) ?? '', folder);
  }
  async remove(u: string | null | undefined) {
    if (u) {
      this.removed.push(u);
      this.disk.files.delete(u);
    }
  }
  async wipe() {}
}

class Folder implements BackupStorage {
  texts = new Map<string, string>();
  blobs = new Map<string, string>();
  constructor(private readonly disk: Disk, private readonly images: Images) {}
  async writeText(n: string, t: string) {
    this.texts.set(n, t);
  }
  async readText(n: string) {
    const t = this.texts.get(n);
    if (t === undefined) throw new Error('missing');
    return t;
  }
  async putImage(n: string, uri: string) {
    const data = this.disk.files.get(uri);
    if (data === undefined) throw new Error('gone');
    this.blobs.set(n, data);
  }
  async getImage(n: string, folder: ImageFolder) {
    return this.images.saveBase64(this.blobs.get(n)!, folder);
  }
}

async function seed() {
  const disk = new Disk();
  const db = await createTestDb();
  const images = new Images(disk, 'old');
  const img = async (folder: ImageFolder, data: string) => images.saveBase64(data, folder);
  const jacket = await createItem(db, { name: '夹克', slot: 'outer', status: 'active', originalUri: await img('original', 'J0'), catalogUri: await img('catalog', 'J1'), priceCents: 39900, fieldSources: { name: 'user' } });
  const tee = await createItem(db, { name: 'T恤', slot: 'top', status: 'review', originalUri: await img('original', 'T0'), candidates: [await img('catalog', 'T1'), await img('catalog', 'T2')] });
  const pending = await createItem(db, { name: '新衣服', slot: 'top', status: 'processing', originalUri: await img('original', 'P0') });
  await enqueueJob(db, 'catalog', pending.id);
  const outfit = await createOutfit(db, { name: '周末', occasions: ['weekend'], itemIds: [jacket.id, tee.id] });
  await logWear(db, { date: '2026-10-01', itemIds: [jacket.id], outfitId: outfit.id, source: 'mirror', photoUri: await img('mirror', 'M') });
  const avatar = await saveAvatar(db, { frontUri: await img('avatar', 'AF'), backUri: await img('avatar', 'AB'), sourceUris: [await img('body', 'B1')], heightCm: 175, status: 'ready' });
  await putTryon(db, `${jacket.id}+${tee.id}`, 'front', avatarVersion(avatar), await img('tryon', 'TF'));
  await setSetting(db, 'prefs', JSON.stringify({ nickname: '小林' }));
  await setSetting(db, 'ai.keyLast4', 'OLD1');
  return { disk, db, images, jacket, tee, pending, outfit };
}

describe('backup', () => {
  it('restores every table and picture into a fresh phone', async () => {
    const src = await seed();
    const folder = new Folder(src.disk, src.images);
    const r = await createBackup(src.db, folder);
    expect(r).toEqual({ items: 3, images: 11 });
    expect(folder.texts.get('backup.json')).not.toContain('old/');
    expect((await readBackupInfo(folder)).items).toBe(3);

    // New phone: empty db, own key indicator, separate storage.
    const db2 = await createTestDb();
    await setSetting(db2, 'ai.keyLast4', 'NEW2');
    const images2 = new Images(src.disk, 'new');
    const folder2 = Object.assign(new Folder(src.disk, images2), { texts: folder.texts, blobs: folder.blobs });
    await restoreBackup(db2, images2, folder2);

    const items = await listItems(db2);
    expect(items.map((i) => i.name).sort()).toEqual(['T恤', '夹克', '新衣服']);
    const jacket = (await getItem(db2, src.jacket.id))!;
    expect(jacket.catalogUri).toMatch(/^new\/catalog\//);
    expect(src.disk.files.get(jacket.catalogUri!)).toBe('J1');
    expect(jacket.fieldSources).toEqual({ name: 'user' });
    const tee = (await getItem(db2, src.tee.id))!;
    expect(tee.candidates.map((u) => src.disk.files.get(u))).toEqual(['T1', 'T2']);
    expect((await getItem(db2, src.pending.id))!.status).toBe('failed');
    expect(await listJobs(db2, ['queued'])).toHaveLength(0);
    expect((await listOutfits(db2))[0].itemIds.sort()).toEqual([src.jacket.id, src.tee.id].sort());
    const log = (await getLogByDate(db2, '2026-10-01'))!;
    expect(src.disk.files.get(log.photoUri!)).toBe('M');
    const avatar = await getAvatar(db2);
    expect(src.disk.files.get(avatar.frontUri!)).toBe('AF');
    expect(avatar.sourceUris.map((u) => src.disk.files.get(u))).toEqual(['B1']);
    // try-on cache follows the remapped avatar version
    const tryon = await getTryon(db2, `${src.jacket.id}+${src.tee.id}`, 'front', avatarVersion(avatar));
    expect(src.disk.files.get(tryon!)).toBe('TF');
    expect(await getSetting(db2, 'prefs')).toContain('小林');
    expect(await getSetting(db2, 'ai.keyLast4')).toBe('NEW2');
  });

  it('restoring over existing data replaces it and deletes the old pictures', async () => {
    const src = await seed();
    const folder = new Folder(src.disk, src.images);
    await createBackup(src.db, folder);
    const extra = await createItem(src.db, { name: '多余的', slot: 'bag', status: 'active', catalogUri: await src.images.saveBase64('X', 'catalog') });
    await restoreBackup(src.db, src.images, folder);
    expect(await getItem(src.db, extra.id)).toBeNull();
    expect(src.images.removed).toContain(extra.catalogUri);
    expect(await getSetting(src.db, 'ai.keyLast4')).toBe('OLD1');
  });

  it('skips pictures that went missing and refuses folders without a backup', async () => {
    const src = await seed();
    const j = (await getItem(src.db, src.jacket.id))!;
    src.disk.files.delete(j.catalogUri!);
    const folder = new Folder(src.disk, src.images);
    const r = await createBackup(src.db, folder);
    expect(r.images).toBe(10);
    const db2 = await createTestDb();
    await restoreBackup(db2, new Images(src.disk, 'n2'), Object.assign(new Folder(src.disk, src.images), { texts: folder.texts, blobs: folder.blobs }));
    expect((await getItem(db2, src.jacket.id))!.catalogUri).toBeNull();
    await expect(readBackupInfo(new Folder(src.disk, src.images))).rejects.toThrow('backup.json');
  });
});

describe('backup edge cases', () => {
  it('does not restore an avatar stuck in processing, and keeps candidate checks aligned', async () => {
    const src = await seed();
    await saveAvatar(src.db, { status: 'processing' });
    const tee = (await getItem(src.db, src.tee.id))!;
    await src.db.runAsync('UPDATE items SET checks = ? WHERE id = ?', [JSON.stringify([[{ label: 'A', ok: true, note: '' }], [{ label: 'B', ok: false, note: '' }]]), tee.id]);
    src.disk.files.delete(tee.candidates[0]); // first candidate's picture went missing
    const folder = new Folder(src.disk, src.images);
    await createBackup(src.db, folder);
    const db2 = await createTestDb();
    await restoreBackup(db2, new Images(src.disk, 'n3'), Object.assign(new Folder(src.disk, src.images), { texts: folder.texts, blobs: folder.blobs }));
    expect((await getAvatar(db2)).status).toBe('ready');
    const t2 = (await getItem(db2, src.tee.id))!;
    expect(t2.candidates).toHaveLength(1);
    expect(t2.checks).toEqual([[{ label: 'B', ok: false, note: '' }]]);
  });

  it('cleans up copied pictures when the database step fails', async () => {
    const src = await seed();
    const folder = new Folder(src.disk, src.images);
    await createBackup(src.db, folder);
    const json = JSON.parse(folder.texts.get('backup.json')!);
    json.tables.outfit_items.push({ outfit_id: 'nope', item_id: 'nope' }); // breaks a foreign key
    folder.texts.set('backup.json', JSON.stringify(json));
    const db2 = await createTestDb();
    const images2 = new Images(src.disk, 'n4');
    await expect(restoreBackup(db2, images2, Object.assign(new Folder(src.disk, images2), { texts: folder.texts, blobs: folder.blobs }))).rejects.toThrow();
    expect([...src.disk.files.keys()].some((k) => k.startsWith('n4/'))).toBe(false);
    expect(await listItems(db2)).toEqual([]);
  });
});
