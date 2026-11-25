import ExcelJS from 'exceljs';
import type { Field } from '../shared/scan.js';

export function excelDate(value: string): Date | string {
  const trimmed = value.trim();
  const months: Record<string, number> = { января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
    июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12 };
  const dotted = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s*(?:г\.)?$/i);
  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const written = trimmed.match(/^(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s*(?:г\.)?$/i);
  const day = Number(dotted?.[1] ?? iso?.[3] ?? written?.[1]);
  const month = Number(dotted?.[2] ?? iso?.[2] ?? months[written?.[2]?.toLowerCase() ?? '']);
  const year = Number(dotted?.[3] ?? iso?.[1] ?? written?.[3]);
  if (!day || !month || !year) return value;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day ? date : value;
}

export type RegisterLine = {
  name: string; number: string; date: string; organization: string;
  first?: number | string; last?: number; count?: number; reviewFields?: Field[];
};
type RegistryPage = { object?: string; section?: string; reviewReason?: string };
export function addRegisterSheets(book: ExcelJS.Workbook, rows: RegisterLine[], {
  object, section, sourceName, source, reviews = [],
}: { object?: string; section?: string; sourceName: string; source: string; reviews?: { page: number; reason: string }[] }) {
  const streaming = book instanceof ExcelJS.stream.xlsx.WorkbookWriter;
  let sheet: ExcelJS.Worksheet | undefined;
  let sheetRows = 0;
  let sheetNumber = 0;
  const addSheet = () => {
    if (streaming) sheet?.commit();
    sheet = book.addWorksheet(`Реестр ${++sheetNumber}`, { views: [{ state: 'frozen', ySplit: 7 }], pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    sheet.columns = [
      { key: 'index', width: 9.43 }, { key: 'name', width: 71.14 }, { key: 'number', width: 38.43 },
      { key: 'date', width: 23.14 }, { key: 'organization', width: 25.29 }, { key: 'count', width: 9 },
      { key: 'from', width: 5.71 }, { key: 'dash', width: 2.86 }, { key: 'to', width: 6.86 },
    ];
    sheet.mergeCells('B1:G1'); sheet.mergeCells('B2:E2'); sheet.mergeCells('B3:I3'); sheet.mergeCells('B4:E4');
    sheet.mergeCells('A5:A6'); sheet.mergeCells('B5:B6'); sheet.mergeCells('C5:C6');
    sheet.mergeCells('D5:D6'); sheet.mergeCells('E5:E6'); sheet.mergeCells('F5:F6');
    sheet.mergeCells('G5:I5'); sheet.mergeCells('A7:I7');
    sheet.getCell('B1').value = object ? `Объект: ${object}` : `Объект: см. исходный PDF «${sourceName}»`;
    sheet.getCell('B2').value = source;
    sheet.getCell('B3').value = 'РЕЕСТР ДОКУМЕНТОВ';
    if (reviews.length) {
      sheet.getCell('B4').value = 'Страниц для проверки: ' + reviews.length + '. См. лист «Страницы для проверки».';
      sheet.getCell('B4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF0C2' } };
    }
    sheet.getCell('A5').value = '№п/п';
    sheet.getCell('B5').value = 'Наименование актов освидетельствования (геодезических, скрываемых работ, конструкций, участков сетей), видов испытаний, материалов';
    sheet.getCell('C5').value = '№ чертежа, акта, разрешения, журнала работ и др.';
    sheet.getCell('D5').value = 'Дата';
    sheet.getCell('E5').value = 'Организация, составившая документ.';
    sheet.getCell('F5').value = 'Кол-во листов в док.';
    sheet.getCell('G5').value = 'лист';
    sheet.getCell('G6').value = 'с'; sheet.getCell('H6').value = ''; sheet.getCell('I6').value = 'по';
    sheet.getCell('A7').value = section || rows[0]?.name || 'Документы в порядке страниц исходного PDF';
    for (const row of [1, 2, 3, 4, 5, 6, 7]) {
      const current = sheet.getRow(row);
      current.height = [98.25, 10.5, 29.25, 21, 18, 44.25, 29.25][row - 1];
      for (let column = 1; column <= 9; column++) {
        const cell = current.getCell(column);
        cell.font = { name: 'Times New Roman', size: row === 1 ? 14 : 12, bold: row === 1 || row === 3 || row === 5 || row === 6 || row === 7, color: { argb: row === 3 ? 'FFFF0000' : 'FF000000' } };
        cell.alignment = { wrapText: true, vertical: 'middle', horizontal: row === 5 && column === 2 ? 'left' : 'center' };
        if (row === 7) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
        if (row === 5 || row === 6) cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      }
      if (streaming) current.commit();
    }
    sheetRows = 7;
  };
  addSheet();
  for (const [index, record] of rows.entries()) {
    if (sheetRows >= 1_000_000) addSheet();
    const line = sheet!.addRow([index + 1, record.name || null, record.number || null, excelDate(record.date) || null, record.organization || null,
      record.count ?? (typeof record.first === 'number' && record.last ? record.last - record.first + 1 : null), record.first, record.last ? '-' : null, record.last]);
    line.height = 48;
    if (line.getCell(4).value instanceof Date) line.getCell(4).numFmt = 'dd.mm.yyyy';
    line.eachCell({ includeEmpty: true }, (cell: ExcelJS.Cell) => {
      cell.font = { name: Number(cell.col) === 2 || Number(cell.col) === 5 ? 'Aptos Narrow' : 'Times New Roman', size: 12, bold: Number(cell.col) === 2, color: { argb: 'FF000000' } };
      cell.alignment = { wrapText: true, vertical: 'middle', horizontal: [2, 5].includes(Number(cell.col)) ? 'left' : 'center' };
      cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
      const field = (['name', 'number', 'date', 'organization'] as const)[Number(cell.col) - 2];
      if (field && record.reviewFields?.includes(field)) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF0C2' } };
    });
    if (streaming) line.commit();
    sheetRows++;
  }
  if (streaming) sheet?.commit();
  if (reviews.length) {
    const review = book.addWorksheet('Страницы для проверки', { views: [{ state: 'frozen', ySplit: 1 }] });
    review.columns = [{ header: 'Страница PDF', width: 18 }, { header: 'Причина', width: 80 }, { header: 'Что проверить', width: 80 }];
    review.getRow(1).font = { bold: true };
    if (streaming) review.getRow(1).commit();
    for (const item of reviews) {
      const row = review.addRow([item.page, item.reason, 'Сверьте страницу с оригиналом и при необходимости дополните реестр.']);
      if (streaming) row.commit();
    }
    if (streaming) review.commit();
  }
}

export async function writeRegistry(filename: string, sourceName: string, pages: RegistryPage[], rows: RegisterLine[]) {
  const book = new ExcelJS.stream.xlsx.WorkbookWriter({ filename, useStyles: true });
  book.creator = 'Documents Converter';
  addRegisterSheets(book, rows, {
    object: pages.find(p => p.object?.trim())?.object?.trim(),
    section: pages.find(p => p.section?.trim())?.section?.trim(),
    sourceName, source: `Источник: ${sourceName}. Листы «с/по» — страницы PDF.`,
    reviews: pages.flatMap((p, i) => p.reviewReason ? [{ page: i + 1, reason: p.reviewReason }] : []),
  });
  await book.commit();
  return rows.length;
}
