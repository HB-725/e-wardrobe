import type { Box } from './crop';

export type Slot = 'outer' | 'top' | 'bottom' | 'shoes' | 'bag' | 'accessory';

/** `pick`: the photo shows several garments; the user chooses which ones to keep. */
export type ItemStatus = 'processing' | 'review' | 'active' | 'failed' | 'archived' | 'pick';

export type FieldSource = 'ai' | 'tag' | 'user';

export interface FidelityCheck {
  label: string;
  ok: boolean;
  note: string;
}

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/** One garment the AI found on a photo with several (an item in `pick`). */
export interface Detection {
  box: Box;
  selected: boolean;
  /** Drawn by the user: the fields below are placeholders until the crop is recognised. */
  manual: boolean;
  /** Moved far from the AI box, so the AI fields may describe something else. */
  edited: boolean;
  /** Text printed on it, for the catalog prompt; not stored on the item. */
  printText?: string | null;
  name: string;
  slot: Slot;
  subcategory: string | null;
  colorName: string | null;
  colorHex: string | null;
  seasons: Season[];
  brand: string | null;
  size: string | null;
  material: string | null;
}

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
  /** What the photo showed at intake, in English for the image models; `fit` only when the owner wore it there. */
  look: GarmentLook | null;
  /** How it fits its owner: two taps at intake, or measured centimetres (flat widths for chest and waist). */
  fit: Fit | null;
  status: ItemStatus;
  originalUri: string | null;
  catalogUri: string | null;
  tagUri: string | null;
  /** The whole photo when `originalUri` is a crop of it; shared by every garment cut from it. */
  sourceUri: string | null;
  /** Where `originalUri` sits on `sourceUri`. */
  crop: Box | null;
  /** Garments found on the photo while the item is in `pick`. */
  detections: Detection[];
  /** Generated catalog images waiting for the user to pick one (the review step). */
  candidates: string[];
  /** Fidelity checklist per candidate, same order as `candidates`. */
  checks: FidelityCheck[][];
  fieldSources: Partial<Record<keyof Item, FieldSource>>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** How an upper-body layer is worn; unset leaves it to the picture. */
export interface Styling {
  open?: boolean;
  tucked?: boolean;
}

export interface Outfit {
  id: string;
  name: string;
  occasions: string[];
  /** Upper-body garments innermost first (see domain/look). */
  itemIds: string[];
  styling: Record<string, Styling>;
  /** See domain/makeup. */
  makeup: string | null;
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

export interface GarmentLook {
  colour: string;
  material: string;
  cut: string;
  details: string;
  prints: string;
  wear: string;
  creases: string;
  fit?: string;
}

export interface Fit {
  width?: 'loose' | 'regular' | 'tight' | null;
  length?: 'short' | 'regular' | 'long' | null;
  cm?: Partial<Record<'shoulder' | 'chest' | 'length' | 'sleeve' | 'waist' | 'outseam' | 'hem', number>> | null;
}

/** One garment painted onto the avatar (one view, closed or worn open), keyed out so it stacks on the avatar picture. */
export interface GarmentLayer {
  itemId: string;
  avatarVersion: string;
  view: 'front' | 'back';
  variant: 'closed' | 'open';
  uri: string;
}

export interface Avatar {
  frontUri: string | null;
  backUri: string | null;
  /** The same pictures with the base clothes in flat chroma green: garments are painted onto these (see domain/layers). */
  greenFrontUri: string | null;
  greenBackUri: string | null;
  sourceUris: string[];
  heightCm: number | null;
  weightKg: number | null;
  build: string | null;
  shoulderCm: number | null;
  chestCm: number | null;
  waistCm: number | null;
  status: 'none' | 'processing' | 'ready' | 'failed';
  error: string | null;
  updatedAt: string | null;
}

export type JobType = 'catalog' | 'autofill' | 'avatar' | 'tryon' | 'mirror' | 'layer';

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
  kind: JobType | 'photo' | 'other';
  model: string;
  costUsd: number;
  createdAt: string;
}
