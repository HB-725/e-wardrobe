import type { Avatar, Fit, GarmentLook, Item } from './types';

/** The body the garments are drawn on; measured where the owner typed it, else estimated from height and weight. */
export interface Body {
  heightCm: number | null;
  weightKg: number | null;
  build: string | null;
  shoulderCm?: number | null;
  chestCm?: number | null;
  waistCm?: number | null;
}

// ponytail: average proportions, one knob each; measured values on the avatar always win.
const SHOULDER_OF_HEIGHT = 0.245;
export const TOP_OF_HEIGHT = 0.4; // a regular top's length, shoulder to hem (70 cm at 175 cm)
export const LEG_OF_HEIGHT = 0.62; // waist to floor, a full-length trouser's outseam
const CHEST_AT_60KG = 86;
const WAIST_AT_60KG = 74;

export function bodyOf(a: Pick<Avatar, 'heightCm' | 'weightKg' | 'build'> & Partial<Pick<Body, 'shoulderCm' | 'chestCm' | 'waistCm'>>): Body {
  return { heightCm: a.heightCm, weightKg: a.weightKg, build: a.build, shoulderCm: a.shoulderCm ?? null, chestCm: a.chestCm ?? null, waistCm: a.waistCm ?? null };
}

const measures = (b: Body) => {
  const h = b.heightCm ?? 172;
  const w = b.weightKg ?? 65;
  return {
    shoulder: b.shoulderCm ?? h * SHOULDER_OF_HEIGHT,
    chest: b.chestCm ?? CHEST_AT_60KG + (w - 60) * 0.8,
    waist: b.waistCm ?? WAIST_AT_60KG + (w - 60),
    torso: h * TOP_OF_HEIGHT,
    leg: h * LEG_OF_HEIGHT,
  };
};

/** Picks the first band whose upper bound the value is below. */
const band = (v: number, bands: [number, string][], last: string) => bands.find(([max]) => v < max)?.[1] ?? last;

const sentence = (parts: (string | null)[]) => {
  const s = parts.filter((p): p is string => !!p).join('; ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) + '.' : null;
};

/** Garment centimetres (flat widths for chest and waist) against the body, as the image model needs to hear it. */
function fromCm(slot: Item['slot'], cm: NonNullable<Fit['cm']>, b: Body): string | null {
  const m = measures(b);
  if (slot === 'top' || slot === 'outer') {
    const drop = cm.shoulder != null ? cm.shoulder - m.shoulder : null;
    const ease = cm.chest != null ? cm.chest * 2 - m.chest : null;
    const hem = cm.length != null ? cm.length - m.torso : null;
    return sentence([
      drop == null ? null : drop >= 3 ? `shoulder seams drop about ${Math.round(drop)} cm below the natural shoulder` : drop <= -3 ? 'shoulder seams sit inside the natural shoulder' : 'shoulder seams sit on the natural shoulder',
      ease == null ? null : band(ease, [[-4, 'tight through the chest'], [6, 'fitted through the chest'], [14, 'relaxed through the chest'], [26, 'loose through the chest']], 'very loose through the chest'),
      hem == null ? null : band(hem, [[-14, 'cropped above the waist'], [-6, 'hem at the waist'], [6, 'hem at the hips'], [16, 'hem below the hips']], 'hem reaches mid-thigh'),
    ]);
  }
  if (slot === 'bottom') {
    const ease = cm.waist != null ? cm.waist * 2 - m.waist : null;
    const len = cm.outseam != null ? cm.outseam - m.leg : null;
    return sentence([
      ease == null ? null : band(ease, [[-2, 'tight at the waist'], [4, 'fitted at the waist'], [10, 'relaxed at the waist']], 'loose at the waist'),
      len == null ? null : band(len, [[-12, 'ends mid-calf'], [-4, 'cropped above the ankle'], [4, 'full length to the ankle']], 'stacks on the shoes'),
    ]);
  }
  return null;
}

const WIDTH: Record<string, [string, string]> = {
  // [tops, bottoms]
  loose: ['oversized on this person: dropped shoulders and a loose chest', 'loose on this person'],
  regular: ['regular fit on this person', 'regular fit on this person'],
  tight: ['tight on this person: snug through the chest and shoulders', 'tight on this person'],
};
const LENGTH: Record<string, [string, string]> = {
  short: ['cropped, hem above the hips', 'cropped above the ankle'],
  regular: ['', ''],
  long: ['longer than usual, hem past the hips', 'long, stacking on the shoes'],
};

/**
 * How this garment sits on its owner, for the image model: what a photo of them wearing it shows, else what its
 * measurements say against the body, else the two taps made at intake. Null when nothing is known.
 */
export function fitWords(item: Pick<Item, 'slot' | 'look' | 'fit'>, body: Body): string | null {
  if (item.look?.fit?.trim()) return item.look.fit.trim();
  const fit = item.fit;
  if (!fit) return null;
  if (fit.cm && Object.values(fit.cm).some((v) => v != null)) {
    const s = fromCm(item.slot, fit.cm, body);
    if (s) return s;
  }
  const i = item.slot === 'bottom' ? 1 : 0;
  return sentence([fit.width ? WIDTH[fit.width]?.[i] ?? null : null, fit.length ? LENGTH[fit.length]?.[i] || null : null]);
}

/** The analysis made at intake, minus construction and creases: what a try-on or photo must keep. */
export function garmentBrief(look: GarmentLook | null | undefined): string | null {
  if (!look) return null;
  const s = [look.colour, look.material, look.cut, look.prints, look.wear].map((x) => x?.trim()).filter(Boolean).join(' ');
  return s || null;
}
