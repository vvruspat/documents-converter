import { z } from 'zod';

export const tableSchema = z.object({
  title: z.string(),
  columns: z.array(z.string()).min(1),
  rows: z.array(z.array(z.string())),
  uncertainCells: z.array(z.object({
    row: z.number().int().min(0), column: z.number().int().min(0), note: z.string(),
  }).strict()),
}).strict().superRefine((table, ctx) => {
  table.rows.forEach((row, i) => {
    if (row.length !== table.columns.length) ctx.addIssue({ code: 'custom', message: 'Неполная строка таблицы', path: ['rows', i] });
  });
  table.uncertainCells.forEach((cell, i) => {
    if (cell.row >= table.rows.length || cell.column >= table.columns.length) ctx.addIssue({ code: 'custom', message: 'Некорректная ссылка на ячейку', path: ['uncertainCells', i] });
  });
});
export const documentSchema = z.object({
  title: z.string(), context: z.array(z.string()),
  tables: z.array(tableSchema), warnings: z.array(z.string()),
}).strict();
export type ExtractedTable = z.infer<typeof tableSchema>;
export type ExtractedDocument = z.infer<typeof documentSchema>;
export type Conversion = { id: string; name: string; document: ExtractedDocument };

export const exportSchema = z.object({
  documents: z.array(z.object({ name: z.string(), document: documentSchema }).strict()).min(1),
}).strict().superRefine((value, ctx) => {
  if (!value.documents.some(doc => doc.document.tables.length)) ctx.addIssue({ code: 'custom', message: 'Нет таблиц для экспорта' });
});
