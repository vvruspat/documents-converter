import { useState, useRef } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { AlignLeft, FileText, Paperclip, Pencil, Plus } from 'lucide-react';
import { formTypes, type Entry } from '../../shared/construction';
import { attachments, textFields } from '../../shared/standard-rules';
import { recordTitle } from './Editor';
import { GroupTitle } from '../lists/RecordList';
import type { Group } from '../lists/model';
import s from './projects.module.css';

export function StandardsBrowser({ groups, edit }: { groups: Group<Entry>[]; edit: (row: Entry) => void }) {
  const [selected, setSelected] = useState('');
  const inspector = useRef<HTMLElement>(null);
  function select(id: string) {
    setSelected(id);
    if (matchMedia('(max-width:1080px)').matches) inspector.current?.focus();
  }
  const visible = groups.flatMap((g) => g.rows);
  const row = visible.find((r) => r.id === selected) || visible[0];
  return (
    <div className={s.browser}>
      <section className={s.listPane} aria-label="Справочник нормативов">
        <div className={s.tableScroll}>
          {groups.map((group) => (
            <section key={group.key}>
              <GroupTitle group={group} />
              <table className={s.normTable}>
                <thead>
                  <tr>
                    <th scope="col">Обозначение</th>
                    <th scope="col">Название</th>
                    <th scope="col">Правила</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((item) => (
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
            </section>
          ))}
        </div>
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
