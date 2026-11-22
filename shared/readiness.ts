import { canSign, type Entry } from './construction.js';
import { evaluateStandardRules, withHiddenWorks } from './standard-rules.js';

export type CheckItem = {
  label: string;
  present: boolean;
  section: 'work' | 'evidence';
  blocking?: boolean;
  detail?: string;
  field?: 'name' | 'template' | 'number' | 'date' | 'start' | 'end' | 'signers' | 'templateFile';
  document?: { key: string; part: 'link' | 'original' };
};
export function workChecklist(work: Entry, byId: Map<string, Entry>): CheckItem[] {
  const template = byId.get(work.links.template?.[0]);
  const items: CheckItem[] = [];
  const field = (
    key: NonNullable<CheckItem['field']>,
    label: string,
    value: string | undefined,
    blocking = true,
  ) => {
    items.push({ field: key, label, present: Boolean(value?.trim()), detail: value, section: 'work', blocking });
  };
  field('name', 'Название работы', work.v.name);
  field('template', 'Шаблон акта', template?.v.name);
  field('number', 'Номер акта', work.v.number);
  field('date', 'Дата акта', work.v.date);
  if (template?.v.needsFile === 'да') field('templateFile', 'Файл шаблона', template.file);
  const children = (work.links.children || []).flatMap((id) => byId.get(id) || []);
  if (template && template.v.form !== 'incoming') {
    field(
      'start',
      'Начало работ',
      work.v.start ||
        children
          .map((r) => r.v.start)
          .filter(Boolean)
          .sort()[0],
      false,
    );
    field(
      'end',
      'Окончание работ',
      work.v.end ||
        children
          .map((r) => r.v.end)
          .filter(Boolean)
          .sort()
          .at(-1),
      false,
    );
  }
  const signers = Object.entries(work.links)
    .filter(([key]) => /^signer[0-7]$/.test(key))
    .flatMap(([, ids]) => ids.flatMap((id) => byId.get(id) || []));
  field('signers', 'Подписанты', signers.map((s) => s.v.name).join(', '), false);
  for (const signer of signers)
    if (work.v.date && (signer.v.start || signer.v.end))
      items.push({
        label: 'Срок полномочий · ' + signer.v.name,
        present: canSign(signer, work.v.date),
        section: 'work',
        blocking: true,
      });
  const { conflicts, checks } = evaluateStandardRules(work, byId);
  for (const label of conflicts)
    items.push({
      label: 'Согласованный текст · ' + label,
      present: false,
      section: 'work',
      blocking: true,
      detail: 'Разные замены поля «' + label + '»',
    });
  const evidence = new Map<string, { label: string; doc?: Entry; bases: Set<string> }>();
  const addDocument = (id: string, basis?: string) => {
    const doc = byId.get(id);
    if (!doc) return;
    const row = evidence.get(id) || {
      label: [doc.v.name, doc.v.number].filter(Boolean).join(' · '),
      doc,
      bases: new Set<string>(),
    };
    if (basis) row.bases.add(basis);
    evidence.set(id, row);
  };
  for (const check of checks) {
    if (check.matchedIds.length) {
      for (const id of check.matchedIds) addDocument(id, check.basis);
    } else {
      const row = evidence.get(check.document) || { label: check.document, bases: new Set<string>() };
      row.bases.add(check.basis);
      evidence.set(check.document, row);
    }
  }
  for (const key of ['materials', 'schemes', 'protocols']) for (const id of work.links[key] || []) addDocument(id);
  for (const [key, { label, doc, bases }] of evidence) {
    items.push({
      section: 'evidence',
      document: { key, part: 'link' },
      label,
      present: !!doc,
      detail: [...bases].join(', '),
    });
    items.push({
      section: 'evidence',
      document: { key, part: 'original' },
      label: 'Оригинал · ' + label,
      present: !!doc?.file,
      detail: doc?.file,
    });
  }
  return items;
}
function workStatus(work: Entry, checklist: CheckItem[]) {
  if (checklist.every((c) => c.present)) return 'Готово';
  return !work.v.number && !work.v.date && !work.links.template?.length ? 'Запланировано' : 'Нужно заполнить';
}
export function assessWorks(byId: Map<string, Entry>) {
  const works = [...byId.values()].filter((r) => r.kind === 'work');
  const results = new Map(
    works.map((work) => {
      const checklist = workChecklist(work, byId);
      return [work.id, { checklist, status: workStatus(work, checklist) }];
    }),
  );
  for (const work of works) {
    const result = results.get(work.id)!;
    for (const id of work.links.children || [])
      result.checklist.push({
        section: 'evidence',
        label: 'Связанный АОСР · ' + (byId.get(id)?.v.name || 'Шаг без названия'),
        present: results.get(id)?.status === 'Готово',
      });
    result.status = workStatus(work, result.checklist);
  }
  return results;
}
export function packagePlan(rows: Entry[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const works = rows.filter((r) => r.kind === 'work');
  const assessments = assessWorks(byId);
  const assignments = new Map<string, Entry[]>();
  for (const w of works)
    for (const id of w.links.pack || []) {
      const list = assignments.get(id) ?? [];
      list.push(w);
      assignments.set(id, list);
    }
  return rows
    .filter((r) => r.kind === 'pack')
    .map((pack) => {
      const direct = assignments.get(pack.id) || [];
      const assigned = new Set(direct.map((r) => r.id));
      const steps = withHiddenWorks(direct, byId).map((work, index) => ({
        position: index + 1,
        work,
        dependent: !assigned.has(work.id),
        ...assessments.get(work.id)!,
      }));
      const ready = steps.filter((s) => s.status === 'Готово').length;
      const status = !steps.length
        ? 'Нет работ'
        : ready === steps.length
          ? 'Готово'
          : steps.every((s) => s.status === 'Запланировано')
            ? 'Запланировано'
            : 'Нужно заполнить';
      return { pack, steps, ready, status };
    });
}
