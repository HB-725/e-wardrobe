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
    const sheets = readXlsx(bytes);
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
