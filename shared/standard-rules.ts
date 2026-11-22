import { z } from 'zod';
import type { Entry } from './construction.js';

export const ruleForms = ['hidden', 'structure', 'incoming'] as const;
export const textFields = {
  design: {
    label: 'Проектная и рабочая документация',
    hidden: 'Наим_пр_докум',
    structure: 'Проекты_АОСР',
    incoming: 'шифр_рд2',
  },
  compliance: { label: 'Работы выполнены в соответствии с', hidden: 'выполнено_с', structure: 'Выполнено_с_АОСР' },
  notes: { label: 'Дополнительные сведения', hidden: 'Доп_сведения', structure: 'Доп_сведения' },
  next: {
    label: 'Последующие работы',
    hidden: 'Наименование_последующих_работ',
    structure: 'Наименование_последующих_работ',
  },
  loadTerms: { label: 'Условия полного нагружения', structure: 'условия' },
} as const;
const textKeys = ['design', 'compliance', 'notes', 'next', 'loadTerms'] as const;
export const attachments = {
  materials: 'Документ качества',
  protocols: 'Протокол или акт испытаний',
  schemes: 'Исполнительная схема',
};
const scope = {
  form: z.enum(ruleForms),
  clause: z.string().max(500),
  workContains: z.string().max(300),
};
export const ruleSchema = z.discriminatedUnion('action', [
  z.object({
    ...scope,
    action: z.enum(['append', 'replace']),
    field: z.enum(textKeys),
    text: z.string().trim().min(1).max(4000),
  }),
  z.object({
    ...scope,
    action: z.literal('require'),
    category: z.enum(['materials', 'protocols', 'schemes']),
    document: z.string().trim().max(500),
  }),
]);
export type StandardRule = z.infer<typeof ruleSchema>;
export type RuleForm = StandardRule['form'];
export type TextField = keyof typeof textFields;
export function bookmark(field: TextField, form: RuleForm): string | undefined {
  const targets: Partial<Record<RuleForm, string>> = textFields[field];
  return targets[form];
}
const normalized = (text = '') => text.trim().toLocaleLowerCase('ru').replace(/\s+/g, ' ');

export function evaluateStandardRules(work: Entry, byId: Map<string, Entry>) {
  const linked = (row: Entry, key: string) => (row.links[key] || []).flatMap((id) => byId.get(id) || []);
  const form = linked(work, 'template')[0]?.v.form;
  const changes = new Map<
    string,
    { label: string; sources: Set<string>; additions: Set<string>; replacements: Set<string> }
  >();
  const checks: { basis: string; document: string; complete: boolean; status: string }[] = [];
  for (const standard of linked(work, 'standards')) {
    for (const rule of standard.rules || []) {
      if (rule.form !== form || !normalized(work.v.name).includes(normalized(rule.workContains))) continue;
      const basis = [standard.v.name, rule.clause].filter(Boolean).join(', ');
      if (rule.action === 'require') {
        const expected = normalized(rule.document);
        const matches = [work, ...linked(work, 'children')]
          .flatMap((row) => linked(row, rule.category))
          .filter((row) => !expected || [row.v.docType, row.v.name].some((name) => normalized(name) === expected));
        const files = matches.filter((row) => row.file);
        checks.push({
          basis,
          complete: files.length > 0,
          document: [attachments[rule.category], rule.document].filter(Boolean).join(' · '),
          status: files.length
            ? 'Приложен оригинал · ' + [...new Set(files.map((row) => row.file))].join(', ')
            : matches.length
              ? 'Загрузите оригинал'
              : 'Привяжите документ к работе',
        });
      } else {
        const key = bookmark(rule.field, rule.form);
        if (!key) continue;
        const change = changes.get(key) || {
          label: textFields[rule.field].label,
          sources: new Set<string>(),
          additions: new Set<string>(),
          replacements: new Set<string>(),
        };
        (rule.action === 'replace' ? change.replacements : change.additions).add(rule.text);
        change.sources.add(basis);
        changes.set(key, change);
      }
    }
  }
  const conflicts = [...changes.values()]
    .filter((change) => change.replacements.size > 1)
    .map((change) => change.label);
  return { changes, checks, conflicts };
}
export function withHiddenWorks(works: Entry[], byId: Map<string, Entry>) {
  const result = new Set(works);
  for (const work of works)
    for (const id of work.links.children || []) {
      const child = byId.get(id);
      if (child) result.add(child);
    }
  return [...result];
}
