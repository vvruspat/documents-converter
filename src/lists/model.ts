import { z } from 'zod';

export type Column<T> = {
  key: string;
  label: string;
  value: (row: T) => string | number | string[] | undefined;
  display?: (value: string) => string;
};
export const configSchema = z.object({
  query: z.string(),
  size: z.number().int().min(1).max(100).nullable(),
  filters: z.record(z.string(), z.array(z.string())),
  sort: z.string(),
  descending: z.boolean(),
  group: z.string(),
});
export type Config = z.infer<typeof configSchema>;
export const defaultConfig: Config = {
  query: '',
  size: null,
  filters: {},
  sort: '',
  descending: false,
  group: '',
};
export const librarySchema = z.object({
  active: z.string(),
  views: z.array(z.object({ id: z.string(), name: z.string(), config: configSchema })),
});
export type Library = z.infer<typeof librarySchema>;
export type Group<T> = { key: string; label: string; rows: T[]; total: number };
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
function compare(a: string, b: string) {
  // Imported registers can mix Russian calendar dates and ISO dates.
  const iso = (value: string) => value.replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, '$3-$2-$1');
  return collator.compare(iso(a), iso(b));
}
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е');
export function values<T>(row: T, col: Column<T>): string[] {
  const value = col.value(row);
  return Array.isArray(value) && value.length ? value : [String(value ?? '')];
}
export function caption<T>(col: Column<T>, value: string) {
  return value ? col.display?.(value) || value : 'Не указано';
}
export function choices<T>(rows: T[], col: Column<T>, selected: string[]) {
  return [...new Set([...selected, ...rows.flatMap((row) => values(row, col))])].sort((a, b) =>
    compare(caption(col, a), caption(col, b)),
  );
}
export function arrange<T>(rows: T[], cols: Column<T>[], config: Config): Group<T>[] {
  const terms = normalize(config.query).split(/\s+/).filter(Boolean);
  const filters = cols.filter((col) => config.filters[col.key]?.length);
  const group = cols.find((col) => col.key === config.group);
  const sort = cols.find((col) => col.key === config.sort);
  const groups = new Map<string, Group<T>>();
  const describe = (row: T, col: Column<T>) =>
    values(row, col)
      .map((v) => caption(col, v))
      .join(', ');
  for (const row of rows) {
    if (!filters.every((col) => values(row, col).some((value) => config.filters[col.key].includes(value))))
      continue;
    if (terms.length) {
      const text = normalize(cols.map((col) => describe(row, col)).join(' '));
      if (!terms.every((term) => text.includes(term))) continue;
    }
    const keys = group ? [...new Set(values(row, group))].sort() : [];
    const key = JSON.stringify(keys);
    const bucket = groups.get(key) ?? {
      key,
      label: group ? keys.map((v) => caption(group, v)).join(', ') : '',
      rows: [],
      total: 0,
    };
    bucket.rows.push(row);
    bucket.total++;
    groups.set(key, bucket);
  }
  const ordered = [...groups.values()].sort((a, b) => compare(a.label, b.label));
  if (sort)
    for (const bucket of ordered)
      bucket.rows.sort((a, b) => compare(describe(a, sort), describe(b, sort)) * (config.descending ? -1 : 1));
  return ordered;
}
export function pageGroups<T>(groups: Group<T>[], start: number, size: number) {
  const result: Group<T>[] = [];
  let offset = 0;
  for (const group of groups) {
    const rows = group.rows.slice(Math.max(0, start - offset), Math.max(0, start + size - offset));
    if (rows.length) result.push({ ...group, rows });
    offset += group.total;
    if (offset >= start + size) break;
  }
  return result;
}
