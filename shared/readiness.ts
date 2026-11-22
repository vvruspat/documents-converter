import { canSign, type Entry } from './construction.js';
import { evaluateStandardRules, withHiddenWorks } from './standard-rules.js';

export function assessWork(work: Entry, byId: Map<string, Entry>) {
  const issues: string[] = [],
    warnings: string[] = [];
  const template = byId.get(work.links.template?.[0]);
  if (!work.v.name?.trim()) issues.push('Укажите название работы');
  if (!template) issues.push('Выберите шаблон акта');
  if (!work.v.number?.trim()) issues.push('Заполните номер акта');
  if (!work.v.date?.trim()) issues.push('Укажите дату акта');
  if (template?.v.needsFile === 'да' && !template.file) issues.push('Загрузите форму «' + template.v.name + '»');
  const signers = Object.entries(work.links)
    .filter(([key]) => /^signer[0-7]$/.test(key))
    .flatMap(([, ids]) => ids);
  for (const id of signers) {
    const signer = byId.get(id);
    if (signer && !canSign(signer, work.v.date)) issues.push('Проверьте срок полномочий · ' + signer.v.name);
  }
  const hiddenWorks = (work.links.children || []).flatMap((id) => byId.get(id) || []);
  if (template && template.v.form !== 'incoming') {
    for (const [field, label] of [
      ['start', 'начала'],
      ['end', 'окончания'],
    ]) {
      if (!work.v[field] && !hiddenWorks.some((w) => w.v[field])) warnings.push('Нет даты ' + label + ' работ');
    }
  }
  if (!signers.length) warnings.push('Не выбраны подписанты');
  const { conflicts, checks } = evaluateStandardRules(work, byId);
  for (const field of conflicts) issues.push('Разные замены поля «' + field + '»');
  for (const check of checks) if (!check.complete) warnings.push(check.document + ' · ' + check.status);
  for (const key of ['materials', 'schemes', 'protocols'])
    for (const id of work.links[key] || []) {
      const doc = byId.get(id);
      if (doc && !doc.file) warnings.push('Без оригинала · ' + doc.v.name);
    }
  const status =
    issues.length || warnings.length
      ? !work.v.number && !work.v.date && !template
        ? 'Запланировано'
        : 'Нужно заполнить'
      : 'Готово';
  return { issues, warnings, status };
}

export function packagePlan(rows: Entry[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const works = rows.filter((r) => r.kind === 'work');
  const assessments = new Map(works.map((w) => [w.id, assessWork(w, byId)]));
  for (const work of works) {
    const own = assessments.get(work.id)!;
    for (const id of work.links.children || []) {
      const child = assessments.get(id);
      if (child && child.status !== 'Готово') {
        own.warnings.push('Заполните связанный АОСР · ' + (byId.get(id)?.v.name || 'Шаг без названия'));
        own.status = 'Нужно заполнить';
      }
    }
  }
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
