import { Directory, File, Paths } from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { newId } from '@/db/db';

function imagesDir(): Directory {
  const dir = new Directory(Paths.document, 'images');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Downscale a picked/captured photo and copy it into app storage (photos can be 12MP; AI needs ~1.5k px). */
export async function importPhoto(
  uri: string,
  size?: { width: number; height: number },
  maxSide = 1536,
): Promise<string> {
  const actions: { resize: { width?: number; height?: number } }[] = [];
  if (size && Math.max(size.width, size.height) > maxSide) {
    actions.push({ resize: size.width >= size.height ? { width: maxSide } : { height: maxSide } });
  }
  const out = await manipulateAsync(uri, actions, { compress: 0.86, format: SaveFormat.JPEG });
  const dest = new File(imagesDir(), `${newId()}.jpg`);
  new File(out.uri).copySync(dest);
  return dest.uri;
}

export function saveBase64Image(b64: string, ext: 'jpg' | 'png' = 'jpg'): string {
  const dest = new File(imagesDir(), `${newId()}.${ext}`);
  dest.create({ overwrite: true });
  dest.writeSync(b64, { encoding: 'base64' });
  return dest.uri;
}

export async function readBase64(uri: string): Promise<string> {
  return new File(uri).base64();
}

export function deleteImage(uri: string | null | undefined): void {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // Already gone; nothing to clean up.
  }
}

export function deleteAllImages(): void {
  const dir = new Directory(Paths.document, 'images');
  if (dir.exists) dir.delete();
}

export function fileExists(uri: string | null | undefined): boolean {
  if (!uri) return false;
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

export function imageInput(uri: string): { uri: string; name: string; type: string } {
  const name = uri.split('/').pop() ?? 'image.jpg';
  return { uri, name, type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' };
}
