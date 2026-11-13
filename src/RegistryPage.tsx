import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Check, Download, FileText, LoaderCircle, RotateCcw, Trash2, Upload } from 'lucide-react';

type RegistryJob = {
  id: string; originalName: string; resultName: string;
  status: 'queued' | 'working' | 'done' | 'error';
  pages: number; processedPages: number; recordCount: number; createdAt: string; error?: string;
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

export function RegistryPage() {
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
    request.open('POST', '/api/registry');
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
    setAction(job.id); setError('');
    try {
      await api(`/api/registry/${job.id}${kind === 'retry' ? '/retry' : kind === 'reprocess' ? '/reprocess' : ''}`, { method: kind === 'delete' ? 'DELETE' : 'POST' });
      await refresh();
    } catch (reason) { setError((reason as Error).message); }
    finally { setAction(''); }
  }

  return <section className="registry-page">
    <div className="registry-intro"><h1>Реестр документов из PDF</h1><p>Загрузите скан с документами. Мы составим Excel-реестр в порядке страниц PDF.</p></div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <input ref={input} className="visually-hidden" type="file" accept=".pdf,application/pdf" aria-label="Выбрать PDF для реестра" onChange={event => select(event.target.files)} />
    <div className={`dropzone registry-dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
      <Upload size={28} strokeWidth={1.4} />
      <h2>Перетащите PDF сюда</h2>
      <button className="button" disabled={uploading} onClick={() => input.current?.click()}>{uploading ? 'Загружается…' : 'Выбрать PDF'}</button>
      <p>{uploading ? `Загрузка${uploadPercent === null ? '…' : `: ${uploadPercent}%`}` : 'Размер файла и число страниц не ограничены приложением'}</p>
    </div>
    <p className="registry-note">Обработка большого PDF может занять время. Можно закрыть страницу и вернуться позже. Подсвеченные ячейки в Excel требуют проверки по оригиналу. Пересоздание повторно распознаёт все страницы.</p>
    <div className="registry-list"><div className="list-heading"><span>Реестры <span className="muted">{jobs.length}</span></span></div>
      {jobs.length === 0 ? <p className="empty-history">Здесь появятся ваши PDF и готовые реестры.</p> : jobs.map(job => <div className="job registry-job" key={job.id}>
        <FileText className="file-icon" size={22} strokeWidth={1.5} />
        <div className="job-body"><div className="job-name" title={job.originalName}>{job.originalName}</div>
          <div className={`job-status ${job.status === 'error' ? 'error-text' : ''}`} aria-live="polite">
            {job.status === 'queued' ? 'В очереди' : job.status === 'working' ? `Обработано ${job.processedPages} из ${job.pages} стр.` : job.status === 'done' ? <><Check size={12} /> {job.recordCount} документов · {dateTime.format(new Date(job.createdAt))} · {job.resultName}</> : job.error}
          </div>
          <progress className="registry-progress" max={job.pages || 1} value={job.status === 'done' ? job.pages : job.processedPages} aria-label={`Обработка ${job.originalName}`} />
        </div>
        <div className="job-action">
          {job.status === 'done' && <a className="button compact" href={`/api/registry/${job.id}/result`} download={job.resultName}><Download size={15} />Скачать</a>}
          {job.status === 'done' && <button className="icon-button" title="Пересоздать реестр" aria-label={`Пересоздать ${job.originalName}`} disabled={action === job.id} onClick={() => void change(job, 'reprocess')}>{action === job.id ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={17} />}</button>}
          {job.status === 'error' && <button className="icon-button" title="Повторить" aria-label={`Повторить ${job.originalName}`} disabled={action === job.id} onClick={() => void change(job, 'retry')}>{action === job.id ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={17} />}</button>}
          {job.status !== 'working' && <button className="icon-button delete" title="Удалить" aria-label={`Удалить ${job.originalName}`} disabled={action === job.id} onClick={() => void change(job, 'delete')}><Trash2 size={16} /></button>}
        </div>
      </div>)}
    </div>
  </section>;
}
