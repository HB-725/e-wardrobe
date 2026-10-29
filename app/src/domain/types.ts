export type Slot = 'outer' | 'top' | 'bottom' | 'shoes' | 'bag' | 'accessory';

export type ItemStatus = 'processing' | 'review' | 'active' | 'failed' | 'archived';

export type FieldSource = 'ai' | 'tag' | 'user';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

export interface Item {
  id: string;
  name: string;
  slot: Slot;
  subcategory: string | null;
  colorName: string | null;
  colorHex: string | null;
  seasons: Season[];
  brand: string | null;
  size: string | null;
  material: string | null;
  priceCents: number | null;
  purchasedOn: string | null;
  channel: string | null;
  location: string | null;
  fitNotes: string | null;
  status: ItemStatus;
  originalUri: string | null;
  catalogUri: string | null;
  tagUri: string | null;
  fieldSources: Partial<Record<keyof Item, FieldSource>>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Outfit {
  id: string;
  name: string;
  occasions: string[];
  itemIds: string[];
  createdAt: string;
}

export type TryonView = 'front' | 'back';

export type WearSource = 'manual' | 'outfit' | 'mirror';

export interface WearLog {
  id: string;
  date: string;
  outfitId: string | null;
  source: WearSource;
  photoUri: string | null;
  itemIds: string[];
  createdAt: string;
}

export interface Avatar {
  frontUri: string | null;
  backUri: string | null;
  sourceUris: string[];
  heightCm: number | null;
  weightKg: number | null;
  build: string | null;
  status: 'none' | 'processing' | 'ready' | 'failed';
  error: string | null;
  updatedAt: string | null;
}

export type JobType = 'catalog' | 'autofill' | 'avatar' | 'tryon' | 'mirror';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  type: JobType;
  refId: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  lastError: string | null;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UsageEntry {
  id: string;
  kind: JobType | 'other';
  model: string;
  costUsd: number;
  createdAt: string;
}
