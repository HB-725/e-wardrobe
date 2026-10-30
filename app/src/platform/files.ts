import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { Asset, requestPermissionsAsync } from 'expo-media-library';
import * as Sharing from 'expo-sharing';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Writes a base64 file to the cache and opens the system share sheet (save to Files, send to WeChat, …). */
export async function shareBase64File(name: string, base64: string, mimeType: string): Promise<void> {
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  await file.write(base64, { encoding: 'base64' });
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: name });
}

export async function shareImage(uri: string): Promise<void> {
  await Sharing.shareAsync(uri, { mimeType: 'image/jpeg' });
}

/** Returns false when the user declined the photo library permission. */
export async function saveImageToLibrary(uri: string): Promise<boolean> {
  const perm = await requestPermissionsAsync(true);
  if (!perm.granted) return false;
  await Asset.create(uri);
  return true;
}

export const MAX_SHEET_BYTES = 10 * 1024 * 1024;

/** Lets the user pick a spreadsheet; resolves to its base64 contents (empty if over MAX_SHEET_BYTES), or null if cancelled. */
export async function pickSpreadsheet(): Promise<{ name: string; base64: string; tooBig: boolean } | null> {
  const r = await DocumentPicker.getDocumentAsync({
    type: [XLSX_MIME, 'application/vnd.ms-excel', 'text/csv', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (r.canceled || !r.assets?.[0]) return null;
  const asset = r.assets[0];
  const file = new File(asset.uri);
  // Checked before reading: the whole file is decoded in memory.
  if ((asset.size ?? file.size ?? 0) > MAX_SHEET_BYTES) return { name: asset.name, base64: '', tooBig: true };
  return { name: asset.name, base64: await file.base64(), tooBig: false };
}
