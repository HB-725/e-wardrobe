import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { type ImageExt, imageExt, type ImageFolder, type ImageStore } from '@/ai/imageStore';
import { newId } from '@/db/db';
import { toPixels } from '@/domain/crop';
import { decodeImage, layerPng } from '@/domain/layers';

const ROOT = 'images';

function folderDir(folder: ImageFolder): Directory {
  const dir = new Directory(Paths.document, ROOT, folder);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function hasAlpha(uri: string): boolean {
  return /\.(webp|png)(\?|$)/i.test(uri);
}

/** At most this many images are decoded at once (mirror matching sends dozens). */
const MAX_DECODES = 3;
let decoding = 0;
const waiting: (() => void)[] = [];
async function withDecodeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (decoding >= MAX_DECODES) await new Promise<void>((r) => waiting.push(r));
  decoding += 1;
  try {
    return await fn();
  } finally {
    decoding -= 1;
    waiting.shift()?.();
  }
}

/** Decodes downsampled (never the full camera resolution, which can exhaust native memory) and re-encodes. */
function render(uri: string, maxEdge: number, base64: boolean, keepAlpha = false) {
  return withDecodeSlot(async () => {
    const ref = await ImageManipulator.manipulate(uri, { maxWidth: maxEdge, maxHeight: maxEdge }).renderAsync();
    try {
      return await ref.saveAsync({ format: keepAlpha ? SaveFormat.WEBP : SaveFormat.JPEG, compress: 0.85, base64 });
    } finally {
      ref.release();
    }
  });
}

function isCacheFile(uri: string): boolean {
  return uri.startsWith(Paths.cache.uri);
}

/** Writes raw image bytes (restored from a backup) into app storage. */
export async function saveImageBytes(bytes: Uint8Array, folder: ImageFolder, ext: ImageExt): Promise<string> {
  const file = new File(folderDir(folder), `${newId()}.${ext}`);
  file.create({ overwrite: true });
  try {
    await file.write(bytes);
  } catch (e) {
    if (file.exists) file.delete();
    throw e;
  }
  return file.uri;
}

/** Photos and generated images live under the app's private document directory (removed on uninstall). */
export const nativeImages: ImageStore = {
  async toDataUrl(uri, maxEdge) {
    const alpha = hasAlpha(uri);
    const r = await render(uri, maxEdge, true, alpha);
    // The encoded copy in the cache is not needed once we hold the base64.
    try {
      new File(r.uri).delete();
    } catch {
      // ignore
    }
    return `data:image/${alpha ? 'webp' : 'jpeg'};base64,${r.base64}`;
  },

  async saveBase64(b64, folder) {
    const file = new File(folderDir(folder), `${newId()}.${imageExt(b64)}`);
    file.create({ overwrite: true });
    try {
      await file.write(b64, { encoding: 'base64' });
    } catch (e) {
      // Do not leave a half-written file behind (disk full).
      if (file.exists) file.delete();
      throw e;
    }
    return file.uri;
  },

  async importPhoto(uri, folder) {
    // Garment photos keep more pixels: the AI may later get only a crop of them (one garment of an outfit photo).
    const r = await render(uri, folder === 'original' ? 2048 : 1600, false);
    const dest = new File(folderDir(folder), `${newId()}.jpg`);
    await new File(r.uri).move(dest);
    // Camera shots and picker copies land in the cache; do not leave a second copy behind.
    if (isCacheFile(uri)) {
      try {
        const src = new File(uri);
        if (src.exists) src.delete();
      } catch {
        // ignore
      }
    }
    return dest.uri;
  },

  async crop(uri, box, folder) {
    const r = await withDecodeSlot(async () => {
      const full = await ImageManipulator.manipulate(uri, { maxWidth: 4096, maxHeight: 4096 }).renderAsync();
      try {
        const ref = await ImageManipulator.manipulate(full).crop(toPixels(box, full.width, full.height)).renderAsync();
        try {
          return await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
        } finally {
          ref.release();
        }
      } finally {
        full.release();
      }
    });
    const dest = new File(folderDir(folder), `${newId()}.jpg`);
    await new File(r.uri).move(dest);
    return dest.uri;
  },

  async size(uri) {
    const { width, height } = decodeImage(await new File(uri).bytes());
    return { width, height };
  },

  async layer(dressedB64, greenUri, box) {
    // Decoded and keyed in JS (jpeg-js / upng-js): about a second for 1024×1536 on a phone, in the job queue.
    const dressed = Uint8Array.from(atob(dressedB64), (c) => c.charCodeAt(0));
    return saveImageBytes(layerPng(dressed, await new File(greenUri).bytes(), box), 'layer', 'png');
  },

  async remove(uri) {
    if (!uri || !uri.startsWith('file:')) return;
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // already gone
    }
  },

  async listAll() {
    const root = new Directory(Paths.document, ROOT);
    if (!root.exists) return [];
    const out: { uri: string; modified: number }[] = [];
    for (const dir of root.list()) {
      if (!(dir instanceof Directory)) continue;
      for (const f of dir.list()) if (f instanceof File) out.push({ uri: f.uri, modified: f.lastModified ?? Date.now() }); // unknown time: treat as new, keep it
    }
    return out;
  },

  async wipe() {
    const dir = new Directory(Paths.document, ROOT);
    if (dir.exists) dir.delete();
    // Camera captures, picker copies and exported spreadsheets.
    for (const entry of Paths.cache.list()) {
      try {
        entry.delete();
      } catch {
        // in use; the OS clears the cache eventually
      }
    }
  },
};
