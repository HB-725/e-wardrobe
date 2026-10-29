import type { ImageStore } from '@/ai/imageStore';
import type { BackupStorage } from '@/state/backup';

/** The web preview has no persistent storage to back up. */
export async function pickNewBackupFolder(_images: ImageStore): Promise<{ storage: BackupStorage; name: string } | null> {
  return null;
}

export async function pickExistingBackupFolder(_images: ImageStore): Promise<BackupStorage | null> {
  return null;
}

export const BACKUP_SUPPORTED = false;
