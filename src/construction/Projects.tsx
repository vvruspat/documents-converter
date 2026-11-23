import { PackageDashboard } from './PackageDashboard';
import { WorkChecklist } from './WorkChecklist';
import { assessWorks } from '../../shared/readiness';
import { RecordList, GroupTitle } from '../lists/RecordList';
import { entryColumns, projectColumns } from './listColumns';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Home,
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
  Layers3,
  LibraryBig,
  Plus,
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
import { StandardsBrowser } from './StandardsBrowser';
import { AppShell, type ShellProps } from '../AppShell';
import s from './projects.module.css';

const sections: Kind[] = ['pack', 'work', 'material', 'scheme', 'protocol', 'person', 'standard', 'template'];
const icons = {
  work: ClipboardList,
  pack: FileArchive,
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
    [pack, setPack] = useState(''),
    [includeNotes, setIncludeNotes] = useState(false),
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
        data.append('pack', pack);
        if (includeNotes) data.append('includeNotes', 'true');
        for (const [key, form] of Object.entries(forms)) data.append(key, form);
        const result = await (await api('/import', { method: 'POST', body: data })).json();
        created(result.project, result.warnings);
      } else created(await (await api('', json({ name, pack }))).json(), []);
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
            {mode === 'create' ? 'Первый комплект' : 'Комплект для работ без привязки в Excel'}
            <input
              required={mode === 'create'}
              placeholder={mode === 'create' ? 'Фундамент' : 'Основной комплект'}
              value={pack}
              onChange={(e) => setPack(e.target.value)}
            />
          </label>
          {mode === 'import' && (
            <label className={s.importOption}>
              <input type="checkbox" checked={includeNotes} onChange={(e) => setIncludeNotes(e.target.checked)} />
              Включить строки только с дополнительными сведениями
            </label>
          )}
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
function Export({
  project,
  initialPack,
  close,
}: {
  project: SavedProject;
  initialPack: string;
  close: () => void;
}) {
  const [pack, setPack] = useState(initialPack),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const packs = project.rows.filter((r) => r.kind === 'pack');
  const works = project.rows.filter((r) => r.kind === 'work' && r.links.pack?.includes(pack));
  const byId = new Map(project.rows.map((r) => [r.id, r]));
  const included = withHiddenWorks(selected.length ? works.filter((r) => selected.includes(r.id)) : works, byId);
  const count = included.length;
  const reviews = included
    .map((work) => ({ work, ...evaluateStandardRules(work, byId) }))
    .filter((item) => item.changes.size);
  const assessments = assessWorks(byId);
  const findings = included.map((work) => ({ work, checklist: assessments.get(work.id)!.checklist }));
  const incomplete = findings.some((r) => r.checklist.some((c) => !c.present));
  const blocked = findings.some((r) => r.checklist.some((c) => c.blocking && !c.present));
  async function exportZip() {
    setBusy(true);
    setError('');
    try {
      const res = await api('/' + project.id + '/report', json({ pack, selected }));
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
        {findings.length > 0 && (
          <details className={s.ruleSection} open={blocked}>
            <summary>Готовность этапов</summary>
            {findings.map((r) => (
              <section key={r.work.id}>
                <h4>{recordTitle(r.work)}</h4>
                <WorkChecklist items={r.checklist} />
              </section>
            ))}
          </details>
        )}
        {reviews.length > 0 && (
          <section className={s.ruleSection}>
            <h3>Проверка нормативов</h3>
            {reviews.map(({ work, changes }) => (
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
                </ul>
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
        <button className={s.primary} disabled={busy || !count || blocked} onClick={() => void exportZip()}>
          <Download size={16} />
          {busy ? 'Сборка…' : incomplete ? 'Скачать ZIP с замечаниями' : 'Скачать ZIP'} · {count}
        </button>
      </div>
    </Modal>
  );
}
function Workspace({
  initial,
  back,
  warnings,
  shell,
  notice,
  options,
  switchProject,
}: {
  initial: SavedProject;
  back: () => void;
  warnings: string[];
  shell: ShellProps;
  notice: ReactNode;
  options: ProjectSummary[];
  switchProject: (id: string) => void;
}) {
  const [project, setProject] = useState(initial),
    [tab, setTab] = useState<Kind>(() => {
      const section = new URLSearchParams(location.search).get('section');
      return sections.find((kind) => kind === section) || 'pack';
    });
  const [edit, setEdit] = useState<Entry | 'settings' | null>(null),
    [exporting, setExporting] = useState<string>();
  const [openDocuments, setOpenDocuments] = useState(false);
  const rows = project.rows.filter((r) => r.kind === tab);
  const columns = useMemo(() => entryColumns(project, tab), [project, tab]);
  const scope = 'construction.' + project.id + '.' + tab;
  const incomingTemplates = project.rows.filter((r) => r.kind === 'template' && r.v.form === 'incoming');
  const [avkTemplate, setAvkTemplate] = useState('');
  const packs = project.rows.filter((r) => r.kind === 'pack'),
    existing = edit && edit !== 'settings' && project.rows.some((r) => r.id === edit.id);
  async function persist(next: SavedProject, uploads: { id: string; file: File }[] = []) {
    const error = validateProject(next);
    if (error) throw Error(error);
    let init: RequestInit;
    if (uploads.length) {
      if (uploads.length > 4) throw Error('За одно сохранение можно загрузить до 4 оригиналов.');
      if (uploads.some(({ file }) => !file.size || file.size > 24 * 1024 * 1024))
        throw Error('Выберите непустые файлы размером до 24 МБ каждый.');
      const data = new FormData();
      data.append('project', JSON.stringify({ v: next.v, rows: next.rows }));
      data.append('version', String(project.version));
      for (const { id, file } of uploads) {
        data.append('entry', id);
        data.append('file', file);
      }
      init = { method: 'PUT', body: data };
    } else
      init = { ...json({ project: { v: next.v, rows: next.rows }, version: project.version }), method: 'PUT' };
    const saved: SavedProject = await (await api('/' + project.id, init)).json();
    setProject(saved);
    setEdit(null);
  }
  function add() {
    const r = entry(tab, { name: '' });
    if (tab === 'work' && packs.length === 1) r.links.pack = [packs[0].id];
    if (tab === 'template') r.v.form = 'hidden';
    if (tab === 'person') r.v.role = 'СК Заказчика';
    setEdit(r);
  }
  const rowDetails = (r: Entry) => {
    switch (r.kind) {
      case 'work':
        return [
          project.rows.find((t) => t.id === r.links.template?.[0])?.v.name,
          r.v.number && numberOf(project, r),
          r.v.date,
        ]
          .filter(Boolean)
          .join(' · ');
      case 'template':
        return r.file || (r.v.needsFile === 'да' ? 'Загрузите форму DOCX' : 'Базовая форма DOCX');
      case 'person':
        return [r.v.role, r.v.position, r.v.company].filter(Boolean).join(' · ');
      case 'standard':
        return r.v.description;
      case 'pack':
        return 'Актов · ' + project.rows.filter((w) => w.kind === 'work' && w.links.pack?.includes(r.id)).length;
      default:
        return [
          r.v.docType?.trim() !== r.v.name?.trim() && r.v.docType,
          r.v.number,
          r.v.date,
          r.file || 'Без оригинала',
        ]
          .filter(Boolean)
          .join(' · ');
    }
  };
  return (
    <Tabs.Root
      className={s.workspace}
      value={tab}
      orientation="vertical"
      onValueChange={(v) => {
        setTab(v as Kind);
        const url = new URL(location.href);
        url.searchParams.set('section', v);
        history.replaceState(null, '', url);
      }}
    >
      <AppShell
        {...shell}
        breadcrumb={
          <>
            <Home size={15} />
            <button onClick={back}>Проекты</button> / <span title={project.v.name}>{project.v.name}</span>
          </>
        }
        action={
          <button className={s.secondary} disabled={!packs.length} onClick={() => setExporting(packs[0]?.id)}>
            <Download size={15} /> Выгрузить комплект
          </button>
        }
        sidebar={
          <>
            <label className={s.switcher} title={project.v.name}>
              <Building2 size={17} />
              <select
                aria-label="Текущий проект"
                value={project.id}
                onChange={(e) => (e.target.value ? switchProject(e.target.value) : back())}
              >
                <option value={project.id}>{project.v.name}</option>
                {options
                  .filter((p) => p.id !== project.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                <option value="">Все проекты</option>
              </select>
            </label>
            <Tabs.List aria-label="Разделы проекта" className={s.menu}>
              {sections.map((k) => {
                const Icon = icons[k];
                return (
                  <Tabs.Trigger
                    key={k}
                    value={k}
                    data-section={k}
                    title={k === 'pack' ? 'Обзор комплектов' : labels[k]}
                    aria-label={k === 'pack' ? 'Обзор комплектов' : labels[k]}
                  >
                    <Icon size={16} />
                    <span>{k === 'pack' ? 'Обзор комплектов' : labels[k]}</span>
                  </Tabs.Trigger>
                );
              })}
            </Tabs.List>
            <button
              className={s.settings}
              title="Реквизиты и настройки"
              aria-label="Реквизиты и настройки"
              onClick={() => setEdit('settings')}
            >
              <Settings2 size={16} />
              <span>Реквизиты и настройки</span>
            </button>
          </>
        }
      >
        {notice}
        {!!warnings.length && (
          <details className={s.alert}>
            <summary>Замечания при импорте · {warnings.length}</summary>
            {warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </details>
        )}

        <Tabs.Content key={tab} value={tab} className={s.panel}>
          <div className={s.rowHeading}>
            <h2>
              {tab === 'pack' ? 'Обзор комплектов' : labels[tab]} <span>{rows.length}</span>
            </h2>
            <button className={s.primary} onClick={add}>
              <Plus size={16} />
              {tab === 'pack' ? 'Новый комплект' : tab === 'standard' ? 'Норматив' : 'Добавить'}
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
          {tab === 'pack' ? (
            <PackageDashboard
              project={project}
              edit={(r, documents = false) => { setOpenDocuments(documents); setEdit(r); }}
              download={setExporting}
              plan={(id, name) =>
                persist({ ...project, rows: [...project.rows, entry('work', { name }, { pack: [id] })] })
              }
            />
          ) : (
            <RecordList
              key={scope}
              scope={scope}
              rows={rows}
              columns={columns}
              placeholder={tab === 'standard' ? 'Поиск по нормативам' : 'Поиск по записям'}
              quickFilter={tab === 'standard' ? { key: 'rules', value: 'С правилами' } : undefined}
              pageSize={tab === 'standard' ? 10 : 25}
              empty={
                <>
                  <p>Пока нет записей</p>
                  <button onClick={add}>Добавить первую запись</button>
                </>
              }
            >
              {(groups) =>
                tab === 'standard' ? (
                  <StandardsBrowser groups={groups} edit={setEdit} />
                ) : (
                  groups.map((group) => (
                    <section key={group.key}>
                      <GroupTitle group={group} />
                      <div className={s.records}>
                        {group.rows.map((r) => (
                          <button className={s.record} key={r.id} onClick={() => setEdit(r)}>
                            <span>
                              <strong>{r.v.name || 'Шаг без названия'}</strong>
                              <small>{rowDetails(r)}</small>
                            </span>
                            <ChevronRight size={15} />
                          </button>
                        ))}
                      </div>
                    </section>
                  ))
                )
              }
            </RecordList>
          )}
        </Tabs.Content>
        {edit && (
          <Editor
            project={project}
            openDocuments={tab === 'pack' && edit !== 'settings' && edit.kind === 'work' && openDocuments}
            drawer={tab === 'pack' && edit !== 'settings' && edit.kind === 'work'}
            row={edit === 'settings' ? undefined : edit}
            title={edit === 'settings' ? 'Реквизиты и настройки' : edit.kind === 'work' && !existing ? 'Новый акт' : single[edit.kind]}
            close={() => setEdit(null)}
            remove={
              existing
                ? () => persist({ ...project, rows: project.rows.filter((r) => r.id !== edit.id) })
                : undefined
            }
            save={(v, links, file, detach, rules, documents = []) => {
              if (edit === 'settings') return persist({ ...project, v });
              const r = { ...edit, v, links, rules };
              if (detach) delete r.file;
              const rows = new Map(project.rows.map((item) => [item.id, item]));
              const uploads = file ? [{ id: r.id, file }] : [];
              rows.set(r.id, r);
              for (const doc of documents) {
                rows.set(doc.row.id, doc.row);
                if (doc.file) uploads.push({ id: doc.row.id, file: doc.file });
              }
              return persist({ ...project, rows: [...rows.values()] }, uploads);
            }}
          />
        )}
        {exporting && <Export project={project} initialPack={exporting} close={() => setExporting(undefined)} />}
      </AppShell>
    </Tabs.Root>
  );
}
export function Projects({ shell, notice }: { shell: ShellProps; notice: ReactNode }) {
  const [items, setItems] = useState<ProjectSummary[]>([]),
    [active, setActive] = useState<SavedProject>(),
    [mode, setMode] = useState<'create' | 'import'>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [warnings, setWarnings] = useState<string[]>([]);
  const requestNumber = useRef(0);
  async function list() {
    const current = ++requestNumber.current;
    setLoading(true);
    setError('');
    try {
      const options = await (await api('')).json();
      if (current === requestNumber.current) setItems(options);
    } catch (e) {
      if (current === requestNumber.current) setError((e as Error).message);
    } finally {
      if (current === requestNumber.current) setLoading(false);
    }
  }
  useEffect(() => {
    const sync = () => {
      if (location.pathname !== '/projects') return;
      const params = new URLSearchParams(location.search);
      setMode(params.get('import') === 'excel' ? 'import' : undefined);
      const id = params.get('project');
      if (id && /^[0-9a-f-]{36}$/i.test(id)) {
        void open(id);
        void api('')
          .then((r) => r.json())
          .then(setItems)
          .catch(() => {});
      } else {
        setActive(undefined);
        void list();
      }
    };
    sync();
    addEventListener('popstate', sync);
    return () => {
      ++requestNumber.current;
      removeEventListener('popstate', sync);
    };
  }, []);
  function select(id: string) {
    history.pushState(null, '', '/projects?project=' + encodeURIComponent(id));
    void open(id);
  }
  async function open(id: string) {
    const current = ++requestNumber.current;
    setLoading(true);
    setError('');
    try {
      const next = await (await api('/' + id)).json();
      if (requestNumber.current !== current) return;
      setActive(next);
      setWarnings([]);
    } catch (e) {
      if (current === requestNumber.current) {
        setActive(undefined);
        setError((e as Error).message);
      }
    } finally {
      if (current === requestNumber.current) setLoading(false);
    }
  }
  if (active)
    return (
      <Workspace
        key={active.id}
        shell={shell}
        notice={
          <>
            {notice}
            {error && (
              <p role="alert" className={s.alert}>
                {error}
              </p>
            )}
          </>
        }
        options={items}
        switchProject={select}
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
    <AppShell {...shell}>
      <section className={s.root}>
        {notice}
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
          <RecordList
            scope="construction.projects"
            rows={items}
            columns={projectColumns}
            placeholder="Поиск проектов"
          >
            {(groups) =>
              groups.map((group) => (
                <section key={group.key}>
                  <GroupTitle group={group} />
                  <div className={s.cards}>
                    {group.rows.map((p) => (
                      <button key={p.id} className={s.card} onClick={() => select(p.id)}>
                        <Folder size={23} />
                        <h2 title={p.name}>{p.name}</h2>
                        <div>
                          <span>
                            Комплекты · {p.packs}　 Акты · {p.works}
                          </span>
                          <ArrowRight size={17} />
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              ))
            }
          </RecordList>
        ) : (
          !error && (
            <div className={s.empty}>
              <Building2 size={35} />
              <h3>Первый строительный проект</h3>
              <p>Начните с названия объекта и первого комплекта или перенесите данные из книги автогенератора.</p>
            </div>
          )
        )}
        {mode && (
          <ProjectStart
            mode={mode}
            close={() => {
              setMode(undefined);
              if (new URLSearchParams(location.search).has('import')) history.replaceState(null, '', '/projects');
            }}
            created={(p, w) => {
              setMode(undefined);
              history.pushState(null, '', '/projects?project=' + encodeURIComponent(p.id));
              setActive(p);
              setWarnings(w);
            }}
          />
        )}
      </section>
    </AppShell>
  );
}
