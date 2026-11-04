import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { imageExt, type ImageStore } from '@/ai/imageStore';
import { toPixels } from '@/domain/crop';

/** Web build is only used for previews: images are kept as data URLs inside the database. */
async function toDataUrl(uri: string): Promise<string> {
  if (uri.startsWith('data:')) return uri;
  const blob = await (await fetch(uri)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export const nativeImages: ImageStore = {
  toDataUrl: (uri) => toDataUrl(uri),
  async saveBase64(b64) {
    const ext = imageExt(b64);
    return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64}`;
  },
  importPhoto: (uri) => toDataUrl(uri),
  async crop(uri, box) {
    const full = await ImageManipulator.manipulate(uri).renderAsync();
    const ref = await ImageManipulator.manipulate(full).crop(toPixels(box, full.width, full.height)).renderAsync();
    const r = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.9, base64: true });
    return `data:image/jpeg;base64,${r.base64}`;
  },
  async remove() {},
  async wipe() {},
};
