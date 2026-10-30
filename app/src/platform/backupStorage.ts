import { Directory, File, FileMode } from 'expo-file-system';
import type { ImageStore } from '@/ai/imageStore';
import { ArchiveReader, ArchiveWriter, BACKUP_EXTENSION, type ByteSink, type ByteSource } from '@/state/archive';
import { saveImageBytes } from './images';

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function sinkFor(file: File): ByteSink {
  const h = file.open(FileMode.WriteOnly);
  return {
    write: (bytes) => h.writeBytes(bytes),
    close: async () => h.close(),
  };
}

function sourceFor(file: File): ByteSource {
  const h = file.open(FileMode.ReadOnly);
  return {
    size: async () => h.size ?? 0,
    read: async (offset, length) => {
      h.offset = offset;
      const out = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const chunk = await h.readBytes(length - got);
        if (chunk.length === 0) break;
        out.set(chunk, got);
        got += chunk.length;
      }
      return got === length ? out : out.subarray(0, got);
    },
    close: async () => h.close(),
  };
}

export interface NewBackup {
  storage: ArchiveWriter;
  name: string;
  /** Re-reads the finished file so a backup that cannot be restored is reported now, not on the new phone. */
  verify(): Promise<void>;
  /** Removes a half-written file after a failure. */
  discard(): void;
}

/** Asks for a folder (phone or cloud drive) and creates one backup file in it. Null if cancelled. */
export async function pickNewBackupFile(_images: ImageStore): Promise<NewBackup | null> {
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync();
  } catch {
    return null;
  }
  const file = dir.createFile(`衣橱备份-${stamp()}.${BACKUP_EXTENSION}`, 'application/octet-stream');
  const storage = new ArchiveWriter(sinkFor(file), (uri) => new File(uri).bytes());
  return {
    storage,
    name: file.name,
    async verify() {
      const r = new ArchiveReader(sourceFor(new File(file.uri)), saveImageBytes);
      try {
        JSON.parse(await r.readText('backup.json'));
      } finally {
        await r.close();
      }
    },
    discard() {
      try {
        if (file.exists) file.delete();
      } catch {
        // provider does not allow deleting; leave it
      }
    },
  };
}

/** Asks for a backup file. Null if cancelled. */
export async function pickBackupFile(_images: ImageStore): Promise<ArchiveReader | null> {
  const r = await File.pickFileAsync();
  if (r.canceled || !r.result) return null;
  return new ArchiveReader(sourceFor(r.result), saveImageBytes);
}

export const BACKUP_SUPPORTED = true;
