/**
 * Single-file backup container (".wardrobe"). Storage providers (cloud drives especially) do not reliably keep file
 * names inside a folder, so a backup is one file: image blobs appended one after another, then a JSON index, then a
 * fixed-size footer pointing at the index. Writing is strictly sequential (works with append-only SAF handles);
 * reading uses random access, one image at a time.
 *
 *   [blob 0][blob 1]...[index JSON][footer: "EWBK1" + 16-digit index offset + 16-digit index length]
 */
import type { ImageFolder } from '@/ai/imageStore';
import type { BackupStorage } from './backup';

const MAGIC = 'EWBK1';
const FOOTER_LEN = MAGIC.length + 32;
export const BACKUP_EXTENSION = 'wardrobe';

export interface ByteSink {
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface ByteSource {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Hermes has no reliable TextDecoder; JSON escaped to ASCII is converted byte for byte instead. */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function asciiToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

export function bytesToAscii(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
}

interface Entry {
  offset: number;
  length: number;
}

interface Index {
  texts: Record<string, Entry>;
  images: Record<string, Entry>;
}

/** Writes a backup. `writeText('backup.json', …)` must be the last call; it seals the file. */
export class ArchiveWriter implements BackupStorage {
  private offset = 0;
  private readonly index: Index = { texts: {}, images: {} };
  private sealed = false;

  constructor(
    private readonly sink: ByteSink,
    private readonly readImage: (uri: string) => Promise<Uint8Array>,
  ) {}

  private async append(bytes: Uint8Array): Promise<Entry> {
    const e = { offset: this.offset, length: bytes.length };
    await this.sink.write(bytes);
    this.offset += bytes.length;
    return e;
  }

  async putImage(name: string, sourceUri: string): Promise<void> {
    if (this.sealed) throw new Error('archive already sealed');
    const bytes = await this.readImage(sourceUri);
    this.index.images[name] = await this.append(bytes);
  }

  async writeText(name: string, text: string): Promise<void> {
    if (this.sealed) throw new Error('archive already sealed');
    this.index.texts[name] = await this.append(asciiToBytes(asciiJson(text)));
    const idx = asciiToBytes(asciiJson(this.index));
    const at = this.offset;
    await this.append(idx);
    await this.append(asciiToBytes(`${MAGIC}${String(at).padStart(16, '0')}${String(idx.length).padStart(16, '0')}`));
    this.sealed = true;
    await this.sink.close();
  }

  async readText(): Promise<string> {
    throw new Error('write-only archive');
  }

  async getImage(): Promise<string> {
    throw new Error('write-only archive');
  }
}

export class ArchiveError extends Error {}

/** Reads a backup file. */
export class ArchiveReader implements BackupStorage {
  private index: Index | null = null;

  constructor(
    private readonly source: ByteSource,
    private readonly saveImage: (bytes: Uint8Array, folder: ImageFolder, ext: 'jpg' | 'webp') => Promise<string>,
  ) {}

  private async load(): Promise<Index> {
    if (this.index) return this.index;
    const size = await this.source.size();
    if (size < FOOTER_LEN) throw new ArchiveError('不是衣橱的备份文件');
    const footer = bytesToAscii(await this.source.read(size - FOOTER_LEN, FOOTER_LEN));
    if (!footer.startsWith(MAGIC)) throw new ArchiveError('不是衣橱的备份文件');
    const at = Number(footer.slice(MAGIC.length, MAGIC.length + 16));
    const len = Number(footer.slice(MAGIC.length + 16));
    if (!Number.isFinite(at) || !Number.isFinite(len) || at + len + FOOTER_LEN !== size) throw new ArchiveError('备份文件不完整或已损坏');
    this.index = JSON.parse(bytesToAscii(await this.source.read(at, len))) as Index;
    return this.index;
  }

  async readText(name: string): Promise<string> {
    const e = (await this.load()).texts[name];
    if (!e) throw new ArchiveError(`备份里没有 ${name}`);
    return JSON.parse(bytesToAscii(await this.source.read(e.offset, e.length))) as string;
  }

  async getImage(name: string, folder: ImageFolder): Promise<string> {
    const e = (await this.load()).images[name];
    if (!e) throw new ArchiveError(`备份里缺少图片 ${name}`);
    return this.saveImage(await this.source.read(e.offset, e.length), folder, name.endsWith('.webp') ? 'webp' : 'jpg');
  }

  async writeText(): Promise<void> {
    throw new Error('read-only archive');
  }

  async putImage(): Promise<void> {
    throw new Error('read-only archive');
  }

  close(): Promise<void> {
    return this.source.close();
  }
}
