import { useMemo, useState } from 'react';
import { ChevronDown, Download, ExternalLink, FileArchive, Pencil, Plus } from 'lucide-react';
import { WorkRegister } from './WorkRegister';
import { packagePlan } from '../../shared/readiness';
import { entry, type Entry, type SavedProject } from '../../shared/construction';
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
function PackageDocuments({ pack, records, edit }: {
  pack: Entry;
  records: Map<string, Entry>;
  edit: (entry: Entry) => void;
}) {
  const [open, setOpen] = useState(false);
  const groups = new Map<string, Entry[]>();
  for (const [key, title] of [
    ['materials', 'Материалы и сертификаты'],
    ['schemes', 'Исполнительные схемы'],
    ['protocols', 'Протоколы'],
    ['attachments', 'Реестры и приложения'],
  ]) {
    for (const id of pack.links[key] || []) {
      const doc = records.get(id);
      if (!doc) continue;
      const act = key === 'protocols' && /^акт(?:\s|$)/i.test(doc.v.docType || doc.v.name);
      const label = act ? 'Акты контроля и испытаний' : title;
      const items = groups.get(label);
      if (items) items.push(doc);
      else groups.set(label, [doc]);
    }
  }
  if (!groups.size) return null;
  return (
    <details className={s.documentGroups} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Документы комплекта</summary>
      {open && Array.from(groups, ([label, docs]) => (
        <details key={label}>
          <summary>{label} · {docs.length}</summary>
          <ul>
            {docs.map((doc) => (
              <li key={doc.id}>
                <button className={s.text} onClick={() => edit(doc)}>
                  {Array.from(new Set([doc.v.docType, doc.v.name, doc.v.number].filter(Boolean))).join(' · ')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </details>
  );
}
function PackageCard({
  item,
  initiallyOpen,
  records,
  edit,
  plan,
  download,
}: {
  item: Pack;
  initiallyOpen: boolean;
  records: Map<string, Entry>;
  edit: (r: Entry, documents?: boolean) => void;
  plan: (id: string, name: string) => Promise<void>;
  download: (id: string) => void;
}) {
  const { pack, steps, ready, status } = item;
  const [open, setOpen] = useState(initiallyOpen);
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
    <details open={open} className={s.package} onToggle={(e) => setOpen(e.currentTarget.open)}>
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
          <div className={s.registerActions}>
            <button className={s.secondary} onClick={() => edit(entry('work', { name: '' }, { pack: [pack.id] }))}>
              <Plus size={15} /> Новый акт
            </button>
            {pack.v.sourceJob && (
              <a className={s.text} href={`/api/registry/${encodeURIComponent(pack.v.sourceJob)}/source`}
                target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Исходный том PDF
              </a>
            )}
          </div>
          {steps.length > 0 && <WorkRegister steps={steps} packId={pack.id} edit={edit} />}
          <PackageDocuments pack={pack} records={records} edit={edit} />
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
  edit: (r: Entry, documents?: boolean) => void;
  plan: (id: string, name: string) => Promise<void>;
  download: (id: string) => void;
}) {
  const records = useMemo(() => new Map(project.rows.map((r) => [r.id, r])), [project]);
  const packs = useMemo(() => packagePlan(project.rows), [project]);
  return (
    <>
      {packs.length > 1 && (
        <p className={s.packTotals}>
          Готовых комплектов{' '}
          <strong>
            {packs.filter((p) => p.status === 'Готово').length} из {packs.length}
          </strong>
        </p>
      )}
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
                <PackageCard
                  key={item.pack.id}
                  item={item}
                  records={records}
                  initiallyOpen={packs.length === 1}
                  edit={edit}
                  plan={plan}
                  download={download}
                />
              ))}
            </section>
          ))
        }
      </RecordList>
    </>
  );
}
