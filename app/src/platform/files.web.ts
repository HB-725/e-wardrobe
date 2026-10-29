export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function download(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.click();
}

export async function shareBase64File(name: string, base64: string, mimeType: string): Promise<void> {
  download(`data:${mimeType};base64,${base64}`, name);
}

export async function shareImage(uri: string): Promise<void> {
  download(uri, 'photo.jpg');
}

export async function saveImageToLibrary(uri: string): Promise<boolean> {
  download(uri, 'photo.jpg');
  return true;
}

export async function pickSpreadsheet(): Promise<{ name: string; base64: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls,.csv';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const r = new FileReader();
      r.onload = () => resolve({ name: f.name, base64: String(r.result).split(',')[1] ?? '' });
      r.readAsDataURL(f);
    };
    input.click();
  });
}
