/**
 * Just enough of the .xlsx format for the wardrobe export and import: write a workbook of plain text / number
 * sheets, and read the cell values of any sheet written by Excel, WPS, Numbers, Google Sheets or LibreOffice.
 * (Replaces SheetJS, whose fixed versions are not published on npm.) Plus RFC 4180 CSV parsing.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export type Cell = string | number;

export interface Sheet {
  name: string;
  rows: Cell[][];
}

export class XlsxError extends Error {}

// ---------- base64 ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c.charCodeAt(0), i]));

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  const at = (i: number) => (i < clean.length ? B64_INDEX.get(clean.charCodeAt(i))! : 0);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = (at(i) << 18) | (at(i + 1) << 12) | (at(i + 2) << 6) | at(i + 3);
    out[o++] = (v >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (v >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = v & 255;
  }
  return out.subarray(0, o);
}

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    parts.push(B64[(v >> 18) & 63], B64[(v >> 12) & 63], i + 1 < bytes.length ? B64[(v >> 6) & 63] : '=', i + 2 < bytes.length ? B64[v & 63] : '=');
  }
  return parts.join('');
}

// ---------- writing ----------

function esc(s: string): string {
  // Control characters other than tab / newline are not allowed in XML 1.0.
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          const ref = `${colName(c)}${r + 1}`;
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
          const s = String(v ?? '');
          return s ? `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(s)}</t></is></c>` : '';
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/** A sheet name Excel accepts: no []:*?/\, at most 31 characters. */
function sheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
}

export function writeXlsx(sheets: Sheet[]): Uint8Array {
  const ns = 'http://schemas.openxmlformats.org';
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${esc(sheetName(s.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${sheets.length + 1}" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${ns}/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`,
    ),
  };
  sheets.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows))));
  return zipSync(files, { level: 6 });
}

// ---------- reading ----------

function unesc(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e];
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? unesc(m[1]) : null;
}

/** The relationship id of a <sheet>, whatever prefix its namespace was given (r:id, ns1:id...). */
function relId(tag: string): string | null {
  const m = tag.match(/(?:^|\s)[A-Za-z_][\w.-]*:id="([^"]*)"/);
  return m ? unesc(m[1]) : null;
}

/** Some generators (.NET Open XML SDK, some Java / Python libraries) write <x:row> etc.: drop element prefixes. */
function plain(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:(?=[A-Za-z_])/g, '<$1');
}

/** Past these, a "spreadsheet" is not a wardrobe list (and would exhaust a phone's memory once unpacked). */
const MAX_PART_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_ROWS = 20_000;

/** All text of <t> elements inside a fragment (rich text runs are joined; phonetic hints are dropped). */
function texts(xml: string): string {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map((m) => unesc(m[1] ?? '')).join('');
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readCells(xml: string, shared: string[]): Cell[][] {
  const rows: Cell[][] = [];
  let nextRow = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(rm[1], 'r') ?? nextRow + 1) - 1;
    nextRow = r + 1;
    // Empty rows (Excel sometimes leaves a formatted row 1048576) are skipped instead of padding the array.
    if (!rm[2] || r >= MAX_ROWS) continue;
    const row: Cell[] = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], 'r');
      const c = ref ? colIndex(ref) : nextCol;
      nextCol = c + 1;
      const t = attr(cm[1], 't');
      const inner = cm[2] ?? '';
      const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      let value: Cell = '';
      if (t === 's') value = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') value = texts(inner);
      else if (t === 'str' || t === 'e') value = v !== undefined ? unesc(v) : '';
      else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) {
        const n = Number(v);
        value = Number.isFinite(n) ? n : unesc(v);
      }
      row[c] = value;
    }
    rows[r] = Array.from(row, (x) => x ?? '');
  }
  return Array.from(rows, (x) => x ?? []);
}

function resolve(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}

export function readXlsx(bytes: Uint8Array): { sheets: Sheet[]; date1904: boolean } {
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new XlsxError('old-xls');
  let files: Record<string, Uint8Array>;
  let total = 0;
  let tooLarge = false;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!(f.name.endsWith('.xml') || f.name.endsWith('.rels'))) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_PART_BYTES || total > MAX_TOTAL_BYTES) tooLarge = true;
        return !tooLarge;
      },
    });
  } catch {
    throw new XlsxError('not-xlsx');
  }
  if (tooLarge) throw new XlsxError('too-large');
  const text = (name: string) => (files[name] ? plain(strFromU8(files[name])) : null);
  const wb = text('xl/workbook.xml');
  if (!wb) throw new XlsxError('not-xlsx');
  const rels = new Map<string, string>();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rels.set(id, resolve('xl/workbook.xml', target));
  }
  const shared = [...(text('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => texts(m[1] ?? ''));
  const sheets: Sheet[] = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1], 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = relId(m[1]);
    const path = (rid && rels.get(rid)) || `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const xml = text(path);
    sheets.push({ name, rows: xml ? readCells(xml, shared) : [] });
  }
  // Old Mac Excel and Numbers may count days from 1904.
  return { sheets, date1904: /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb) };
}

/** RFC 4180: quoted fields may contain commas, quotes ("") and line breaks. Also accepts ; or tab separated files. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const sep = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Excel's serial day number to YYYY-MM-DD (1900 date system, or 1904 for workbooks that say so). */
export function serialToDateKey(serial: number, date1904 = false): string {
  // Day 60 is Excel's fictitious 1900-02-29; serials are counted from 1899-12-30 for dates after it.
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(base + Math.floor(serial) * 86_400_000);
  return d.toISOString().slice(0, 10);
}
