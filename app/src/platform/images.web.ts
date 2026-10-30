import type { ImageStore } from '@/ai/imageStore';

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
  async saveBase64(b64, _folder, ext = 'jpg') {
    return `data:image/${ext === 'webp' ? 'webp' : 'jpeg'};base64,${b64}`;
  },
  importPhoto: (uri) => toDataUrl(uri),
  async remove() {},
  async wipe() {},
};
