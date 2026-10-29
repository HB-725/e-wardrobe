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

async function render(uri: string, maxEdge: number, base64: boolean) {
  const ref = await ImageManipulator.manipulate(uri).renderAsync();
  let out = ref;
  if (Math.max(ref.width, ref.height) > maxEdge) {
    const size = ref.width >= ref.height ? { width: maxEdge } : { height: maxEdge };
    out = await ImageManipulator.manipulate(ref).resize(size).renderAsync();
  }
  return out.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64 });
}

/** Photos and generated images live under the app's private document directory (removed on uninstall). */
export const nativeImages: ImageStore = {
  async toDataUrl(uri, maxEdge) {
    const r = await render(uri, maxEdge, true);
    return `data:image/jpeg;base64,${r.base64}`;
  },

  async saveBase64(b64, folder) {
    const file = new File(folderDir(folder), `${newId()}.jpg`);
    file.create({ overwrite: true });
    file.write(b64, { encoding: 'base64' });
    return file.uri;
  },

  async importPhoto(uri, folder) {
    const r = await render(uri, 1600, false);
    const tmp = new File(r.uri);
    const dest = new File(folderDir(folder), `${newId()}.jpg`);
    tmp.move(dest);
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
  },
};
