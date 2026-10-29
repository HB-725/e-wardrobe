import { getAiBlocked, getPrefs, type Prefs } from '@/ai/config';
import type { Db } from '@/db/db';
import { listItems } from '@/db/items';
import { countActiveJobs } from '@/db/jobs';
import { avatarVersion, frontTryons, getAvatar } from '@/db/misc';
import { listOutfits } from '@/db/outfits';
import { listLogs } from '@/db/wear';
import { outfitKey } from '@/domain/outfit';
import { type ItemStats, statsById, toDateKey } from '@/domain/stats';
import type { Avatar, Item, JobType, Outfit, WearLog } from '@/domain/types';
import { needsReview } from './actions';

/** Everything the main pages need, loaded in one go (a wardrobe is a few hundred rows at most). */
export interface Snapshot {
  today: Date;
  todayKey: string;
  items: Item[];
  active: Item[];
  review: Item[];
  processing: Item[];
  failed: Item[];
  byId: Map<string, Item>;
  logs: WearLog[];
  todayLog: WearLog | null;
  stats: Map<string, ItemStats>;
  outfits: Outfit[];
  avatar: Avatar;
  /** Front try-on image per outfit key for the current avatar. */
  tryons: Map<string, string>;
  blocked: string | null;
  jobs: Record<JobType, number>;
  prefs: Prefs;
}

export async function loadSnapshot(db: Db): Promise<Snapshot> {
  const today = new Date();
  const [items, logs, outfits, avatar, blocked, jobs, prefs] = await Promise.all([
    listItems(db),
    listLogs(db),
    listOutfits(db),
    getAvatar(db),
    getAiBlocked(db),
    countActiveJobs(db),
    getPrefs(db),
  ]);
  const active = items.filter((i) => i.status === 'active');
  const todayKey = toDateKey(today);
  return {
    today,
    todayKey,
    items,
    active,
    review: items.filter(needsReview),
    processing: items.filter((i) => i.status === 'processing'),
    failed: items.filter((i) => i.status === 'failed'),
    byId: new Map(items.map((i) => [i.id, i])),
    logs,
    todayLog: logs.find((l) => l.date === todayKey) ?? null,
    stats: statsById(active, logs, today),
    outfits,
    avatar,
    tryons: await frontTryons(db, avatarVersion(avatar)),
    blocked,
    jobs,
    prefs,
  };
}

export function itemsOf(snap: Snapshot, ids: string[]): Item[] {
  return ids.map((id) => snap.byId.get(id)).filter((x): x is Item => !!x);
}

export function tryonFor(snap: Snapshot, ids: string[]): string | null {
  return snap.tryons.get(outfitKey(ids)) ?? null;
}
