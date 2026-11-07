import ExcelJS from 'exceljs';
import type { z } from 'zod';
import type { exportSchema } from '../shared/document.js';

export function cellValue(text: string): ExcelJS.CellValue {
  const value = text.trim();
  const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (date) {
    const [, d, m, y] = date;
    const result = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (result.getUTCDate() === Number(d) && result.getUTCMonth() === Number(m) - 1 && result.getUTCFullYear() === Number(y)) return result;
  }
  // Preserve leading zeros, long IDs, scientific-looking identifiers and formulas as literal text.
  if (/^-?(?:0|[1-9]\d*)(?:[.,]\d+)?$/.test(value) && value.replace(/\D/g, '').length <= 15 && !/^-?0\d/.test(value)) {
    if (value.includes('.') && value.split('.')[1].length > 6) return text;
    return Number(value.replace(',', '.'));
  }
  return text;
}

function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\\/*?:\[\]\x00-\x1f]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Таблица';
  let result = base;
  let suffix = 2;
  while (used.has(result.toLowerCase())) { const end = ` (${suffix++})`; result = base.slice(0, 31 - end.length) + end; }
  used.add(result.toLowerCase());
  return result;
}

export async function exportExcel(input: z.infer<typeof exportSchema>): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = 'Documents Converter';
  book.created = new Date();
  const used = new Set<string>();
  for (const source of input.documents) {
    for (const [tableIndex, table] of source.document.tables.entries()) {
      const title = table.title || source.document.title || source.name.replace(/\.[^.]+$/, '');
      const sheet = book.addWorksheet(sheetName(title, used), { properties: { defaultRowHeight: 22 }, pageSetup: { paperSize: 9, orientation: table.columns.length > 6 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      const count = table.columns.length;
      const preamble = [...new Set([source.document.title, ...source.document.context, table.title].filter(Boolean))];
      for (const [i, text] of preamble.entries()) {
        const row = sheet.addRow([text]);
        if (count > 1) sheet.mergeCells(row.number, 1, row.number, count);
        row.font = { name: 'Arial', size: i === 0 ? 13 : 10, bold: i === 0, color: { argb: 'FF172F27' } };
        row.alignment = { wrapText: true, vertical: 'middle' };
        row.height = Math.max(i === 0 ? 30 : 24, Math.ceil(text.length / Math.max(35, count * 14)) * 15 + 10);
      }
      if (preamble.length) sheet.addRow([]);
      const header = sheet.addRow(table.columns);
      header.height = Math.max(32, Math.max(...table.columns.map(s => Math.ceil(s.length / 28))) * 15 + 12);
      header.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF176D50' } };
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
      });
      const uncertain = new Set(table.uncertainCells.map(c => `${c.row}:${c.column}`));
      for (const [rowIndex, values] of table.rows.entries()) {
        const row = sheet.addRow(values.map(cellValue));
        row.height = Math.min(240, Math.max(26, Math.max(...values.map(v => v.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 30)), 0))) * 14 + 10));
        row.eachCell({ includeEmpty: true }, (cell, column) => {
          cell.font = { name: 'Arial', size: 10, color: { argb: 'FF182A22' } };
          cell.alignment = { wrapText: true, vertical: 'middle', horizontal: typeof cell.value === 'number' ? 'right' : 'left' };
          cell.border = { bottom: { style: 'thin', color: { argb: 'FFE3EAE6' } } };
          if (cell.value instanceof Date) cell.numFmt = 'dd.mm.yyyy';
          if (typeof cell.value === 'number' && !Number.isInteger(cell.value)) cell.numFmt = '0.###############';
          if (uncertain.has(`${rowIndex}:${column - 1}`)) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF0C2' } };
            cell.note = table.uncertainCells.find(c => c.row === rowIndex && c.column === column - 1)!.note;
          }
        });
      }
      table.columns.forEach((name, i) => {
        const lengths = table.rows.map(row => Math.max(...row[i].split('\n').map(line => line.length)));
        const length = Math.max(name.length, ...lengths, 8);
        sheet.getColumn(i + 1).width = Math.min(52, Math.max(12, length * 0.8 + 3));
      });
      sheet.views = [{ state: 'frozen', ySplit: header.number }];
      sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: sheet.rowCount, column: count } };
      sheet.pageSetup.printTitlesRow = `${header.number}:${header.number}`;
      if (source.document.warnings.length) {
        sheet.addRow([]);
        for (const warning of source.document.warnings) {
          const row = sheet.addRow([`Примечание к распознаванию: ${warning}`]);
          if (count > 1) sheet.mergeCells(row.number, 1, row.number, count);
          row.alignment = { wrapText: true }; row.height = 36;
          row.font = { name: 'Arial', size: 10, color: { argb: 'FF795A18' } };
        }
      }
    }
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
