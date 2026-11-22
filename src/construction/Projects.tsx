import { useEffect, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  ChevronRight,
  ClipboardList,
  Download,
  FileArchive,
  FileCheck2,
  FileStack,
  Files,
  Folder,
  FolderOpen,
  Layers3,
  LibraryBig,
  Plus,
  Search,
  Settings2,
  Upload,
  Users,
} from 'lucide-react';
import {
  entry,
  formTypes,
  labels,
  numberOf,
  validateProject,
  type Entry,
  type Kind,
  type ProjectSummary,
  type SavedProject,
} from '../../shared/construction';
import { evaluateStandardRules, withHiddenWorks } from '../../shared/standard-rules';
import { api, Editor, Modal, recordTitle } from './Editor';
import s from './projects.module.css';

const sections: Kind[] = [
  'work',
  'pack',
  'phase',
  'person',
  'material',
  'scheme',
  'protocol',
  'standard',
  'template',
];
const icons = {
  work: ClipboardList,
  pack: FileArchive,
  phase: Layers3,
  person: Users,
  material: FileCheck2,
  scheme: Files,
  protocol: ClipboardList,
  standard: LibraryBig,
  template: FileStack,
};
const single: Record<Kind, string> = {
  work: 'Акт',
  pack: 'Комплект',
  phase: 'Фаза',
  person: 'Ответственное лицо',
  material: 'Материал и сертификат',
  scheme: 'Исполнительная схема',
  protocol: 'Протокол',
  standard: 'Норматив',
  template: 'Шаблон',
};
const json = (value: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
});
function ProjectStart({
  mode,
  close,
  created,
}: {
  mode: 'create' | 'import';
  close: () => void;
  created: (p: SavedProject, warnings: string[]) => void;
}) {
  const [name, setName] = useState(''),
    [phase, setPhase] = useState(''),
    [file, setFile] = useState<File>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [forms, setForms] = useState<Record<string, File>>({});
  async function submit() {
    setBusy(true);
    setError('');
    try {
      if (mode === 'import' && file) {
        const data = new FormData();
        data.append('file', file);
        data.append('phase', phase);
        for (const [key, form] of Object.entries(forms)) data.append(key, form);
        const result = await (await api('/import', { method: 'POST', body: data })).json();
        created(result.project, result.warnings);
      } else created(await (await api('', json({ name, phase }))).json(), []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={mode === 'create' ? 'Новый проект' : 'Импорт из автогенератора'} close={close} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className={s.formBody}>
          {mode === 'import' ? (
            <label className={s.field}>
              Книга автогенератора ИД 5.x
              <input type="file" required accept=".xlsm,.xlsx" onChange={(e) => setFile(e.target.files?.[0])} />
            </label>
          ) : (
            <label className={s.field}>
              Название проекта
              <input
                required
                placeholder="Строительство дома"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <label className={s.field}>
            Первая фаза
            <input required placeholder="Фундамент" value={phase} onChange={(e) => setPhase(e.target.value)} />
          </label>
          {mode === 'import' && (
            <details className={s.extraForms}>
              <summary>Приложить исходные шаблоны Word</summary>
              {Object.entries(formTypes).map(([key, label]) => (
                <label key={key} className={s.field}>
                  {label}
                  <input
                    type="file"
                    accept=".docx"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      setForms((old) => {
                        const next = { ...old };
                        if (file) next[key] = file;
                        else delete next[key];
                        return next;
                      });
                    }}
                  />
                </label>
              ))}
            </details>
          )}
        </div>
        {error && (
          <p className={s.alert} role="alert">
            {error}
          </p>
        )}
        <div className={s.footer}>
          <button type="button" className={s.secondary} disabled={busy} onClick={close}>
            Отмена
          </button>
          <button className={s.primary} disabled={busy}>
            {busy ? 'Загрузка…' : mode === 'import' ? 'Импортировать' : 'Создать проект'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Export({ project, phase, close }: { project: SavedProject; phase: string; close: () => void }) {
  const [pack, setPack] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const packs = project.rows.filter((r) => r.kind === 'pack' && r.links.phase[0] === phase);
  const works = project.rows.filter(
    (r) => r.kind === 'work' && r.links.phase[0] === phase && (!pack || r.links.pack?.includes(pack)),
  );
  const byId = new Map(project.rows.map((r) => [r.id, r]));
  const included = withHiddenWorks(selected.length ? works.filter((r) => selected.includes(r.id)) : works, byId);
  const count = included.length;
  const reviews = included
    .map((work) => ({ work, ...evaluateStandardRules(work, byId) }))
    .filter((item) => item.checks.length || item.changes.size);
  const incomplete = reviews.some((item) => item.checks.some((check) => !check.complete));
  const hasConflict = reviews.some((item) => item.conflicts.length);
  async function exportZip() {
    setBusy(true);
    setError('');
    try {
      const res = await api('/' + project.id + '/report', json({ phase, pack, selected }));
      const url = URL.createObjectURL(await res.blob()),
        a = document.createElement('a');
      a.href = url;
      const encoded = res.headers.get('Content-Disposition')?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      a.download = encoded ? decodeURIComponent(encoded) : 'Комплект ИД.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Выгрузка комплекта" close={close} busy={busy}>
      <div className={s.formBody}>
        <label className={s.field}>
          Комплект ИД
          <select
            value={pack}
            onChange={(e) => {
              setPack(e.target.value);
              setSelected([]);
            }}
          >
            <option value="">Все работы фазы</option>
            {packs.map((r) => (
              <option key={r.id} value={r.id}>
                {recordTitle(r)}
              </option>
            ))}
          </select>
        </label>
        <p>
          В архив войдут акты Word, реестр Excel и загруженные оригиналы приложений. Для частичной выгрузки
          отметьте нужные работы.
        </p>
        <div className={s.checks}>
          {works.map((r) => (
            <label key={r.id}>
              <input
                type="checkbox"
                checked={selected.includes(r.id)}
                onChange={(e) =>
                  setSelected(e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id))
                }
              />
              {recordTitle(r)}
            </label>
          ))}
        </div>
        {reviews.length > 0 && (
          <section className={s.ruleSection}>
            <h3>Проверка нормативов</h3>
            {reviews.map(({ work, checks, changes, conflicts }) => (
              <div className={s.rule} key={work.id}>
                <strong>{recordTitle(work)}</strong>
                <ul>
                  {[...changes].map(([key, change]) => (
                    <li key={key}>
                      {change.label} · {[...change.sources].join(', ')}
                      {[...change.replacements].map((text) => (
                        <div key={'r' + text}>Заменить на «{text}»</div>
                      ))}
                      {[...change.additions].map((text) => (
                        <div key={'a' + text}>Добавить «{text}»</div>
                      ))}
                    </li>
                  ))}
                  {checks.map((check, i) => (
                    <li key={i}>
                      {check.document} · {check.basis} · <strong>{check.status}</strong>
                    </li>
                  ))}
                </ul>
                {conflicts.length > 0 && (
                  <p role="alert">Укажите одну замену для поля «{conflicts.join(', ')}».</p>
                )}
              </div>
            ))}
          </section>
        )}
        {!works.length && <p>В этом комплекте пока нет работ.</p>}
      </div>
      {error && (
        <p className={s.alert} role="alert">
          {error}
        </p>
      )}
      <div className={s.footer}>
        <button className={s.secondary} disabled={busy} onClick={close}>
          Отмена
        </button>
        <button className={s.primary} disabled={busy || !count || hasConflict} onClick={() => void exportZip()}>
          <Download size={16} />
          {busy ? 'Сборка…' : incomplete ? 'Скачать ZIP с замечаниями' : 'Скачать ZIP'} · {count}
        </button>
      </div>
    </Modal>
  );
}
function Workspace({ initial, back, warnings }: { initial: SavedProject; back: () => void; warnings: string[] }) {
  const [project, setProject] = useState(initial),
    [phase, setPhase] = useState(initial.rows.find((r) => r.kind === 'phase')?.id || ''),
    [tab, setTab] = useState<Kind>('work');
  const [query, setQuery] = useState(''),
    [page, setPage] = useState(0),
    [edit, setEdit] = useState<Entry | 'settings' | null>(null),
    [exporting, setExporting] = useState(false);
  const rows = project.rows.filter(
    (r) => r.kind === tab && (!['work', 'pack'].includes(tab) || r.links.phase?.includes(phase)),
  );
  const result = rows.filter((r) => recordTitle(r).toLowerCase().includes(query.toLowerCase())),
    current = Math.min(page, Math.max(0, Math.ceil(result.length / 25) - 1));
  const incomingTemplates = project.rows.filter((r) => r.kind === 'template' && r.v.form === 'incoming');
  const [avkTemplate, setAvkTemplate] = useState('');
  const phases = project.rows.filter((r) => r.kind === 'phase'),
    existing = edit && edit !== 'settings' && project.rows.some((r) => r.id === edit.id);
  async function persist(next: SavedProject, file?: File, id?: string) {
    const error = validateProject(next);
    if (error) throw Error(error);
    let init: RequestInit;
    if (file) {
      const data = new FormData();
      data.append('project', JSON.stringify({ v: next.v, rows: next.rows }));
      data.append('version', String(project.version));
      data.append('entry', id!);
      data.append('file', file);
      init = { method: 'PUT', body: data };
    } else
      init = { ...json({ project: { v: next.v, rows: next.rows }, version: project.version }), method: 'PUT' };
    const saved: SavedProject = await (await api('/' + project.id, init)).json();
    setProject(saved);
    if (!saved.rows.some((r) => r.id === phase)) setPhase(saved.rows.find((r) => r.kind === 'phase')?.id || '');
    setEdit(null);
  }
  function add() {
    const r = entry(tab, { name: '' });
    if (tab === 'work' || tab === 'pack') r.links.phase = phase ? [phase] : [];
    if (tab === 'work') {
      r.links.template = project.rows
        .filter((x) => x.kind === 'template')
        .slice(0, 1)
        .map((t) => t.id);
      r.v.copies = '2';
    }
    if (tab === 'template') r.v.form = 'hidden';
    if (tab === 'person') r.v.role = 'СК Заказчика';
    setEdit(r);
  }
  const rowDetails = (r: Entry) => {
    switch (r.kind) {
      case 'work':
        return [project.rows.find((t) => t.id === r.links.template?.[0])?.v.name, numberOf(project, r), r.v.date]
          .filter(Boolean)
          .join(' · ');
      case 'template':
        return r.file || (r.v.needsFile === 'да' ? 'Загрузите форму DOCX' : 'Базовая форма DOCX');
      case 'person':
        return [r.v.role, r.v.position, r.v.company].filter(Boolean).join(' · ');
      case 'standard':
        return r.v.description;
      case 'phase':
        return 'Актов · ' + project.rows.filter((w) => w.kind === 'work' && w.links.phase[0] === r.id).length;
      case 'pack':
        return 'Актов · ' + project.rows.filter((w) => w.kind === 'work' && w.links.pack?.includes(r.id)).length;
      default:
        return [r.v.docType, r.v.number, r.v.date, r.file || 'Без оригинала'].filter(Boolean).join(' · ');
    }
  };
  return (
    <section className={s.root}>
      <button className={s.back} onClick={back}>
        <ArrowLeft size={15} />
        Все проекты
      </button>
      <div className={s.heading}>
        <div>
          <div className={s.kicker}>
            <Building2 size={15} /> Проект
          </div>
          <h1>{project.v.name}</h1>
          {project.v.address && <p>{project.v.address}</p>}
        </div>
        <button className={s.primary} disabled={!phase} onClick={() => setExporting(true)}>
          <Download size={16} /> Выгрузить комплект
        </button>
      </div>
      {!!warnings.length && (
        <details className={s.alert}>
          <summary>Замечания при импорте · {warnings.length}</summary>
          {warnings.map((w) => (
            <p key={w}>{w}</p>
          ))}
        </details>
      )}
      <Tabs.Root
        className={s.workspace}
        value={tab}
        orientation="vertical"
        onValueChange={(v) => {
          setTab(v as Kind);
          setPage(0);
          setQuery('');
        }}
      >
        <aside className={s.sidebar}>
          <label className={s.field}>
            Текущая фаза
            <select
              value={phase}
              onChange={(e) => {
                setPhase(e.target.value);
                setPage(0);
              }}
            >
              {phases.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.v.name}
                </option>
              ))}
            </select>
          </label>
          <Tabs.List aria-label="Разделы проекта" className={s.menu}>
            {sections.map((k) => {
              const Icon = icons[k];
              return (
                <Tabs.Trigger key={k} value={k}>
                  <Icon size={16} />
                  {labels[k]}
                </Tabs.Trigger>
              );
            })}
          </Tabs.List>
          <button className={s.settings} onClick={() => setEdit('settings')}>
            <Settings2 size={16} />
            Реквизиты и настройки
          </button>
        </aside>
        <Tabs.Content key={tab} value={tab} className={s.panel}>
          <div className={s.rowHeading}>
            <h2>
              {labels[tab]} <span>{rows.length}</span>
            </h2>
            <button className={s.secondary} onClick={add}>
              <Plus size={16} />
              Добавить
            </button>
          </div>
          {tab === 'material' && rows.length > 0 && incomingTemplates.length > 0 && (
            <div className={s.incoming}>
              {incomingTemplates.length > 1 && (
                <label className={s.field}>
                  Шаблон АВК
                  <select
                    value={avkTemplate || incomingTemplates[0].id}
                    onChange={(e) => setAvkTemplate(e.target.value)}
                  >
                    {incomingTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.v.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <a
                className={s.secondary}
                download
                href={
                  '/api/construction/' +
                  project.id +
                  '/incoming/' +
                  (incomingTemplates.find((t) => t.id === avkTemplate)?.id || incomingTemplates[0].id)
                }
              >
                <Download size={15} />
                Журнал входного контроля и АВК
              </a>
            </div>
          )}
          <label className={s.search}>
            <Search size={16} />
            <input
              aria-label="Поиск записей"
              placeholder="Поиск по названию или номеру"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </label>
          {result.slice(current * 25, current * 25 + 25).map((r) => (
            <button className={s.record} key={r.id} onClick={() => setEdit(r)}>
              <span>
                <strong>{r.v.name}</strong>
                <small>{rowDetails(r)}</small>
              </span>
              <ChevronRight size={16} />
            </button>
          ))}
          {!result.length && (
            <div className={s.empty}>
              <FolderOpen size={30} />
              <h3>{query ? 'Совпадений нет' : 'Пока нет записей'}</h3>
              {!query && (
                <button className={s.text} onClick={add}>
                  Добавить первую запись
                </button>
              )}
            </div>
          )}
          {result.length > 25 && (
            <div className={s.pager}>
              <button disabled={!current} onClick={() => setPage(current - 1)}>
                Назад
              </button>
              <span>
                {current * 25 + 1}–{Math.min(result.length, current * 25 + 25)} из {result.length}
              </span>
              <button disabled={(current + 1) * 25 >= result.length} onClick={() => setPage(current + 1)}>
                Далее
              </button>
            </div>
          )}
        </Tabs.Content>
      </Tabs.Root>
      {edit && (
        <Editor
          project={project}
          row={edit === 'settings' ? undefined : edit}
          title={edit === 'settings' ? 'Реквизиты и настройки' : single[edit.kind]}
          close={() => setEdit(null)}
          remove={
            existing
              ? () => persist({ ...project, rows: project.rows.filter((r) => r.id !== edit.id) })
              : undefined
          }
          save={(v, links, file, detach, rules) => {
            if (edit === 'settings') return persist({ ...project, v });
            const r = { ...edit, v, links, rules };
            if (detach) delete r.file;
            return persist(
              {
                ...project,
                rows: existing ? project.rows.map((x) => (x.id === r.id ? r : x)) : [...project.rows, r],
              },
              file,
              r.id,
            );
          }}
        />
      )}
      {exporting && <Export project={project} phase={phase} close={() => setExporting(false)} />}
    </section>
  );
}
export function Projects() {
  const [items, setItems] = useState<ProjectSummary[]>([]),
    [active, setActive] = useState<SavedProject>(),
    [mode, setMode] = useState<'create' | 'import'>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [warnings, setWarnings] = useState<string[]>([]);
  async function list() {
    setLoading(true);
    setError('');
    try {
      setItems(await (await api('')).json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const sync = () => {
      const id = new URLSearchParams(location.search).get('project');
      if (id && /^[0-9a-f-]{36}$/i.test(id)) void open(id);
      else {
        setActive(undefined);
        void list();
      }
    };
    sync();
    addEventListener('popstate', sync);
    return () => removeEventListener('popstate', sync);
  }, []);
  function select(id: string) {
    history.pushState(null, '', '/projects?project=' + encodeURIComponent(id));
    void open(id);
  }
  async function open(id: string) {
    setLoading(true);
    setError('');
    try {
      setActive(await (await api('/' + id)).json());
      setWarnings([]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  if (active)
    return (
      <Workspace
        key={active.id}
        initial={active}
        warnings={warnings}
        back={() => {
          history.pushState(null, '', '/projects');
          setActive(undefined);
          void list();
        }}
      />
    );
  return (
    <section className={s.root}>
      <div className={s.heading}>
        <div>
          <div className={s.kicker}>
            <Layers3 size={15} />
            Исполнительная документация
          </div>
          <h1>Строительные проекты</h1>
        </div>
        <div className={s.actions}>
          <button className={s.secondary} onClick={() => setMode('import')}>
            <Upload size={16} />
            Импорт Excel
          </button>
          <button className={s.primary} onClick={() => setMode('create')}>
            <Plus size={17} />
            Новый проект
          </button>
        </div>
      </div>
      {error && (
        <div className={s.alert} role="alert">
          {error} <button onClick={() => void list()}>Повторить</button>
        </div>
      )}
      {loading ? (
        <p role="status">Загрузка проектов…</p>
      ) : items.length ? (
        <div className={s.cards}>
          {items.map((p) => (
            <button key={p.id} className={s.card} onClick={() => select(p.id)}>
              <Folder size={23} />
              <h2>{p.name}</h2>
              <div>
                <span>
                  Фазы · {p.phases}　 Акты · {p.works}
                </span>
                <ArrowRight size={17} />
              </div>
            </button>
          ))}
        </div>
      ) : (
        !error && (
          <div className={s.empty}>
            <Building2 size={35} />
            <h3>Первый строительный проект</h3>
            <p>Начните с названия объекта и первой фазы или перенесите данные из книги автогенератора.</p>
          </div>
        )
      )}
      {mode && (
        <ProjectStart
          mode={mode}
          close={() => setMode(undefined)}
          created={(p, w) => {
            setMode(undefined);
            history.pushState(null, '', '/projects?project=' + encodeURIComponent(p.id));
            setActive(p);
            setWarnings(w);
          }}
        />
      )}
    </section>
  );
}
