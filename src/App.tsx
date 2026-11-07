import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Check, Download, FileImage, FileSpreadsheet, LoaderCircle, LogOut, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import type { HistoryEntry } from '../shared/history';

type Job = { id: string; file: File; status: 'queued' | 'working' | 'done' | 'error'; result?: HistoryEntry; error?: string };
type Page = 'convert' | 'history';
export function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [page, setPage] = useState<Page>(location.pathname === '/history' ? 'history' : 'convert');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState('');
  const [downloading, setDownloading] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const worker = useRef(false);
  async function request(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    if (response.status === 401 && url !== '/api/login') setAuth(false);
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Не удалось выполнить запрос.'); }
    return response;
  }
  useEffect(() => {
    fetch('/api/session').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => { setAuth(d.authenticated); setPasswordRequired(d.passwordRequired); }).catch(() => { setError('Не удалось подключиться к серверу.'); setAuth(false); });
    const popstate = () => setPage(location.pathname === '/history' ? 'history' : 'convert');
    addEventListener('popstate', popstate); return () => removeEventListener('popstate', popstate);
  }, []);
  useEffect(() => {
    if (!auth || worker.current) return;
    const job = jobs.find(j => j.status === 'queued'); if (!job) return;
    worker.current = true; setBusy(true);
    setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'working', error: undefined } : j));
    (async () => {
      try {
        const data = new FormData(); data.append('image', job.file);
        const response = await request('/api/recognize', { method: 'POST', body: data });
        const { conversion } = await response.json() as { conversion: HistoryEntry };
        setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'done', result: conversion } : j));
      } catch (e) { setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'error', error: (e as Error).message } : j)); }
      finally { worker.current = false; setBusy(false); }
    })();
  }, [jobs, auth]);
  useEffect(() => { if (auth && page === 'history') loadHistory(); }, [auth, page, historyPage, busy]);
  function navigate(next: Page) { if (next !== page) { window.history.pushState(null, '', next === 'history' ? '/history' : '/'); setPage(next); setError(''); } }
  async function login(event: FormEvent) {
    event.preventDefault(); setLoggingIn(true); setError('');
    try { await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); setPassword(''); setAuth(true); }
    catch (e) { setError((e as Error).message); } finally { setLoggingIn(false); }
  }
  async function logout() { try { await request('/api/logout', { method: 'POST' }); setAuth(false); } catch (e) { setError((e as Error).message); } }
  function addFiles(files: FileList | File[]) {
    const added: Job[] = [], errors: string[] = [];
    for (const file of Array.from(files)) {
      if (jobs.length + added.length >= 10) { errors.push('До 10 файлов за раз. Очистите список, чтобы добавить новые.'); break; }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { errors.push(`${file.name}: нужен JPG, PNG или WebP.`); continue; }
      if (file.size > 12 * 1024 * 1024 || !file.size) { errors.push(`${file.name}: допустимый размер — до 12 МБ.`); continue; }
      added.push({ id: crypto.randomUUID(), file, status: 'queued' });
    }
    setJobs(prev => [...prev, ...added]); setError([...new Set(errors)].join(' '));
    if (input.current) input.current.value = '';
  }
  function drop(event: DragEvent) { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }
  async function loadHistory() {
    setLoading(true);
    try { const r = await request(`/api/history?offset=${historyPage * 25}&limit=25`); const d = await r.json(); setHistory(d.items); setTotal(d.total); if (!d.items.length && historyPage > 0) setHistoryPage(historyPage - 1); }
    catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }
  async function download(entry: HistoryEntry, kind: 'source' | 'result' = 'result') {
    setDownloading(`${entry.id}:${kind}`); setError('');
    try {
      const r = await request(`/api/history/${entry.id}/${kind}`); const url = URL.createObjectURL(await r.blob());
      const link = document.createElement('a'); link.href = url; link.download = kind === 'source' ? entry.originalName : entry.resultName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setError((e as Error).message); } finally { setDownloading(''); }
  }
  async function remove(entry: HistoryEntry) {
    setDeleting(entry.id); setError('');
    try { await request(`/api/history/${entry.id}`, { method: 'DELETE' }); setJobs(prev => prev.filter(j => j.result?.id !== entry.id)); await loadHistory(); }
    catch (e) { setError((e as Error).message); } finally { setDeleting(''); }
  }
  if (auth === null) return <main className="loading"><LoaderCircle className="spin" size={19} /></main>;
  if (!auth) return <main className="login"><form onSubmit={login}><span className="logo-mark"><FileSpreadsheet size={23} /></span><h1>Фото в Excel</h1><label htmlFor="password">Пароль</label><input id="password" type="password" autoComplete="current-password" required autoFocus value={password} onChange={e => setPassword(e.target.value)} />{error && <p className="error-text" role="alert">{error}</p>}<button className="button primary" disabled={loggingIn}>{loggingIn && <LoaderCircle className="spin" size={17} />} Войти</button></form></main>;
  return <div className="app"><header><a className="brand" href="/" onClick={e => { e.preventDefault(); navigate('convert'); }}><span className="logo-mark"><FileSpreadsheet size={19} /></span>Фото в Excel</a><nav aria-label="Навигация"><a href="/" className={page === 'convert' ? 'active' : ''} aria-current={page === 'convert' ? 'page' : undefined} onClick={e => { e.preventDefault(); navigate('convert'); }}>Конвертер</a><a href="/history" className={page === 'history' ? 'active' : ''} aria-current={page === 'history' ? 'page' : undefined} onClick={e => { e.preventDefault(); navigate('history'); }}>История</a></nav>{passwordRequired && <button className="icon-button logout" title="Выйти" aria-label="Выйти" onClick={logout} disabled={busy}><LogOut size={16} /></button>}</header>
    <main className="content">{error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Закрыть сообщение" onClick={() => setError('')}><X size={16} /></button></div>}
      {page === 'convert' ? <><input className="visually-hidden" type="file" ref={input} accept="image/jpeg,image/png,image/webp" multiple aria-label="Выбрать фотографии" onChange={e => e.target.files && addFiles(e.target.files)} /><section className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop} aria-label="Загрузка файлов"><Upload size={28} strokeWidth={1.4} /><h1>Перетащите фотографии сюда</h1><button className="button" onClick={() => input.current?.click()} disabled={jobs.length >= 10}>Выбрать файлы</button><p>JPG, PNG, WebP · до 12 МБ</p></section>
        {jobs.length > 0 && <section className="jobs" aria-label="Конвертация файлов"><div className="list-heading"><span>Файлы <span className="muted">{jobs.length}</span></span><button className="text-button" disabled={busy} onClick={() => setJobs([])}>Очистить список</button></div>{jobs.map(job => <div className="job" key={job.id}><FileImage className="file-icon" size={22} strokeWidth={1.5} /><div className="job-body"><div className="job-name" title={job.file.name}>{job.file.name}</div><div className={`job-status ${job.status === 'error' ? 'error-text' : ''}`} aria-live="polite">{job.status === 'queued' ? 'В очереди' : job.status === 'working' ? 'Обрабатывается…' : job.status === 'done' ? <><Check size={12} />{job.result?.resultName}</> : job.error}</div><div className={`progress ${job.status}`} role="progressbar" aria-label={`Конвертация ${job.file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.status === 'done' ? 100 : job.status === 'queued' ? 0 : undefined} aria-valuetext={job.status === 'working' ? 'Обрабатывается' : undefined}><span /></div></div><div className="job-action">{job.status === 'done' && job.result ? <button className="button compact" onClick={() => download(job.result!)} disabled={downloading === `${job.result.id}:result`}>{downloading === `${job.result.id}:result` ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}Скачать</button> : job.status === 'error' ? <button className="icon-button" title="Повторить" aria-label={`Повторить ${job.file.name}`} onClick={() => setJobs(prev => prev.map(j => j.id === job.id ? { ...j, status: 'queued', error: undefined } : j))}><RotateCcw size={17} /></button> : job.status === 'working' ? <LoaderCircle className="spin muted" size={17} /> : <button className="icon-button" aria-label={`Убрать ${job.file.name}`} onClick={() => setJobs(prev => prev.filter(j => j.id !== job.id))}><X size={16} /></button>}</div></div>)}</section>}</>
      : <section className="history"><div className="history-heading"><h1>История</h1>{loading && <LoaderCircle className="spin muted" size={16} />}</div><div className="history-scroll"><table><thead><tr><th>Исходник</th><th>Результат</th><th>Дата</th><th aria-label="Действия" /></tr></thead><tbody>{history.map(entry => <tr key={entry.id}><td><button className="filename" onClick={() => download(entry, 'source')} title={entry.originalName}><FileImage size={16} /><span>{entry.originalName}</span></button></td><td><span className="result-name" title={entry.resultName}><FileSpreadsheet size={16} /><span>{entry.resultName}</span></span></td><td className="date">{new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(entry.createdAt))}</td><td className="history-actions"><button className="icon-button" title="Скачать Excel" aria-label={`Скачать ${entry.resultName}`} disabled={downloading === `${entry.id}:result`} onClick={() => download(entry)}>{downloading === `${entry.id}:result` ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}</button><button className="icon-button delete" title="Удалить конвертацию" aria-label={`Удалить ${entry.originalName}`} disabled={deleting === entry.id} onClick={() => remove(entry)}>{deleting === entry.id ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}</button></td></tr>)}</tbody></table></div>{!loading && !history.length && <div className="empty-history">Пока нет конвертаций.</div>}{total > 25 && <div className="pagination"><button className="text-button" disabled={historyPage === 0 || loading} onClick={() => setHistoryPage(historyPage - 1)}>Назад</button><span>{historyPage * 25 + 1}–{Math.min((historyPage + 1) * 25, total)} из {total}</span><button className="text-button" disabled={(historyPage + 1) * 25 >= total || loading} onClick={() => setHistoryPage(historyPage + 1)}>Далее</button></div>}</section>}
    </main></div>;
}
