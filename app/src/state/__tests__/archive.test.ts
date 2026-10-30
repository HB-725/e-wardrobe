import { ArchiveError, ArchiveReader, ArchiveWriter, type ByteSink, type ByteSource, asciiJson, bytesToAscii, asciiToBytes } from '../archive';

function memoryFile() {
  const chunks: Uint8Array[] = [];
  let closed = false;
  const sink: ByteSink = {
    write: async (b) => {
      if (closed) throw new Error('closed');
      chunks.push(b);
    },
    close: async () => {
      closed = true;
    },
  };
  const bytes = () => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  };
  const source = (data: Uint8Array): ByteSource => ({
    size: async () => data.length,
    read: async (offset, length) => data.slice(offset, offset + length),
    close: async () => {},
  });
  return { sink, bytes, source, isClosed: () => closed };
}

describe('archive', () => {
  it('round-trips text with Chinese characters and binary images', async () => {
    const f = memoryFile();
    const images: Record<string, Uint8Array> = { a: new Uint8Array([0, 255, 128, 7]), b: new Uint8Array(70_000).fill(9) };
    const w = new ArchiveWriter(f.sink, async (uri) => images[uri]);
    await w.putImage('images/00000.jpg', 'a');
    await w.putImage('images/00001.webp', 'b');
    const text = JSON.stringify({ name: '牛仔夹克 · 靛蓝 ✓', emoji: '👕' });
    await w.writeText('backup.json', text);
    expect(f.isClosed()).toBe(true);

    const saved: { bytes: Uint8Array; folder: string; ext: string }[] = [];
    const r = new ArchiveReader(f.source(f.bytes()), async (bytes, folder, ext) => {
      saved.push({ bytes, folder, ext });
      return `saved-${saved.length}`;
    });
    expect(await r.readText('backup.json')).toBe(text);
    expect(await r.getImage('images/00001.webp', 'catalog')).toBe('saved-1');
    expect(saved[0].ext).toBe('webp');
    expect(saved[0].bytes.length).toBe(70_000);
    await r.getImage('images/00000.jpg', 'original');
    expect([...saved[1].bytes]).toEqual([0, 255, 128, 7]);
    await expect(r.getImage('images/missing.jpg', 'original')).rejects.toBeInstanceOf(ArchiveError);
  });

  it('rejects files that are not backups or were cut off', async () => {
    const f = memoryFile();
    const w = new ArchiveWriter(f.sink, async () => new Uint8Array([1, 2, 3]));
    await w.putImage('images/00000.jpg', 'x');
    await w.writeText('backup.json', '{}');
    const full = f.bytes();
    const read = (data: Uint8Array) => new ArchiveReader(f.source(data), async () => '').readText('backup.json');
    await expect(read(full.slice(0, full.length - 5))).rejects.toThrow();
    await expect(read(asciiToBytes('hello, this is just some text file that is long enough'))).rejects.toThrow('不是衣橱的备份文件');
    await expect(read(new Uint8Array(3))).rejects.toThrow('不是衣橱的备份文件');
  });

  it('escapes JSON to pure ASCII', () => {
    const s = asciiJson({ a: '衣橱' });
    expect(/^[\x00-\x7f]*$/.test(s)).toBe(true);
    expect(JSON.parse(bytesToAscii(asciiToBytes(s)))).toEqual({ a: '衣橱' });
  });
});
