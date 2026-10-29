import type { ImageStore } from '@/ai/imageStore';
import type { ArchiveReader, ArchiveWriter } from '@/state/archive';

/** The web preview has no persistent storage to back up. */
export async function pickNewBackupFile(_images: ImageStore): Promise<{ storage: ArchiveWriter; name: string; verify(): Promise<void>; discard(): void } | null> {
  return null;
}

export async function pickBackupFile(_images: ImageStore): Promise<ArchiveReader | null> {
  return null;
}

export const BACKUP_SUPPORTED = false;
