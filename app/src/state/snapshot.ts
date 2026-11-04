import type { Routing } from '@/ai/catalog';
import { getAiBlocked, getPrefs, type Prefs } from '@/ai/config';
import { loadRouting } from '@/ai/keys';
import type { Db } from '@/db/db';
import { listItems } from '@/db/items';
import { countActiveJobs } from '@/db/jobs';
import { avatarVersion, frontTryons, getAvatar } from '@/db/misc';
import { listOutfits } from '@/db/outfits';
import { listLogs } from '@/db/wear';
import { SLOT_ORDER } from '@/domain/catalog';
import { lookFromGarments, lookKey } from '@/domain/look';
import { type ItemStats, statsById, toDateKey } from '@/domain/stats';
import type { Avatar, Item, JobType, Outfit, Styling, WearLog } from '@/domain/types';
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
  /** Whether any API key has been added (the keys themselves are in secure storage). */
  hasKey: boolean;
  /** Keys and per-purpose models, for cost estimates. */
  routing: Routing;
  jobs: Record<JobType, number>;
  prefs: Prefs;
}

export async function loadSnapshot(db: Db): Promise<Snapshot> {
  const today = new Date();
  const [items, logs, outfits, avatar, blocked, jobs, prefs, routing] = await Promise.all([
    listItems(db),
    listLogs(db),
    listOutfits(db),
    getAvatar(db),
    getAiBlocked(db),
    countActiveJobs(db),
    getPrefs(db),
    loadRouting(db),
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
    // A pause only matters while there is AI work waiting (e.g. not after the user kept the original photos).
    blocked: Object.values(jobs).some((n) => n > 0) ? blocked : null,
    hasKey: routing.keys.length > 0,
    routing,
    jobs,
    prefs,
  };
}

/** The items for these ids, top of the body to the bottom (how pictures and names are listed everywhere). */
export function itemsOf(snap: Snapshot, ids: string[]): Item[] {
  return ids
    .map((id) => snap.byId.get(id))
    .filter((x): x is Item => !!x)
    .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));
}

/**
 * Cached try-on for a combination worn this way (layer order, styling); items without a picture are not part of
 * try-ons, so they are left out of the key.
 */
/** The made-up try-on when there is one, else the same outfit without makeup. */
export function tryonFor(snap: Snapshot, ids: string[], styling: Record<string, Styling> = {}, makeup?: string | null): string | null {
  const drawable = ids.filter((id) => {
    const it = snap.byId.get(id);
    return !!it && !!(it.catalogUri ?? it.originalUri);
  });
  const slotOf = (id: string) => snap.byId.get(id)?.slot;
  return (makeup ? snap.tryons.get(lookKey(drawable, styling, slotOf, makeup)) : null) ?? snap.tryons.get(lookKey(drawable, styling, slotOf)) ?? null;
}

/** A wear log as it was worn: the linked outfit's layering if it is the same garments, else tops under outerwear. */
export function tryonForLog(snap: Snapshot, log: WearLog): string | null {
  const o = log.outfitId ? snap.outfits.find((x) => x.id === log.outfitId) : undefined;
  if (o && o.itemIds.length === log.itemIds.length && o.itemIds.every((id) => log.itemIds.includes(id))) return tryonFor(snap, o.itemIds, o.styling, o.makeup);
  return tryonFor(snap, lookFromGarments(itemsOf(snap, log.itemIds)).ids);
}
