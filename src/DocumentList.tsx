import { RecordList, GroupTitle } from './lists/RecordList';
import type { Column } from './lists/model';
import { useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronRight, ClipboardList, FileBadge, FileText, Shapes } from 'lucide-react';
import { fieldLabels, type Field } from '../shared/scan';
import { ScanComparison } from './ScanComparison';
import { type Card, type Source } from '../shared/catalog';

const icons = { Акт: ClipboardList, Паспорт: BookOpen, Сертификат: FileBadge, 'Исполнительная схема': Shapes };
function DocumentIcon({ kind }: { kind: string }) {
  const Icon = icons[kind as keyof typeof icons] ?? FileText;
  return (
    <span className="document-icon" data-kind={kind}>
      <Icon size={18} />
    </span>
  );
}
export function SourceLink({ source }: { source: Source }) {
  return (
    <a
      className="source-link"
      href={`/api/registry/${source.job}/source#page=${source.first}`}
      target="_blank"
      rel="noreferrer"
    >
      <FileText size={15} />
      <span>
        {source.file} · стр. {source.first}
        {source.last !== source.first && '–' + source.last}
      </span>
      <ArrowUpRight size={15} />
    </a>
  );
}
function ScanShortcut({ source }: { source: Source }) {
  return (
    <a
      className="scan-shortcut"
      target="_blank"
      rel="noreferrer"
      href={`/api/registry/${source.job}/source#page=${source.first}`}
    >
      <span>{source.file}</span>
      <small>
        Лист {source.first}
        {source.last !== source.first && '–' + source.last} ↗
      </small>
    </a>
  );
}
function shownField(card: Card, field: Field) {
  if (card.reviewFields.includes(field))
    return (
      <mark className="review-value" title={fieldLabels[field] + ' · проверить'}>
        {card[field] || 'Не удалось прочитать'}
      </mark>
    );
  return card[field] || '—';
}
const documentFields = {
  kind: 'Вид документа',
  name: 'Название',
  number: 'Номер',
  organization: 'Организация',
  date: 'Дата',
  material: 'Материал',
  batch: 'Партия',
  work: 'Вид работ',
  floor: 'Этаж',
  section: 'Секция',
} as const;
export function DocumentList({ cards, loading, project }: { cards: Card[]; loading: boolean; project: string }) {
  const [opened, setOpened] = useState<{ card: Card; job?: string }>();
  const volumes = new Map(cards.flatMap((card) => card.sources.map((s) => [s.job, s.file] as const)));
  const columns: Column<Card>[] = Object.entries(documentFields).map(([key, label]) => ({
    key,
    label,
    value: (c) => c[key as keyof typeof documentFields],
  }));
  columns.push(
    {
      key: 'review',
      label: 'Проверка',
      value: (c) => (c.uncertain ? 'Требуют проверки' : 'Проверка не требуется'),
    },
    {
      key: 'volume',
      label: 'Исходный PDF',
      value: (c) => c.sources.map((s) => s.job),
      display: (id) => volumes.get(id) || id,
    },
  );
  return (
    <section className="library-panel">
      <RecordList
        scope={'archive.documents.' + project}
        rows={cards}
        columns={columns}
        quickFilter={{ key: 'review', value: 'Требуют проверки' }}
        pageSize={20}
        placeholder="Поиск по документам"
        empty={loading ? 'Загружаем документы…' : 'В проекте пока нет документов'}
      >
        {(groups, config) =>
          groups.map((group) => (
            <section key={group.key}>
              <GroupTitle group={group} />
              <div className="history-scroll">
                <table className="document-table">
                  <thead>
                    <tr>
                      <th>Документ</th>
                      <th>Организация</th>
                      <th>Дата</th>
                      <th className="scan-column">Исходник</th>
                      <th aria-label="Открыть" />
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((c) => {
                      const source = c.sources.find((s) => config.filters.volume?.includes(s.job)) ?? c.sources[0];
                      const open = () => setOpened({ card: c, job: source.job });
                      return (
                        <tr key={c.id} onClick={open}>
                          <td>
                            <div className="document-title">
                              <DocumentIcon kind={c.kind} />
                              <div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    open();
                                  }}
                                >
                                  {shownField(c, 'name')}
                                </button>
                                <small>
                                  {c.kind}
                                  {(c.number || c.reviewFields.includes('number')) && (
                                    <> · {shownField(c, 'number')}</>
                                  )}
                                </small>
                              </div>
                            </div>
                          </td>
                          <td>{shownField(c, 'organization')}</td>
                          <td>{shownField(c, 'date')}</td>
                          <td className="scan-column" onClick={(e) => e.stopPropagation()}>
                            <ScanShortcut source={source} />
                          </td>
                          <td>
                            <ChevronRight size={15} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        }
      </RecordList>
      {opened && (
        <ScanComparison preferredJob={opened.job || ''} card={opened.card} close={() => setOpened(undefined)} />
      )}
    </section>
  );
}
