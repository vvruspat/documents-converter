import { useState, useRef } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import {
  AlignLeft,
  ChevronLeft,
  ChevronRight,
  FileText,
  Filter,
  Paperclip,
  Pencil,
  Plus,
  Search,
} from 'lucide-react';
import { formTypes, type Entry } from '../../shared/construction';
import { attachments, textFields } from '../../shared/standard-rules';
import { recordTitle } from './Editor';
import s from './projects.module.css';

export function StandardsBrowser({ rows, edit }: { rows: Entry[]; edit: (row: Entry) => void }) {
  const [query, setQuery] = useState(''),
    [onlyRules, setOnlyRules] = useState(false);
  const [page, setPage] = useState(0),
    [limit, setLimit] = useState(10),
    [selected, setSelected] = useState('');
  const inspector = useRef<HTMLElement>(null);
  function select(id: string) {
    setSelected(id);
    if (matchMedia('(max-width:1080px)').matches) inspector.current?.focus();
  }
  const result = rows.filter(
    (r) => (!onlyRules || r.rules?.length) && recordTitle(r).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(result.length / limit)),
    current = Math.min(page, pages - 1);
  const visible = result.slice(current * limit, (current + 1) * limit);
  const row = visible.find((r) => r.id === selected) || visible[0];
  return (
    <div className={s.browser}>
      <section className={s.listPane} aria-label="Справочник нормативов">
        <div className={s.toolbar}>
          <label className={s.search}>
            <Search size={16} />
            <input
              aria-label="Поиск по нормативам"
              placeholder="Поиск по нормативам"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <button
            className={s.secondary}
            aria-pressed={onlyRules}
            onClick={() => {
              setOnlyRules(!onlyRules);
              setPage(0);
            }}
          >
            <Filter size={15} />С правилами
          </button>
        </div>
        {visible.length ? (
          <div className={s.tableScroll}>
            <table className={s.normTable}>
              <thead>
                <tr>
                  <th scope="col">Обозначение</th>
                  <th scope="col">Название</th>
                  <th scope="col">Правила</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((item) => (
                  <tr key={item.id} data-selected={item.id === row.id} onClick={() => select(item.id)}>
                    <td>
                      <button type="button" aria-pressed={item.id === row.id}>
                        <FileText size={17} />
                        {item.v.name}
                      </button>
                    </td>
                    <td>{item.v.description || '—'}</td>
                    <td>{item.rules?.length || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className={s.empty}>
            <h3>{rows.length ? 'Совпадений нет' : 'Пока нет нормативов'}</h3>
            {(query || onlyRules) && (
              <button
                className={s.text}
                onClick={() => {
                  setQuery('');
                  setOnlyRules(false);
                  setPage(0);
                }}
              >
                Сбросить фильтры
              </button>
            )}
          </div>
        )}
        {result.length > 0 && (
          <div className={s.listFoot}>
            <div>
              <button aria-label="Предыдущая страница" disabled={!current} onClick={() => setPage(current - 1)}>
                <ChevronLeft size={16} />
              </button>
              <span>
                {current + 1} из {pages}
              </span>
              <button
                aria-label="Следующая страница"
                disabled={current + 1 >= pages}
                onClick={() => setPage(current + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <label>
              Показывать по{' '}
              <select
                value={limit}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(0);
                }}
              >
                {[10, 25, 50].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      </section>
      {row && (
        <aside ref={inspector} tabIndex={-1} className={s.inspector} aria-label="Выбранный норматив">
          <div className={s.inspectTitle}>
            <h3>{row.v.name}</h3>
            <button
              className={s.icon}
              title="Редактировать норматив"
              aria-label="Редактировать норматив"
              onClick={() => edit(row)}
            >
              <Pencil size={15} />
            </button>
          </div>
          <p className={s.normDescription}>{row.v.description}</p>
          <Tabs.Root defaultValue="rules">
            <Tabs.List className={s.innerTabs} aria-label="Карточка норматива">
              <Tabs.Trigger value="rules">Правила</Tabs.Trigger>
              <Tabs.Trigger value="info">Сведения</Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="rules">
              {row.rules?.length ? (
                row.rules.map((rule, i) => (
                  <section className={s.ruleSummary} key={i}>
                    <h4>
                      {rule.action === 'require' ? <Paperclip size={17} /> : <AlignLeft size={17} />}
                      {rule.action === 'require'
                        ? 'Требовать приложение'
                        : rule.action === 'append'
                          ? 'Дополнить поле'
                          : 'Заменить текст поля'}
                    </h4>
                    <dl>
                      <dt>Вид акта</dt>
                      <dd>{formTypes[rule.form]}</dd>
                      {rule.action === 'require' ? (
                        <>
                          <dt>Категория</dt>
                          <dd>{attachments[rule.category]}</dd>
                          <dt>Документ</dt>
                          <dd>{rule.document.trim() || 'Любой в категории'}</dd>
                        </>
                      ) : (
                        <>
                          <dt>Поле</dt>
                          <dd>{textFields[rule.field].label}</dd>
                          <dt>Текст</dt>
                          <dd>{rule.text}</dd>
                        </>
                      )}
                      <dt>Работа</dt>
                      <dd>
                        {rule.workContains.trim()
                          ? 'Название содержит «' + rule.workContains + '»'
                          : 'Все работы с нормативом'}
                      </dd>
                      {rule.clause.trim() && (
                        <>
                          <dt>Основание</dt>
                          <dd>{rule.clause}</dd>
                        </>
                      )}
                    </dl>
                  </section>
                ))
              ) : (
                <p className={s.normDescription}>Дополнительных правил нет</p>
              )}
              <button
                className={s.secondary}
                disabled={(row.rules?.length || 0) >= 100}
                onClick={() =>
                  edit({
                    ...row,
                    rules: [
                      ...(row.rules || []),
                      { form: 'hidden', action: 'append', field: 'notes', text: '', clause: '', workContains: '' },
                    ],
                  })
                }
              >
                <Plus size={15} />
                Добавить правило
              </button>
            </Tabs.Content>
            <Tabs.Content value="info" className={s.ruleSummary}>
              <dl>
                <dt>Обозначение</dt>
                <dd>{row.v.name}</dd>
                <dt>Название</dt>
                <dd>{row.v.description || '—'}</dd>
                <dt>Правил</dt>
                <dd>{row.rules?.length || 0}</dd>
              </dl>
            </Tabs.Content>
          </Tabs.Root>
        </aside>
      )}
    </div>
  );
}
