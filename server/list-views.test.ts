import assert from 'node:assert/strict';
import test from 'node:test';
import { arrange, defaultConfig, pageGroups, type Column } from '../src/lists/model.js';

type Item = { number: number; teams: string[]; title: string; date?: string };
const columns: Column<Item>[] = [
  { key: 'number', label: 'Номер', value: (r) => r.number },
  { key: 'teams', label: 'Лаборатории', value: (r) => r.teams, display: (id) => 'Лаборатория ' + id },
  { key: 'title', label: 'Название', value: (r) => r.title },
  { key: 'date', label: 'Дата', value: (r) => r.date },
];
test('filters and sorts the whole collection before paginating across groups', () => {
  const rows = Array.from({ length: 36 }, (_, i) => ({
    number: i + 1,
    teams: [i % 2 ? 'Б' : 'А'],
    title: 'Съёмка',
    date: i % 3 ? '2026-01-01' : undefined,
  }));
  const groups = arrange(rows, columns, {
    ...defaultConfig,
    query: 'лаборатория съемка',
    group: 'teams',
    sort: 'number',
    descending: true,
    filters: { teams: ['А', 'Б'], date: ['2026-01-01'] },
  });
  assert.deepEqual(
    groups.map((g) => [g.label, g.total]),
    [
      ['Лаборатория А', 12],
      ['Лаборатория Б', 12],
    ],
  );
  const page = pageGroups(groups, 10, 5);
  assert.deepEqual(
    page.map((g) => g.rows.map((r) => r.number)),
    [
      [5, 3],
      [36, 32, 30],
    ],
  );
  assert.deepEqual(arrange(rows, columns, { ...defaultConfig, filters: { teams: ['removed'] } }), []);
  assert.equal(rows[0].number, 1);
});
test('matches individual linked values and sorts mixed Russian and ISO dates chronologically', () => {
  const rows = ['01.02.2025', '2024-11-30', '15.01.2025'].map((date, i) => ({
    number: i,
    teams: ['a', 'b'],
    title: '',
    date,
  }));
  const [group] = arrange(rows, columns, { ...defaultConfig, filters: { teams: ['b'] }, sort: 'date' });
  assert.deepEqual(
    group.rows.map((r) => r.number),
    [1, 2, 0],
  );
});
