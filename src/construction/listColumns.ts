import {
  fields,
  formTypes,
  numberOf,
  type Entry,
  type Kind,
  type SavedProject,
  type ProjectSummary,
} from '../../shared/construction';
import type { Column } from '../lists/model';

export const projectColumns: Column<ProjectSummary>[] = [
  { key: 'name', label: 'Название проекта', value: (p) => p.name },
  { key: 'phases', label: 'Число фаз', value: (p) => p.phases },
  { key: 'works', label: 'Число актов', value: (p) => p.works },
];
const keys: Record<Kind, string[]> = {
  work: ['template', 'date', 'pack', 'number', 'name', 'start', 'end'],
  pack: ['name', 'number'],
  phase: ['name'],
  person: ['role', 'company', 'position', 'name', 'start', 'end'],
  scheme: ['docType', 'issuer', 'number', 'date', 'name'],
  protocol: ['docType', 'issuer', 'number', 'date', 'name'],
  material: ['category', 'docType', 'issuer', 'received', 'number', 'date', 'name', 'batch'],
  template: ['form', 'name', 'description'],
  standard: ['name', 'description'],
};
export function entryColumns(project: SavedProject, kind: Kind): Column<Entry>[] {
  const byId = new Map(project.rows.map((r) => [r.id, r.v.name]));
  const columns = keys[kind].map((key): Column<Entry> => {
    const field = fields[kind].find((f) => f.key === key)!;
    if (field.type === 'link')
      return {
        key,
        label: field.label,
        value: (r) => r.links[key],
        display: (id) => byId.get(id) || 'Удалённая запись',
      };
    if (kind === 'work' && key === 'number')
      return { key, label: field.label, value: (r) => numberOf(project, r) };
    return {
      key,
      label: field.label,
      value: (r) => r.v[key],
      display: key === 'form' ? (v) => formTypes[v as keyof typeof formTypes] : undefined,
    };
  });
  if (kind === 'standard')
    columns.unshift({
      key: 'rules',
      label: 'Наличие правил',
      value: (r) => (r.rules?.length ? 'С правилами' : 'Без правил'),
    });
  if (['material', 'protocol', 'scheme', 'template'].includes(kind))
    columns.unshift({ key: 'file', label: 'Оригинал', value: (r) => (r.file ? 'С оригиналом' : 'Без оригинала') });
  if (kind === 'phase' || kind === 'pack') {
    const counts = new Map<string, number>();
    for (const r of project.rows)
      if (r.kind === 'work') for (const id of r.links[kind] || []) counts.set(id, (counts.get(id) || 0) + 1);
    columns.unshift({ key: 'works', label: 'Число актов', value: (r) => counts.get(r.id) || 0 });
  }
  return columns;
}
