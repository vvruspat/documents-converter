import './registry.css';
import { Archive, Building2, ChevronDown, Folder, FolderOpen, Layers, Plus, Sparkles } from 'lucide-react';
import { Catalog } from './Catalog';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Check, Download, FileText, LoaderCircle, RotateCcw, Trash2, Upload } from 'lucide-react';

type RegistryJob = {
  id: string; project?: string; originalName: string; resultName: string;
  status: 'queued' | 'working' | 'done' | 'error';
  documentsTotal?: number; pages: number; processedPages: number; recordCount: number; createdAt: string; error?: string;
};
const dateTime = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

async function api(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Не удалось выполнить запрос.');
  }
  return response;
}

const views = [
  { id: 'catalog', name: 'Документы', icon: FolderOpen },
  { id: 'sets', name: 'Комплекты', icon: Layers },
  { id: 'upload', name: 'Загрузки и Excel', icon: Archive },
  { id: 'ask', name: 'Вопрос по архиву', icon: Sparkles },
] as const;
type View = typeof views[number]['id'];
export function RegistryPage() {
  const [project, setProject] = useState(() => new URLSearchParams(location.search).get('project')?.slice(0,120) || 'Общий');
  const [tab, setTab] = useState<View>(() => views.find(v => v.id === new URLSearchParams(location.search).get('view'))?.id ?? 'catalog');
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectDraft, setProjectDraft] = useState('');
  const chooseInitialProject = useRef(!new URLSearchParams(location.search).has('project'));
  function navigate(view: View, target = project) {
    chooseInitialProject.current = false;
    setTab(view); setProject(target);
    const url = new URL(location.href);
    url.searchParams.set('view', view); url.searchParams.set('project', target);
    history.replaceState(null, '', url);
  }
  const selected = project.trim() || 'Общий';
  const input = useRef<HTMLInputElement>(null);
  const [jobs, setJobs] = useState<RegistryJob[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [action, setAction] = useState('');

  async function refresh() {
    try {
      const response = await api('/api/registry');
      const body = await response.json() as { items: RegistryJob[] };
      if (chooseInitialProject.current && body.items.length) {
        chooseInitialProject.current = false;
        setProject(body.items[0].project || 'Общий');
      }
      setJobs(body.items);
    } catch (reason) { setError((reason as Error).message); }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  function upload(file: File) {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') { setError('Для реестра выберите PDF.'); return; }
    if (!file.size) { setError('PDF пустой.'); return; }
    setError(''); setUploading(true); setUploadPercent(null);
    const body = new FormData(); body.append('pdf', file);
    const request = new XMLHttpRequest();
    request.open('POST', '/api/registry?project=' + encodeURIComponent(selected));
    request.upload.onprogress = event => { if (event.lengthComputable) setUploadPercent(Math.round(event.loaded / event.total * 100)); };
    request.onload = () => {
      setUploading(false); setUploadPercent(null);
      if (request.status !== 202) {
        let message = 'Не удалось загрузить PDF.';
        try { message = JSON.parse(request.responseText).error || message; } catch { /* Invalid server response. */ }
        setError(message); return;
      }
      void refresh();
    };
    request.onerror = () => { setUploading(false); setUploadPercent(null); setError('Загрузка прервалась. Попробуйте ещё раз.'); };
    request.send(body);
  }

  function select(files: FileList | null) {
    const file = files?.[0];
    if (file) upload(file);
    if (input.current) input.current.value = '';
  }

  function drop(event: DragEvent) {
    event.preventDefault(); setDragging(false);
    if (!uploading) select(event.dataTransfer.files);
  }

  async function change(job: RegistryJob, kind: 'retry' | 'reprocess' | 'delete') {
    if (kind === 'delete' && !window.confirm('Удалить «' + job.originalName + '» и связанные сканы из каталога?')) return;
    setAction(job.id); setError('');
    try {
      await api(`/api/registry/${job.id}${kind === 'retry' ? '/retry' : kind === 'reprocess' ? '/reprocess' : ''}`, { method: kind === 'delete' ? 'DELETE' : 'POST' });
      await refresh();
    } catch (reason) { setError((reason as Error).message); }
    finally { setAction(''); }
  }

  const projectJobs = jobs.filter(job => (job.project || 'Общий') === selected);
  const currentView = views.find(view => view.id === tab)!;
  return <section className="registry-workspace">
    <aside className="registry-sidebar">
      <label className="project-picker"><span>Проект</span><span className="project-choice"><Building2 size={18}/><select aria-label="Проект" disabled={uploading} value={project} onChange={e => navigate(tab,e.target.value)}>
        {[...new Set([project,'Общий',...jobs.map(j => j.project || 'Общий')])].map(p => <option key={p}>{p}</option>)}</select><ChevronDown size={15}/></span></label>
      <div className="workspace-links" role="group" aria-label="Разделы проекта">{views.map(({ id, icon: Icon, name }) =>
        <button key={id} aria-current={id === tab ? 'page' : undefined} onClick={() => navigate(id)}><Icon size={17}/>{name}</button>)}</div>
      <button className="new-project" disabled={uploading} onClick={() => setCreatingProject(!creatingProject)}><Plus size={15}/> Новый проект</button>
      {creatingProject && <form className="new-project-form" onSubmit={e => { e.preventDefault(); if(projectDraft.trim()) { navigate('upload', projectDraft.trim()); setCreatingProject(false); setProjectDraft(''); } }}>
        <label>Название проекта<input required autoFocus maxLength={120} value={projectDraft} onChange={e=>setProjectDraft(e.target.value)}/></label><button>Продолжить</button></form>}
    </aside>
    <div className="registry-main">
      <div className="workspace-crumb"><Folder size={14}/>{selected}<span>/</span>{currentView.name}</div>
      <header className="workspace-heading"><h1>{tab === 'catalog' ? 'Реестр документов' : currentView.name}</h1>
      {tab !== 'upload' && <button className="upload-cta" disabled={uploading} onClick={() => { navigate('upload'); input.current?.click(); }}><Plus size={16}/> Загрузить PDF</button>}</header>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <input ref={input} className="visually-hidden" type="file" accept=".pdf,application/pdf" aria-label="Выбрать PDF для реестра" onChange={event => select(event.target.files)} />
    <div hidden={tab === 'upload'}><Catalog key={selected} project={selected} view={tab} revision={projectJobs.filter(j => j.status === 'done').map(j => j.id).join(',')} /></div>
    <div hidden={tab !== 'upload'} className="uploads-panel">
    <div className={`dropzone registry-dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
      <Upload size={28} strokeWidth={1.4} />
      <h2>Перетащите PDF сюда</h2>
      <button className="button" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? 'Загружается…' : 'Выбрать PDF'}</button>
      <p>{uploading ? `Загрузка${uploadPercent === null ? '…' : `: ${uploadPercent}%`}` : 'Размер файла и число страниц не ограничены приложением'}</p>
    </div>
    <p className="registry-note">Обработка большого PDF может занять время. Можно закрыть страницу и вернуться позже. Подсвеченные ячейки в Excel требуют проверки по оригиналу. Пересоздание повторно распознаёт все страницы.</p>
    <div className="registry-list"><div className="list-heading"><span>Реестры <span className="muted">{projectJobs.length}</span></span></div>
      {projectJobs.length === 0 ? <p className="empty-history">Здесь появятся ваши PDF и готовые реестры.</p> : projectJobs.map(job => <div className="job registry-job" key={job.id}>
        <FileText className="file-icon" size={22} strokeWidth={1.5} />
        <div className="job-body"><div className="job-name" title={job.originalName}>{job.originalName}</div>
          <div className={`job-status ${job.status === 'error' ? 'error-text' : ''}`} aria-live="polite">
            {job.status === 'queued' ? 'В очереди' : job.status === 'working' && job.documentsTotal !== undefined ? `Заполняем реестр: ${job.recordCount} из ${job.documentsTotal} документов` : job.status === 'working' ? `Обработано ${job.processedPages} из ${job.pages} стр.` : job.status === 'done' ? <><Check size={12} /> {job.recordCount} документов · {dateTime.format(new Date(job.createdAt))} · {job.resultName}</> : job.error}
          </div>
          <progress className="registry-progress" max={(job.documentsTotal ?? job.pages) || 1} value={job.documentsTotal !== undefined ? job.recordCount : job.status === 'done' ? job.pages : job.processedPages} aria-label={`Обработка ${job.originalName}`} />
        </div>
        <div className="job-action">
          {job.status === 'done' && <a className="button compact" href={`/api/registry/${job.id}/result`} download={job.resultName}><Download size={15} />Скачать</a>}
          {job.status === 'done' && <button className="icon-button" title="Пересоздать реестр" aria-label={`Пересоздать ${job.originalName}`} disabled={action === job.id} onClick={() => void change(job, 'reprocess')}>{action === job.id ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={17} />}</button>}
          {job.status === 'error' && <button className="icon-button" title="Повторить" aria-label={`Повторить ${job.originalName}`} disabled={action === job.id} onClick={() => void change(job, 'retry')}>{action === job.id ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={17} />}</button>}
          {job.status !== 'working' && <button className="icon-button delete" title="Удалить" aria-label={`Удалить ${job.originalName}`} disabled={action === job.id} onClick={() => void change(job, 'delete')}><Trash2 size={16} /></button>}
        </div>
      </div>)}
    </div>
    </div></div>
  </section>;
}
