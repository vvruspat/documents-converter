import test from 'node:test';
import assert from 'node:assert/strict';
import { entry, validateProject } from '../shared/construction.js';
import { packagePlan } from '../shared/readiness.js';
import { readProject } from './construction/legacy.js';

test('legacy packages retain IDs, multiple memberships, unassigned steps and empty phases across saves', () => {
  const phase = { ...entry('pack', { name: 'Участок' }), kind: 'phase' };
  const empty = { ...entry('pack', { name: 'Кровля' }), kind: 'phase' };
  const a = entry('pack', { name: 'А' }, { phase: [phase.id] }),
    b = entry('pack', { name: 'Б' }, { phase: [phase.id] });
  const work = entry('work', { name: 'Общий акт' }, { phase: [phase.id], pack: [a.id, b.id] });
  const draft = entry('work', {}, { phase: [phase.id] });
  const legacy = { v: { name: 'Объект' }, rows: [phase, empty, a, b, work, draft] };
  const adapted = readProject(legacy);
  assert.equal(validateProject(adapted), undefined);
  assert.deepEqual(readProject(adapted), adapted);
  assert.deepEqual(adapted.rows.find((r) => r.id === work.id)?.links.pack, [a.id, b.id]);
  assert.deepEqual(adapted.rows.find((r) => r.id === draft.id)?.links.pack, [phase.id]);
  assert.equal(packagePlan(adapted.rows).length, 4);
  assert.equal(
    readProject({ ...legacy, rows: [phase, a, b, work] }).rows.some((r) => r.id === phase.id),
    false,
  );
});
test('package readiness includes dependent acts, unfinished rows and original files', () => {
  const a = entry('pack', { name: 'А' }),
    b = entry('pack', { name: 'Б' });
  const tpl = entry('template', { name: 'АОСР', form: 'hidden' }),
    structure = entry('template', { name: 'АООК', form: 'structure' });
  const signer = entry('person', { name: 'Ответственный' }),
    doc = entry('protocol', { name: 'Протокол' });
  const draft = entry('work', {}, { pack: [b.id] });
  const parent = entry(
    'work',
    { name: 'Приёмка', number: '02', date: '2026-01-01', start: '2026-01-01', end: '2026-01-01' },
    { pack: [a.id], children: [draft.id], template: [structure.id], signer0: [signer.id] },
  );
  const rows = [a, b, tpl, structure, signer, doc, draft, parent];
  const overview = () => packagePlan(rows)[0];
  assert.equal(overview().ready, 0);
  assert.equal(overview().steps[1].dependent, true);
  assert.equal(overview().steps[1].status, 'Запланировано');
  Object.assign(draft.v, {
    name: 'Основание',
    number: '01',
    date: '2026-01-01',
    start: '2026-01-01',
    end: '2026-01-01',
  });
  Object.assign(draft.links, { template: [tpl.id], signer0: [signer.id], protocols: [doc.id] });
  assert.deepEqual(overview().steps[1].warnings, ['Без оригинала · Протокол']);
  doc.file = 'test.pdf';
  assert.equal(overview().status, 'Готово');
});
