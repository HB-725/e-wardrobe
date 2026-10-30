/** White page, #F1F1F2 cards (also the AI image background), soft corners (style S1). */
export const C = {
  bg: '#FFFFFF',
  card: '#F1F1F2',
  ink: '#111111',
  sub: '#6B6B6B',
  line: '#E8E8EA',
  lineSoft: '#F0F0F1',
  muted: '#C9C9CC',
  faint: '#8E8E93',
  danger: '#B3261E',
  ok: '#2E7D4F',
  warn: '#B26A00',
  overlay: 'rgba(17,17,17,0.45)',
  scrim: 'rgba(17,17,17,0.72)',
} as const;

export const PAD = 20;

/** Corner radii; components take them from here rather than writing numbers. */
export const R = {
  /** cards, panels, large pictures, the fitting stage, Today and outfit cards */
  card: 14,
  /** garment tiles, collage tiles, fitting tray pictures */
  tile: 10,
  /** list thumbnails, calendar day pictures */
  small: 8,
  sheet: 20,
  dialog: 16,
  input: 10,
  /** buttons, category tabs, badges, toast */
  pill: 999,
} as const;
