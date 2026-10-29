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

/** Lets the user pick a spreadsheet; resolves to its base64 contents, or null if cancelled. */
export async function pickSpreadsheet(): Promise<{ name: string; base64: string } | null> {
  const r = await DocumentPicker.getDocumentAsync({
    type: [XLSX_MIME, 'application/vnd.ms-excel', 'text/csv', '*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (r.canceled || !r.assets?.[0]) return null;
  const asset = r.assets[0];
  return { name: asset.name, base64: await new File(asset.uri).base64() };
}
