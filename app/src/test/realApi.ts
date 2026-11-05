/** Shared pieces of the real-API tests (skipped unless REAL_AI_DIR is set): a curl-backed fetch and an on-disk image store. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FetchLike } from '@/ai/client';
import { imageExt, type ImageStore } from '@/ai/imageStore';
import type { Box } from '@/domain/crop';
import { decodeImage, layerPng } from '@/domain/layers';

/** Node in Jest has no proxy-aware fetch; curl honours HTTPS_PROXY. `onResponse` sees every request body and answer. */
export function curlFetch(dir: string, onResponse?: (body: string, text: string) => void): FetchLike {
  return async (url, init) => {
    const bodyFile = path.join(dir, `.body-${Date.now()}-${Math.random()}.json`);
    const args = ['-sS', '-X', init.method, url, '-w', '\n%{http_code}'];
    for (const [k, v] of Object.entries(init.headers)) args.push('-H', `${k}: ${v}`);
    if (init.body) {
      fs.writeFileSync(bodyFile, init.body);
      args.push('--data-binary', `@${bodyFile}`);
    }
    try {
      const out = execFileSync('curl', args, { maxBuffer: 200 * 1024 * 1024 }).toString();
      const i = out.lastIndexOf('\n');
      const status = Number(out.slice(i + 1));
      const text = out.slice(0, i);
      onResponse?.(init.body ?? '', text);
      return { ok: status >= 200 && status < 300, status, text: async () => text };
    } finally {
      if (fs.existsSync(bodyFile)) fs.unlinkSync(bodyFile);
    }
  };
}

export class DiskImages implements ImageStore {
  private n = 0;
  constructor(private readonly dir: string) {}
  async toDataUrl(uri: string) {
    const mime = uri.endsWith('.webp') ? 'webp' : uri.endsWith('.png') ? 'png' : 'jpeg';
    return `data:image/${mime};base64,${fs.readFileSync(uri).toString('base64')}`;
  }
  async saveBase64(b64: string, folder: string) {
    const p = path.join(this.dir, 'out', `${folder}-${++this.n}.${imageExt(b64)}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.from(b64, 'base64'));
    return p;
  }
  async importPhoto(uri: string) {
    return uri;
  }
  /** macOS `sips` cuts the box out, as the app does on the phone. */
  async crop(uri: string, box: Box, folder: string) {
    const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', uri]).toString();
    const w = Number(/pixelWidth: (\d+)/.exec(dims)![1]);
    const h = Number(/pixelHeight: (\d+)/.exec(dims)![1]);
    const p = path.join(this.dir, 'out', `${folder}-${++this.n}${path.extname(uri)}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    execFileSync('sips', ['-c', String(Math.round(box.h * h)), String(Math.round(box.w * w)), '--cropOffset', String(Math.round(box.y * h)), String(Math.round(box.x * w)), uri, '--out', p], { stdio: 'ignore' });
    return p;
  }
  async size(uri: string) {
    const { width, height } = decodeImage(new Uint8Array(fs.readFileSync(uri)));
    return { width, height };
  }
  async layer(dressedB64: string, greenUri: string, box: Box) {
    const p = path.join(this.dir, 'out', `layer-${++this.n}.png`);
    fs.writeFileSync(p, layerPng(Buffer.from(dressedB64, 'base64'), new Uint8Array(fs.readFileSync(greenUri)), box));
    return p;
  }
  async remove() {}
  async wipe() {}
}
