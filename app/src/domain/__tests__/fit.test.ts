import { fitWords, garmentBrief } from '../fit';
import type { GarmentLook, Item } from '../types';

const look: GarmentLook = { colour: 'Faded black, lighter on the shoulders.', material: 'Heavy cotton fleece.', cut: 'Boxy, cropped.', details: 'Kangaroo pocket.', prints: 'Yellow smiley reading "drew".', wear: 'Sun-faded shoulders.', creases: 'Folds from the floor only.' };
const top = (extra: Partial<Item> = {}): Item => ({ name: '卫衣', slot: 'top', ...extra }) as Item;
const body = { heightCm: 175, weightKg: 64, build: 'slim', shoulderCm: 45, chestCm: 92, waistCm: 78 };

describe('garmentBrief', () => {
  it('is the analysis without the construction and crease lines', () => {
    expect(garmentBrief(look)).toBe('Faded black, lighter on the shoulders. Heavy cotton fleece. Boxy, cropped. Yellow smiley reading "drew". Sun-faded shoulders.');
    expect(garmentBrief(null)).toBeNull();
  });
});

describe('fitWords', () => {
  it('says nothing when nothing is known', () => {
    expect(fitWords(top(), body)).toBeNull();
  });

  it('prefers how the owner wears it in the photo over everything else', () => {
    const it = top({ look: { ...look, fit: 'Shoulder seams drop well past the shoulder; hem at mid-thigh.' }, fit: { width: 'tight', length: 'short' } });
    expect(fitWords(it, body)).toBe('Shoulder seams drop well past the shoulder; hem at mid-thigh.');
  });

  it('works out shoulder drop, chest ease and hem from measured centimetres against the body', () => {
    const it = top({ fit: { cm: { shoulder: 56, chest: 65, length: 88 } } });
    expect(fitWords(it, body)).toBe('Shoulder seams drop about 11 cm below the natural shoulder; very loose through the chest; hem reaches mid-thigh.');
    const slim = top({ fit: { cm: { shoulder: 45, chest: 48, length: 54 } } });
    expect(fitWords(slim, body)).toBe('Shoulder seams sit on the natural shoulder; fitted through the chest; cropped above the waist.');
  });

  it('works out trousers from waist and outseam', () => {
    const it = top({ slot: 'bottom', fit: { cm: { waist: 44, outseam: 100 } } });
    expect(fitWords(it, body)).toBe('Loose at the waist; cropped above the ankle.');
  });

  it('falls back to the two taps the owner made', () => {
    expect(fitWords(top({ fit: { width: 'loose', length: 'long' } }), body)).toBe('Oversized on this person: dropped shoulders and a loose chest; longer than usual, hem past the hips.');
    expect(fitWords(top({ slot: 'bottom', fit: { width: 'tight', length: 'short' } }), body)).toBe('Tight on this person; cropped above the ankle.');
    expect(fitWords(top({ fit: { width: 'regular' } }), body)).toBe('Regular fit on this person.');
  });

  it('estimates the body from height and weight when it was never measured', () => {
    const it = top({ fit: { cm: { shoulder: 56, chest: 65, length: 88 } } });
    expect(fitWords(it, { heightCm: 175, weightKg: 64, build: 'slim' })).toMatch(/^Shoulder seams drop about \d+ cm below the natural shoulder; very loose through the chest; hem reaches mid-thigh\.$/);
  });
});
