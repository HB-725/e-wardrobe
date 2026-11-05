import type { Box } from '@/domain/crop';

/** Where photos and generated images live. Native uses the app's document directory; tests use memory. */
export type ImageFolder = 'original' | 'tag' | 'body' | 'mirror' | 'catalog' | 'avatar' | 'tryon' | 'photo' | 'layer';

export interface ImageStore {
  /** Data URL (JPEG, or WEBP when the source has transparency), downscaled so the long edge is at most `maxEdge`. */
  toDataUrl(uri: string, maxEdge: number): Promise<string>;
  /** Persist base64 image data under the file type it holds (see imageExt), returns its uri. */
  saveBase64(b64: string, folder: ImageFolder): Promise<string>;
  /** Copy a camera / picker photo into app storage (downscaled to a sensible size), returns its uri. */
  importPhoto(uri: string, folder: ImageFolder): Promise<string>;
  /** Save the part of a stored photo inside `box` as a new image, returns its uri. */
  crop(uri: string, box: Box, folder: ImageFolder): Promise<string>;
  /** Pixel size of a stored image. */
  size(uri: string): Promise<{ width: number; height: number }>;
  /** A garment painted onto the green avatar (base64 from the model) → its keyed layer as PNG (see domain/layers); returns its uri. */
  layer(dressedB64: string, greenUri: string, box: Box): Promise<string>;
  remove(uri: string | null | undefined): Promise<void>;
  /** Delete every stored image (privacy wipe). */
  wipe(): Promise<void>;
  /** Stored images with their modification time (ms), for orphan cleanup. Optional (web / tests). */
  listAll?(): Promise<{ uri: string; modified: number }[]>;
}

export type ImageExt = 'jpg' | 'png' | 'webp';

/** File type of base64 image data, from its first bytes: OpenAI answers JPEG or WEBP, Gemini PNG. */
export function imageExt(b64: string): ImageExt {
  return b64.startsWith('iVBOR') ? 'png' : b64.startsWith('UklGR') ? 'webp' : 'jpg';
}
