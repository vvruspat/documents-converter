import { z } from 'zod';

export const tableSchema = z.object({
  title: z.string().max(500),
  columns: z.array(z.string().max(500)).min(1).max(50),
  rows: z.array(z.array(z.string().max(10000)).max(50)).max(1500),
  uncertainCells: z.array(z.object({
    row: z.number().int().min(0), column: z.number().int().min(0), note: z.string().max(500),
  }).strict()).max(500),
}).strict().superRefine((table, ctx) => {
  table.rows.forEach((row, i) => {
    if (row.length !== table.columns.length) ctx.addIssue({ code: 'custom', message: 'Неполная строка таблицы', path: ['rows', i] });
  });
  table.uncertainCells.forEach((cell, i) => {
    if (cell.row >= table.rows.length || cell.column >= table.columns.length) ctx.addIssue({ code: 'custom', message: 'Некорректная ссылка на ячейку', path: ['uncertainCells', i] });
  });
});
export const documentSchema = z.object({
  title: z.string().max(500), context: z.array(z.string().max(2000)).max(20),
  tables: z.array(tableSchema).max(8), warnings: z.array(z.string().max(1000)).max(30),
}).strict();
export type ExtractedTable = z.infer<typeof tableSchema>;
export type ExtractedDocument = z.infer<typeof documentSchema>;
export type Conversion = { id: string; name: string; document: ExtractedDocument };

export const exportSchema = z.object({
  documents: z.array(z.object({ name: z.string().max(200), document: documentSchema }).strict()).min(1).max(10),
}).strict().superRefine((value, ctx) => {
  const count = value.documents.reduce((sum, doc) => sum + doc.document.tables.reduce((n, t) => n + t.rows.length * t.columns.length, 0), 0);
  if (count > 50000) ctx.addIssue({ code: 'custom', message: 'Слишком много ячеек для одного файла' });
  if (!value.documents.some(doc => doc.document.tables.length)) ctx.addIssue({ code: 'custom', message: 'Нет таблиц для экспорта' });
});
