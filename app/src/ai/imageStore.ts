/** Where photos and generated images live. Native uses the app's document directory; tests use memory. */
export type ImageFolder = 'original' | 'tag' | 'body' | 'mirror' | 'catalog' | 'avatar' | 'tryon' | 'photo';

export interface ImageStore {
  /** JPEG data URL, downscaled so the long edge is at most `maxEdge` pixels. */
  toDataUrl(uri: string, maxEdge: number): Promise<string>;
  /** Persist a base64 JPEG, returns its uri. */
  saveBase64(b64: string, folder: ImageFolder): Promise<string>;
  /** Copy a camera / picker photo into app storage (downscaled to a sensible size), returns its uri. */
  importPhoto(uri: string, folder: ImageFolder): Promise<string>;
  remove(uri: string | null | undefined): Promise<void>;
  /** Delete every stored image (privacy wipe). */
  wipe(): Promise<void>;
}
