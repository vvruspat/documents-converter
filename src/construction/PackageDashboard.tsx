import { useMemo, useState } from 'react';
import { ChevronDown, Download, FileArchive, Pencil, Plus } from 'lucide-react';
import { WorkChecklist } from './WorkChecklist';
import { packagePlan } from '../../shared/readiness';
import type { Entry, SavedProject } from '../../shared/construction';
import { RecordList, GroupTitle } from '../lists/RecordList';
import type { Column } from '../lists/model';
import s from './projects.module.css';

type Pack = ReturnType<typeof packagePlan>[number];
const columns: Column<Pack>[] = [
  { key: 'status', label: 'Готовность', value: (r) => r.status },
  { key: 'name', label: 'Название комплекта', value: (r) => r.pack.v.name },
  { key: 'number', label: 'Номер комплекта', value: (r) => r.pack.v.number },
  { key: 'works', label: 'Число актов', value: (r) => r.steps.length },
  { key: 'ready', label: 'Готовые акты', value: (r) => r.ready },
];
const stepColumns: Column<Pack['steps'][number]>[] = [
  { key: 'status', label: 'Готовность', value: (s) => s.status },
  { key: 'name', label: 'Работа', value: (s) => s.work.v.name || 'Шаг без названия' },
  { key: 'number', label: 'Номер акта', value: (s) => s.work.v.number },
  { key: 'date', label: 'Дата акта', value: (s) => s.work.v.date },
  {
    key: 'issues',
    label: 'Что заполнить',
    value: (s) => s.checklist.filter((c) => !c.present).map((c) => c.label),
  },
];
function PackageCard({
  item,
  edit,
  plan,
  download,
}: {
  item: Pack;
  edit: (r: Entry) => void;
  plan: (id: string, name: string) => Promise<void>;
  download: (id: string) => void;
}) {
  const { pack, steps, ready, status } = item;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function add() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await plan(pack.id, name.trim());
      setName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className={s.package} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <FileArchive size={18} />
        <strong>{[pack.v.number, pack.v.name].filter(Boolean).join(' · ')}</strong>
        <span className={s.status} data-status={status}>
          {status}
        </span>
        <span>
          Готово {ready} из {steps.length}
        </span>
        <ChevronDown size={15} />
      </summary>
      {open && (
        <div className={s.planBody}>
          {steps.length > 0 && (
            <RecordList
              scope={'construction.packSteps.' + pack.id}
              rows={steps}
              columns={stepColumns}
              placeholder="Поиск по шагам"
            >
              {(groups) =>
                groups.map((group) => (
                  <section key={group.key}>
                    <GroupTitle group={group} />
                    {group.rows.map(({ work, status, checklist, dependent, position }) => (
                      <article key={work.id} className={s.stepCard}>
                        <button className={s.step} onClick={() => edit(work)}>
                          <span className={s.stepIndex}>{position}</span>
                          <span>
                            <strong>{work.v.name || 'Шаг без названия'}</strong>
                            {dependent && <small>Связанный АОСР</small>}
                          </span>
                          <span className={s.status} data-status={status}>
                            {status}
                          </span>
                          <Pencil size={14} />
                        </button>
                        <WorkChecklist items={checklist} />
                      </article>
                    ))}
                  </section>
                ))
              }
            </RecordList>
          )}
          <form
            className={s.planForm}
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <input
              aria-label="Название планируемой работы"
              placeholder="Название планируемой работы"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32000}
            />
            <button className={s.secondary} disabled={busy}>
              <Plus size={15} />
              Добавить шаг
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
          <div className={s.actions}>
            <button className={s.text} onClick={() => edit(pack)}>
              <Pencil size={14} />
              Изменить комплект
            </button>
            <button className={s.text} disabled={!steps.length} onClick={() => download(pack.id)}>
              <Download size={14} />
              Выгрузить комплект
            </button>
          </div>
        </div>
      )}
    </details>
  );
}
export function PackageDashboard({
  project,
  edit,
  plan,
  download,
}: {
  project: SavedProject;
  edit: (r: Entry) => void;
  plan: (id: string, name: string) => Promise<void>;
  download: (id: string) => void;
}) {
  const packs = useMemo(() => packagePlan(project.rows), [project]);
  return (
    <>
      <div className={s.metrics}>
        {[
          ['Всего комплектов', packs.length],
          ['Готовы к выгрузке', packs.filter((p) => p.status === 'Готово').length],
          ['Требуют заполнения', packs.filter((p) => p.status !== 'Готово').length],
        ].map(([label, n]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{n}</strong>
          </div>
        ))}
      </div>
      <RecordList
        scope={'construction.' + project.id + '.pack'}
        rows={packs}
        columns={columns}
        placeholder="Поиск по комплектам"
        empty="Добавьте первый комплект, чтобы запланировать работы."
      >
        {(groups) =>
          groups.map((group) => (
            <section key={group.key}>
              <GroupTitle group={group} />
              {group.rows.map((item) => (
                <PackageCard key={item.pack.id} item={item} edit={edit} plan={plan} download={download} />
              ))}
            </section>
          ))
        }
      </RecordList>
    </>
  );
}
