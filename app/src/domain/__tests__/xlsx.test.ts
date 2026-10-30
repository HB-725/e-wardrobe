import * as XLSX from 'xlsx';
import { base64ToBytes, bytesToBase64, parseCsv, readXlsx, serialToDateKey, writeXlsx } from '../xlsx';

describe('xlsx', () => {
  it('writes workbooks that SheetJS (and so Excel) reads back', () => {
    const bytes = writeXlsx([
      { name: '单品', rows: [['名称', '价格', '备注'], ['白衬衫 & <领>', 199.5, '第一行\n第二行'], ['😀 emoji', 0, '']] },
      { name: 'a/b:c', rows: [['x']] },
    ]);
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toEqual(['单品', 'a b c']);
    expect(XLSX.utils.sheet_to_json(wb.Sheets['单品'], { defval: '' })).toEqual([
      { 名称: '白衬衫 & <领>', 价格: 199.5, 备注: '第一行\n第二行' },
      { 名称: '😀 emoji', 价格: 0, 备注: '' },
    ]);
  });

  it('reads workbooks written by SheetJS with shared strings, gaps and dates', () => {
    const ws = XLSX.utils.aoa_to_sheet([['名称', '价格', '', '购买日期'], ['夹克', 399, '', new Date(Date.UTC(2025, 8, 14))], [], ['T恤', '99', 'x']], { cellDates: false });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['other']]), '第二页');
    const bytes = new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', bookSST: true }));
    const { sheets } = readXlsx(bytes);
    expect(sheets.map((s) => s.name)).toEqual(['Sheet1', '第二页']);
    const rows = sheets[0].rows;
    expect(rows[0]).toEqual(['名称', '价格', '', '购买日期']);
    expect(rows[1].slice(0, 2)).toEqual(['夹克', 399]);
    expect(serialToDateKey(rows[1][3] as number)).toBe('2025-09-14');
    expect(rows[2]).toEqual([]);
    expect(rows[3]).toEqual(['T恤', '99', 'x']);
  });

  it('round-trips base64 and refuses non-xlsx input', () => {
    const data = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
    for (let n = 0; n <= data.length; n++) expect(base64ToBytes(bytesToBase64(data.subarray(0, n)))).toEqual(data.subarray(0, n));
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe(Buffer.from('hi').toString('base64'));
    expect(() => readXlsx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toThrow('old-xls');
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow('not-xlsx');
  });

  it('parses CSV with quotes, separators and line breaks', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"multi\nline",2\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['multi\nline', '2'],
    ]);
    expect(parseCsv('名称;品类\n衬衫;上衣')).toEqual([['名称', '品类'], ['衬衫', '上衣']]);
  });

  it('converts Excel serial dates', () => {
    expect(serialToDateKey(45000)).toBe('2023-03-15');
    expect(serialToDateKey(61)).toBe('1900-03-01');
  });
});

describe('xlsx from other generators', () => {
  const { zipSync, strToU8 } = require('fflate') as typeof import('fflate');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  it('reads prefixed (Open XML SDK style) parts, 1904 dates, and skips empty trailing rows', () => {
    const bytes = zipSync({
      'xl/workbook.xml': strToU8(`<x:workbook xmlns:x="${ns}" xmlns:rel="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:workbookPr date1904="1"/><x:sheets><x:sheet name="单品" sheetId="1" rel:id="rId7"/></x:sheets></x:workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="x" Target="/xl/worksheets/data.xml"/></Relationships>'),
      'xl/sharedStrings.xml': strToU8(`<x:sst xmlns:x="${ns}"><x:si><x:t>名称</x:t></x:si><x:si><x:r><x:t>白</x:t></x:r><x:r><x:t>衬衫</x:t></x:r></x:si></x:sst>`),
      'xl/worksheets/data.xml': strToU8(`<x:worksheet xmlns:x="${ns}"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="inlineStr"><x:is><x:t>购买日期</x:t></x:is></x:c></x:row><x:row r="2"><x:c r="A2" t="s"><x:v>1</x:v></x:c><x:c r="B2"><x:v>44000</x:v></x:c></x:row><x:row r="1048576"/></x:sheetData></x:worksheet>`),
    });
    const { sheets, date1904 } = readXlsx(bytes);
    expect(date1904).toBe(true);
    expect(sheets[0].rows).toEqual([['名称', '购买日期'], ['白衬衫', 44000]]);
    expect(serialToDateKey(44000, true)).toBe('2024-06-19'); // = 1900-system serial 45462
  });

  it('refuses parts that unpack to an unreasonable size', () => {
    const big = new Uint8Array(31 * 1024 * 1024).fill(32);
    const bytes = zipSync({ 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': big }, { level: 1 });
    expect(bytes.length).toBeLessThan(1024 * 1024);
    expect(() => readXlsx(bytes)).toThrow('too-large');
  });
});
