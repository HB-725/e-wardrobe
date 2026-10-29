import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImageFolder, ImageStore } from '@/ai/imageStore';
import { newId } from '@/db/db';

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

  async saveBase64(b64, folder, ext = 'jpg') {
    const file = new File(folderDir(folder), `${newId()}.${ext}`);
    file.create({ overwrite: true });
    await file.write(b64, { encoding: 'base64' });
    return file.uri;
  },

  async importPhoto(uri, folder) {
    const r = await render(uri, 1600, false);
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

  async remove(uri) {
    if (!uri || !uri.startsWith('file:')) return;
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // already gone
    }
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
