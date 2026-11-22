import { useMemo, useState } from 'react';
import { Check, ChevronRight, Circle } from 'lucide-react';
import type { packagePlan } from '../../shared/readiness';
import type { Entry } from '../../shared/construction';
import { RecordList } from '../lists/RecordList';
import type { Column } from '../lists/model';
import { WorkChecklist } from './WorkChecklist';
import s from './register.module.css';

type Step = ReturnType<typeof packagePlan>[number]['steps'][number];
function registerRow(step: Step) {
  const fields = new Map(step.checklist.filter((c) => c.field).map((c) => [c.field, c]));
  const originals = new Map(
    step.checklist.filter((c) => c.document?.part === 'original').map((c) => [c.document!.key, c]),
  );
  const documents = step.checklist
    .filter((c) => c.document?.part === 'link')
    .map((link) => ({ link, original: originals.get(link.document!.key)! }));
  function workDate(key: 'start' | 'end') {
    return step.work.v[key] || fields.get(key)?.detail;
  }
  return {
    ...step,
    fields,
    start: workDate('start'),
    end: workDate('end'),
    documents,
    linked: documents.filter((d) => d.link.present).length,
    files: documents.filter((d) => d.original.present).length,
  };
}
type Row = ReturnType<typeof registerRow>;
const columns: Column<Row>[] = [
  { key: 'status', label: 'Готовность', value: (r) => r.status },
  { key: 'name', label: 'Работа', value: (r) => r.work.v.name || 'Шаг без названия' },
  { key: 'number', label: 'Номер акта', value: (r) => r.work.v.number },
  { key: 'date', label: 'Дата акта', value: (r) => r.work.v.date },
  { key: 'template', label: 'Вид акта', value: (r) => r.fields.get('template')?.detail },
  { key: 'start', label: 'Начало работ', value: (r) => r.start },
  { key: 'end', label: 'Окончание работ', value: (r) => r.end },
  { key: 'evidence', label: 'Документы', value: (r) => r.documents.map((d) => d.link.label) },
  {
    key: 'originals',
    label: 'Оригиналы',
    value: (r) => (r.documents.length ? r.files + '/' + r.documents.length : ''),
  },
  {
    key: 'issues',
    label: 'Что заполнить',
    value: (r) => r.checklist.filter((c) => !c.present).map((c) => c.label),
  },
];
function Mark({ present }: { present: boolean }) {
  return (
    <span className={s.mark} data-present={present} role="img" aria-label={present ? 'Есть' : 'Нет'}>
      {present ? <Check size={15} /> : <Circle size={11} />}
    </span>
  );
}
function Count({ present, total }: { present: number; total: number }) {
  return total ? (
    <span className={s.count}>
      <Mark present={present === total} />
      {present}/{total}
    </span>
  ) : (
    <span title="Нет документов">—</span>
  );
}
const date = (value?: string) => value?.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3.$2.$1') || '—';
function RegisterLine({ row, edit }: { row: Row; edit: (r: Entry) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { work, fields, documents, position } = row;
  const name = work.v.name || 'Шаг без названия';
  const otherChecks = row.checklist.filter((c) => !c.document && (!c.field || c.field === 'templateFile'));
  const signers = fields.get('signers');
  const title = 'Подробности шага ' + position;
  return (
    <>
      <tr className={s.line}>
        <td>
          <button
            type="button"
            aria-label={title}
            title={title}
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className={s.expand}
          >
            <ChevronRight size={15} />
          </button>
        </td>
        <td className={s.position}>{position}</td>
        <th scope="row">
          <button type="button" className={s.edit} title={name} onClick={() => edit(work)}>
            {name}
          </button>
          {row.dependent && <small>Связанный АОСР</small>}
        </th>
        <td>{fields.get('template')?.detail || '—'}</td>
        <td>{work.v.number || '—'}</td>
        <td>{date(row.start)}</td>
        <td>{date(row.end)}</td>
        <td>{date(work.v.date)}</td>
        <td title={signers?.detail}>
          <Mark present={!!signers?.present} />
        </td>
        <td>
          <Count present={row.linked} total={documents.length} />
        </td>
        <td>
          <Count present={row.files} total={documents.length} />
        </td>
        <td>
          <span className={s.state} data-status={row.status}>
            {row.status}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={12} className={s.details}>
            <strong className={s.detailName}>{name}</strong>
            {documents.length > 0 && (
              <table className={s.documents} aria-label={'Документы шага ' + position}>
                <thead>
                  <tr>
                    <th scope="col">Документ</th>
                    <th scope="col">Привязан</th>
                    <th scope="col">Оригинал</th>
                  </tr>
                </thead>
                <tbody>
                  {documents.map(({ link, original }) => (
                    <tr key={link.document!.key}>
                      <th scope="row" title={link.detail}>
                        {link.label}
                      </th>
                      <td>
                        <Mark present={link.present} />
                      </td>
                      <td title={original.detail}>
                        <Mark present={original.present} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className={s.extra}>
              <span>Подписанты</span> {signers?.detail || '—'}
            </div>
            {!documents.length && (
              <div className={s.extra}>
                <span>Подтверждающие документы</span> —
              </div>
            )}
            {otherChecks.length > 0 && <WorkChecklist items={otherChecks} />}
          </td>
        </tr>
      )}
    </>
  );
}
export function WorkRegister({
  steps,
  packId,
  edit,
}: {
  steps: Step[];
  packId: string;
  edit: (r: Entry) => void;
}) {
  const rows = useMemo(() => steps.map(registerRow), [steps]);
  return (
    <RecordList
      scope={'construction.packSteps.' + packId}
      rows={rows}
      columns={columns}
      placeholder="Поиск по шагам"
    >
      {(groups) => (
        <div className={s.scroll} role="region" aria-label="Таблица работ" tabIndex={0}>
          <table className={s.sheet} aria-label="Акты и работы комплекта">
            <thead>
              <tr>
                {[
                  '',
                  '№',
                  'Работа',
                  'Вид акта',
                  '№ акта',
                  'Начало',
                  'Окончание',
                  'Дата акта',
                  'Подписанты',
                  'Документы',
                  'Оригиналы',
                  'Готовность',
                ].map((label, i) => (
                  <th key={i} scope="col">
                    {label || <span className="visually-hidden">Подробности</span>}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.key}>
                {group.label && (
                  <tr>
                    <th colSpan={12} scope="rowgroup" className={s.group}>
                      {group.label} · {group.total}
                    </th>
                  </tr>
                )}
                {group.rows.map((row) => (
                  <RegisterLine key={row.work.id} row={row} edit={edit} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </RecordList>
  );
}
