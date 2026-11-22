import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { entry, matchStandardText, projectSchema, type SavedProject } from '../shared/construction.js';
import { evaluateStandardRules, type StandardRule } from '../shared/standard-rules.js';
import { report } from './construction/report.js';

test('standard rules apply to the selected act and its real attachments in the exported files', async () => {
  const pack = entry('pack', { name: 'Комплект' });
  const template = entry('template', { name: 'АОСР', form: 'hidden' });
  const standard = entry('standard', { name: 'Тестовый норматив' });
  const original = entry('protocol', { name: 'Проверка', docType: 'Акт испытаний' });
  const work = entry(
    'work',
    { name: 'Монтаж сети', number: '01', date: '2026-01-01', notes: 'Ручной текст' },
    { template: [template.id], pack: [pack.id], standards: [standard.id] },
  );
  const scope = { form: 'hidden', clause: 'п. 1', workContains: 'МОНТАЖ' } as const;
  const rule: StandardRule = { ...scope, action: 'append', field: 'notes', text: 'Дополнение' };
  standard.rules = [rule, { ...scope, action: 'require', category: 'protocols', document: 'Акт испытаний' }];
  const project: SavedProject = {
    id: pack.id,
    version: 1,
    v: { name: 'Проект' },
    rows: [pack, template, standard, original, work],
  };
  assert.ok(projectSchema.safeParse(project).success);
  const inspect = () => evaluateStandardRules(work, new Map(project.rows.map((r) => [r.id, r])));
  assert.equal(inspect().checks[0].status, 'Привяжите документ к работе');
  work.links.protocols = [original.id];
  assert.equal(inspect().checks[0].status, 'Загрузите оригинал');
  original.file = 'test.pdf';
  const generate = () =>
    report(project, pack.id, [], async () => ({ name: 'test.pdf', data: Buffer.from('test') }));
  const zip = await JSZip.loadAsync((await generate()).data);
  const doc = await JSZip.loadAsync(await zip.file(/\.docx$/)[0].async('nodebuffer'));
  assert.match(await doc.file('word/document.xml')!.async('string'), /Ручной текст.*Дополнение/s);
  assert.equal(zip.file(/\.pdf$/).length, 1);
  const register = new ExcelJS.Workbook();
  await register.xlsx.load(await zip.file(/\.xlsx$/)[0].async('arraybuffer'));
  assert.match(
    String(register.getWorksheet('Проверка приложений')!.getCell('E2').value),
    /Приложен оригинал.*test.pdf/,
  );
  standard.rules.push(
    { ...rule, action: 'replace', text: 'Замена' },
    { ...rule, action: 'replace', text: 'Вторая' },
  );
  await assert.rejects(generate, /разные замены/i);
  standard.rules.pop();
  const replaced = await JSZip.loadAsync((await generate()).data);
  const replacedDoc = await JSZip.loadAsync(await replaced.file(/\.docx$/)[0].async('nodebuffer'));
  const xml = await replacedDoc.file('word/document.xml')!.async('string');
  assert.match(xml, /Замена.*Дополнение/s);
  assert.doesNotMatch(xml, /Ручной текст/);
  assert.equal(work.v.notes, 'Ручной текст');
  work.v.name = 'Иная работа';
  assert.equal(inspect().checks.length, 0);
  work.v.name = 'Монтаж';
  work.links.standards = [];
  assert.equal(inspect().changes.size, 0);
});
test('links only unambiguous entire workbook references and preserves unmatched editions', () => {
  const standard = entry('standard', { name: 'СП 1', description: 'Документ' });
  const ambiguous = entry('standard', { name: 'ППР', description: 'Работа' });
  const { ids, remaining } = matchStandardText('СП 1 Документ; ППР Работа; СП 1 Документ (изм. 2)', [
    standard,
    ambiguous,
    { ...ambiguous, id: standard.id },
  ]);
  assert.deepEqual(ids, [standard.id]);
  assert.equal(remaining, 'ППР Работа; СП 1 Документ (изм. 2)');
});
