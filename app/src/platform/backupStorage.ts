import { Directory, File } from 'expo-file-system';
import type { ImageStore } from '@/ai/imageStore';
import type { BackupStorage } from '@/state/backup';

/** Backup folder on the phone (or a cloud drive) chosen through the system folder picker. */
class FolderStorage implements BackupStorage {
  private imagesDir: Directory | null = null;
  private index: Map<string, File> | null = null;
  constructor(
    private readonly dir: Directory,
    private readonly images: ImageStore,
  ) {}

  private find(dir: Directory, name: string): File | Directory | undefined {
    return dir.list().find((e) => e.name === name);
  }

  async writeText(name: string, text: string) {
    const f = this.dir.createFile(name, 'application/json');
    await f.write(text);
  }

  async readText(name: string) {
    const f = this.find(this.dir, name);
    if (!(f instanceof File)) throw new Error(`${name} not found`);
    return f.text();
  }

  async putImage(name: string, sourceUri: string) {
    if (!this.imagesDir) this.imagesDir = this.dir.createDirectory('images');
    const base = name.replace(/^images\//, '');
    const f = this.imagesDir.createFile(base, base.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    await f.write(await new File(sourceUri).bytes());
  }

  async getImage(name: string, folder: Parameters<BackupStorage['getImage']>[1]) {
    if (!this.index) {
      const sub = this.find(this.dir, 'images');
      this.index = new Map(sub instanceof Directory ? sub.list().filter((e): e is File => e instanceof File).map((f) => [f.name, f]) : []);
    }
    const base = name.replace(/^images\//, '');
    const f = this.index.get(base);
    if (!f) throw new Error(`备份里缺少图片 ${base}`);
    return this.images.saveBase64(await f.base64(), folder, base.endsWith('.webp') ? 'webp' : 'jpg');
  }
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Asks for a parent folder and creates a dated backup folder inside it. Null if the user cancelled. */
export async function pickNewBackupFolder(images: ImageStore): Promise<{ storage: BackupStorage; name: string } | null> {
  let parent: Directory;
  try {
    parent = await Directory.pickDirectoryAsync();
  } catch {
    return null;
  }
  const name = `衣橱备份-${stamp()}`;
  return { storage: new FolderStorage(parent.createDirectory(name), images), name };
}

/** Asks for an existing backup folder (the one containing backup.json). Null if cancelled. */
export async function pickExistingBackupFolder(images: ImageStore): Promise<BackupStorage | null> {
  try {
    return new FolderStorage(await Directory.pickDirectoryAsync(), images);
  } catch {
    return null;
  }
}

export const BACKUP_SUPPORTED = true;
