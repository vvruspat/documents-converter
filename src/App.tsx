import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCheck, ChevronRight, CircleAlert, FileImage, FileSpreadsheet, ImagePlus, KeyRound, LoaderCircle, LogOut, Plus, ScanLine, ShieldCheck, Sparkles, Table2, Trash2, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ExtractedDocument, ExtractedTable } from '../shared/document';

type Photo = { id: string; name: string; file?: File; url?: string; status: 'queued' | 'working' | 'done' | 'error'; document?: ExtractedDocument; error?: string };
type Config = { configured: boolean; model: string; maxFileBytes: number };
const sample: ExtractedDocument = {
  title: 'Реестр строительных материалов', context: ['Пример документа'], warnings: [],
  tables: [{ title: 'Материалы', columns: ['№ п/п', 'Наименование материала', 'Документ', 'Дата', 'Кол. листов'], rows: [
    ['1', 'Гидрошпонка Аквастоп', 'Технический паспорт №5649', '10.09.2025', '1'],
    ['2', 'Бетонная смесь В30 П4 F150 W8', 'Паспорт качества №000007900', '08.10.2025', '1'],
    ['3', 'Бетонная смесь В30 П4 F150 W8', 'Паспорт качества №000007901', '08.10.2025', '1'],
  ], uncertainCells: [] }],
};
const rowCount = (p: Photo) => p.document?.tables.reduce((n, t) => n + t.rows.length, 0) ?? 0;

export function App() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [config, setConfig] = useState<Config | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [tableIndex, setTableIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [zoom, setZoom] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const urls = useRef(new Set<string>());
  const selected = photos.find(p => p.id === selectedId) ?? photos[0];
  const table = selected?.document?.tables[tableIndex];
  const done = photos.filter(p => p.status === 'done' && p.document?.tables.length);
  const queued = photos.filter(p => p.status === 'queued');
  const totalRows = done.reduce((n, p) => n + rowCount(p), 0);
  const uncertain = done.reduce((n, p) => n + (p.document?.tables.reduce((n, t) => n + t.uncertainCells.length, 0) ?? 0), 0);

  async function request(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    if (response.status === 401 && url !== '/api/login') { setAuth(false); throw new Error('Сессия закончилась. Войдите снова.'); }
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'Не удалось выполнить запрос. Проверьте соединение.'); }
    return response;
  }
  useEffect(() => {
    fetch('/api/session').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(data => { setAuth(data.authenticated); setPasswordRequired(data.passwordRequired); }).catch(() => { setError('Не удалось подключиться к серверу. Обновите страницу.'); setAuth(false); });
    return () => { urls.current.forEach(url => URL.revokeObjectURL(url)); };
  }, []);
  useEffect(() => { if (auth) request('/api/config').then(r => r.json()).then(setConfig).catch(e => setError(e.message)); }, [auth]);
  useEffect(() => { setTableIndex(0); setPage(0); setZoom(false); }, [selectedId]);

  async function login(event: FormEvent) {
    event.preventDefault(); setLoggingIn(true); setError('');
    try { await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); setPassword(''); setAuth(true); }
    catch (e) { setError((e as Error).message); } finally { setLoggingIn(false); }
  }
  async function logout() { try { await request('/api/logout', { method: 'POST' }); setAuth(false); setConfig(null); } catch (e) { setError((e as Error).message); } }
  function addFiles(files: FileList | File[]) {
    if (busy) return;
    const added: Photo[] = []; const failures: string[] = [];
    for (const file of Array.from(files)) {
      if (photos.length + added.length >= 10) { failures.push('За один раз можно загрузить до 10 фотографий.'); break; }
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { failures.push(`${file.name}: поддерживаются JPG, PNG и WebP.`); continue; }
      if (file.size > 12 * 1024 * 1024) { failures.push(`${file.name}: фото больше 12 МБ.`); continue; }
      if (file.size === 0) { failures.push(`${file.name}: файл пустой.`); continue; }
      const url = URL.createObjectURL(file); urls.current.add(url);
      added.push({ id: crypto.randomUUID(), name: file.name, file, url, status: 'queued' });
    }
    setPhotos(prev => [...prev, ...added]);
    if (added.length) { setSelectedId(added[0].id); setPreviewOpen(true); }
    setError([...new Set(failures)].join(' '));
    if (fileInput.current) fileInput.current.value = '';
  }
  function drop(event: DragEvent) { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }
  function removePhoto(id: string) {
    const photo = photos.find(p => p.id === id);
    if (photo?.url) { URL.revokeObjectURL(photo.url); urls.current.delete(photo.url); }
    const rest = photos.filter(p => p.id !== id); setPhotos(rest);
    if (selectedId === id) setSelectedId(rest[0]?.id ?? '');
  }
  async function recognize(targets = queued) {
    if (busy || !targets.length) return;
    setBusy(true); setError('');
    for (const photo of targets) {
      if (!photo.file) continue;
      setSelectedId(photo.id); setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, status: 'working', error: undefined } : p));
      try {
        const data = new FormData(); data.append('image', photo.file);
        const response = await request('/api/recognize', { method: 'POST', body: data });
        const { document } = await response.json() as { document: ExtractedDocument };
        setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, status: 'done', document } : p));
      } catch (e) { setPhotos(prev => prev.map(p => p.id === photo.id ? { ...p, status: 'error', error: (e as Error).message } : p)); }
    }
    setBusy(false);
  }
  function updateDocument(change: (d: ExtractedDocument) => ExtractedDocument) {
    if (!selected?.document) return;
    setPhotos(prev => prev.map(p => p.id === selected.id && p.document ? { ...p, document: change(p.document) } : p));
  }
  function updateTable(change: (t: ExtractedTable) => ExtractedTable) {
    updateDocument(d => ({ ...d, tables: d.tables.map((t, i) => i === tableIndex ? change(t) : t) }));
  }
  function updateCell(row: number, column: number, value: string) {
    updateTable(t => ({ ...t, rows: t.rows.map((r, i) => i === row ? r.map((c, j) => j === column ? value : c) : r), uncertainCells: t.uncertainCells.filter(c => c.row !== row || c.column !== column) }));
  }
  function deleteRow(index: number) {
    updateTable(t => ({ ...t, rows: t.rows.filter((_, i) => i !== index), uncertainCells: t.uncertainCells.filter(c => c.row !== index).map(c => ({ ...c, row: c.row > index ? c.row - 1 : c.row })) }));
    if (table && page > 0 && page * 50 >= table.rows.length - 1) setPage(page - 1);
  }
  function loadExample() { const id = crypto.randomUUID(); setPhotos(prev => [...prev, { id, name: 'Пример документа', status: 'done', document: structuredClone(sample) }]); setSelectedId(id); setPreviewOpen(false); setError(''); }
  async function download() {
    setExporting(true); setError('');
    try {
      const response = await request('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: done.map(p => ({ name: p.name, document: p.document })) }) });
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url;
      link.download = done.length === 1 ? `${done[0].name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '-').slice(0, 100)}.xlsx` : 'Таблицы.xlsx';
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setError((e as Error).message); } finally { setExporting(false); }
  }

  if (auth === null) return <div className="loading-screen"><LoaderCircle className="spin" /><span>Открываем рабочее пространство…</span></div>;
  if (!auth) return <div className="login-page"><div className="login-brand"><Brand /></div><main className="login-card"><div className="key-icon"><KeyRound size={24} /></div><p className="eyebrow">ЛИЧНЫЙ КОНВЕРТЕР</p><h1>Ваши документы.<br />Ваше пространство.</h1><p>Войдите, чтобы превратить фотографию<br />в редактируемую таблицу Excel.</p><form onSubmit={login}><label htmlFor="password">Пароль доступа</label><input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="Введите пароль" autoFocus />{error && <div className="form-error" role="alert">{error}</div>}<button className="button primary" disabled={loggingIn}>{loggingIn ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />} Открыть конвертер</button></form><div className="privacy"><ShieldCheck size={16} /> Фотографии не сохраняются на сервере</div></main><span className="login-footer">Фото в Excel · Конвертер документов</span></div>;

  return <div className="app-shell">
    <header className="topbar"><Brand /><div className="topbar-right"><span className="private-label"><span className="status-dot" /> Личное пространство</span>{passwordRequired && <button className="icon-button logout" title="Выйти" aria-label="Выйти" onClick={logout}><LogOut size={17} /></button>}</div></header>
    <main className="main-content">
      <div className="page-heading"><div><p className="eyebrow">МЕНЬШЕ РУТИНЫ. БОЛЬШЕ ПОРЯДКА.</p><h1>С фотографии — в Excel<span>.</span></h1><p className="subtitle">Загрузите документ, проверьте таблицу и скачайте готовый файл.</p></div><div className="format-badge"><FileSpreadsheet size={23} /><div><strong>Настоящий .xlsx</strong><span>Редактируется в Excel и Google Sheets</span></div></div></div>
      <div className="workflow" aria-label="Этапы конвертации"><Step number="01" title="Загрузите фото" active={!done.length} done={photos.length > 0} /><ChevronRight size={16} /><Step number="02" title="Проверьте таблицу" active={done.length > 0} done={false} /><ChevronRight size={16} /><Step number="03" title="Скачайте Excel" active={false} done={false} /><span className="workflow-note"><ShieldCheck size={15} /> Без хранения фотографий</span></div>
      {error && <div className="notice error" role="alert"><CircleAlert size={19} /><span>{error}</span><button onClick={() => setError('')} aria-label="Закрыть сообщение"><X size={17} /></button></div>}
      {config && !config.configured && <div className="notice warning"><KeyRound size={18} /><span>Распознавание пока не подключено. Добавьте ключ OpenRouter в настройки сервера. Просмотр примера и экспорт работают.</span></div>}
      <input ref={fileInput} type="file" multiple accept="image/jpeg,image/png,image/webp" className="visually-hidden" aria-label="Выбрать фотографии" onChange={e => e.target.files && addFiles(e.target.files)} disabled={busy} />
      {photos.length === 0 ? <section className={`empty-workspace ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        <div className="upload-zone"><div className="upload-illustration"><div className="illustration-sheet behind"><FileImage size={26} /><i /><i /><i /></div><div className="illustration-sheet front"><div className="illustration-green"><FileSpreadsheet size={21} /><Check size={15} /></div><div className="mini-grid">{Array.from({ length: 12 }, (_, i) => <span key={i} />)}</div></div><div className="float-plus"><Plus size={17} /></div></div><h2>Ваша таблица начинается здесь</h2><p>Перетащите фотографии документов<br />или выберите файлы на устройстве</p><button className="button primary upload-button" onClick={() => fileInput.current?.click()}><Upload size={18} /> Выбрать фотографии</button><span className="file-hint">JPG, PNG, WebP · до 12 МБ · до 10 фотографий</span><button className="example-link" onClick={loadExample}>Посмотреть на примере <ArrowUpRight size={15} /></button></div>
        <aside className="upload-details"><span className="detail-icon"><ScanLine size={22} /></span><h3>Документ на фото.<br />Данные в ячейках.</h3><p>Реестры, счета, накладные,<br />списки и другие таблицы.</p><div className="detail-divider" /><Feature title="Каждая строка на месте" text="Сохраняем порядок, номера и подписи." /><Feature title="Можно исправить сразу" text="Нажмите на ячейку и отредактируйте текст." /><Feature title="Удобный файл на выходе" text="Несколько таблиц — на отдельных листах." /><div className="small-note"><Sparkles size={15} /> Распознавание через OpenRouter</div></aside>
      </section> : <section className="workspace">
        <aside className="source-sidebar"><div className="sidebar-heading"><h2>Документы <span>{photos.length}</span></h2><button className="icon-button" onClick={() => fileInput.current?.click()} disabled={busy || photos.length >= 10} aria-label="Добавить фото" title="Добавить фото"><Plus size={19} /></button></div><div className="photo-list">{photos.map((photo, i) => <div key={photo.id} className={`photo-item ${selected?.id === photo.id ? 'selected' : ''}`}><button className="photo-select" onClick={() => setSelectedId(photo.id)}><div className="thumbnail">{photo.url ? <img src={photo.url} alt="" /> : <FileSpreadsheet size={23} />}</div><div className="photo-meta"><strong title={photo.name}>{photo.name}</strong><span className={photo.status === 'error' ? 'red' : ''}>{photo.status === 'queued' ? 'Готово к распознаванию' : photo.status === 'working' ? 'Распознаём…' : photo.status === 'error' ? 'Не удалось распознать' : `${rowCount(photo)} строк · ${photo.document?.tables.length ?? 0} таблиц`}</span></div>{photo.status === 'working' ? <LoaderCircle size={15} className="spin green" /> : photo.status === 'done' ? <Check size={16} className="green" /> : <span className="photo-number">{i + 1}</span>}</button><button className="remove-photo" disabled={busy} onClick={() => removePhoto(photo.id)} aria-label={`Удалить ${photo.name}`}><X size={13} /></button></div>)}</div><button className="add-photos" onClick={() => fileInput.current?.click()} disabled={busy || photos.length >= 10}><ImagePlus size={17} /> Добавить фотографии</button><div className="sidebar-bottom"><ShieldCheck size={16} /><p>Фото хранятся только в этой вкладке. Сервер обрабатывает их в памяти.</p></div></aside>
        <div className="editor-panel"><div className="editor-toolbar"><div className="editor-title"><span className="editor-symbol"><Table2 size={19} /></span><div><h2>{selected?.document ? 'Проверьте результат' : 'Всё готово к распознаванию'}</h2><p>{selected?.status === 'done' ? 'Нажмите на любую ячейку, чтобы изменить её' : 'Выберите фото и запустите распознавание'}</p></div></div><div className="toolbar-actions">{queued.length > 0 && <button className="button primary compact" onClick={() => recognize()} disabled={busy || !config?.configured}>{busy ? <LoaderCircle className="spin" size={16} /> : <ScanLine size={16} />} {busy ? 'Распознаём…' : `Распознать${queued.length > 1 ? ` (${queued.length})` : ' фото'}`}</button>}<button className="button download compact" disabled={!done.length || exporting || busy} onClick={download}>{exporting ? <LoaderCircle className="spin" size={16} /> : <ArrowDownToLine size={16} />} Скачать Excel</button></div></div>
          {selected?.status === 'working' ? <div className="recognition-state"><div className="scanner">{selected.url && <img src={selected.url} alt="Обрабатываемый документ" />}<div className="scan-beam" /></div><div className="processing-label"><LoaderCircle size={19} className="spin" /><h3>Переносим строки в ячейки</h3></div><p>Обычно это занимает от 15 секунд до двух минут.<br />На больших таблицах потребуется больше времени.</p><span className="processing-count">Документ {photos.findIndex(p => p.id === selected.id) + 1} из {photos.length}</span></div>
          : selected?.status === 'error' ? <div className="status-panel"><CircleAlert size={36} /><h3>Не получилось распознать фото</h3><p>{selected.error}</p><button className="button primary" disabled={busy || !config?.configured} onClick={() => recognize([selected])}><ScanLine size={17} /> Повторить распознавание</button></div>
          : selected?.status === 'queued' ? <div className="photo-preview initial"><img src={selected.url} alt={selected.name} /><div className="preview-caption"><FileImage size={16} /><span>{selected.name}</span><span>Оригинал</span></div></div>
          : selected?.document && <><div className="document-heading"><input aria-label="Название документа" value={selected.document.title} placeholder="Название документа" onChange={e => updateDocument(d => ({ ...d, title: e.target.value }))} /><div className="document-tools">{selected.url && <button className={`text-button ${previewOpen ? 'active' : ''}`} onClick={() => setPreviewOpen(!previewOpen)}><FileImage size={16} /> {previewOpen ? 'Скрыть фото' : 'Показать фото'}</button>}<span className="rows-label">{rowCount(selected)} строк</span></div></div>{selected.document.context.length > 0 && <details className="document-context"><summary>Текст над таблицей и реквизиты</summary><textarea aria-label="Реквизиты документа" value={selected.document.context.join('\n')} onChange={e => updateDocument(d => ({ ...d, context: e.target.value.split('\n') }))} /></details>}
            {selected.document.warnings.map((warning, i) => <div className="table-warning" key={i}><CircleAlert size={16} /><span>{warning}</span></div>)}
            {selected.document.tables.length === 0 ? <div className="status-panel"><Table2 size={36} /><h3>На фото не найдено таблиц</h3><p>Попробуйте загрузить другой снимок, где видны заголовки и строки.</p></div> : <>
              {selected.document.tables.length > 1 && <div className="table-tabs" role="tablist">{selected.document.tables.map((t, i) => <button role="tab" aria-selected={i === tableIndex} key={i} className={i === tableIndex ? 'active' : ''} onClick={() => { setTableIndex(i); setPage(0); }}>{t.title || `Таблица ${i + 1}`}</button>)}</div>}
              {table && <>{table.uncertainCells.length > 0 && <div className="uncertain-bar"><CircleAlert size={16} /><span>Проверьте выделенные ячейки: {table.uncertainCells.length}</span><button onClick={() => updateTable(t => ({ ...t, uncertainCells: [] }))}><CheckCheck size={15} /> Всё проверено</button></div>}<div className={`review-layout ${previewOpen && selected.url ? 'with-preview' : ''}`}>{previewOpen && selected.url && <div className={`photo-preview side ${zoom ? 'zoomed' : ''}`}><div className="preview-tools"><span>Оригинал</span><button className="icon-button" aria-label={zoom ? 'Уменьшить фото' : 'Увеличить фото'} onClick={() => setZoom(!zoom)}>{zoom ? <ZoomOut size={17} /> : <ZoomIn size={17} />}</button></div><div className="preview-scroll"><img src={selected.url} alt={selected.name} /></div></div>}<div className="table-area"><div className="table-scroll"><table className="data-table"><thead><tr><th className="row-index">#</th>{table.columns.map((label, i) => <th key={i}><textarea aria-label={`Заголовок столбца ${i + 1}`} value={label} rows={2} onChange={e => updateTable(t => ({ ...t, columns: t.columns.map((v, j) => i === j ? e.target.value : v) }))} /></th>)}<th className="row-action" /></tr></thead><tbody>{table.rows.slice(page * 50, page * 50 + 50).map((row, offset) => { const r = page * 50 + offset; return <tr key={r}><td className="row-index">{r + 1}</td>{row.map((cell, c) => { const issue = table.uncertainCells.find(v => v.row === r && v.column === c); return <td className={issue ? 'uncertain-cell' : ''} key={c} title={issue?.note}><textarea rows={Math.min(5, Math.max(2, cell.split('\n').length, Math.ceil(cell.length / 35)))} aria-label={`Строка ${r + 1}, ${table.columns[c]}`} value={cell} onChange={e => updateCell(r, c, e.target.value)} /></td>; })}<td className="row-action"><button className="icon-button" title="Удалить строку" aria-label={`Удалить строку ${r + 1}`} onClick={() => deleteRow(r)}><Trash2 size={14} /></button></td></tr>; })}</tbody></table></div><div className="table-footer"><button className="text-button" disabled={table.rows.length >= 1500} onClick={() => { updateTable(t => ({ ...t, rows: [...t.rows, Array(t.columns.length).fill('')] })); setPage(Math.floor(table.rows.length / 50)); }}><Plus size={15} /> Добавить строку</button><div className="pagination"><span>{table.rows.length ? `${page * 50 + 1}–${Math.min(page * 50 + 50, table.rows.length)} из ${table.rows.length}` : 'Нет строк'}</span>{table.rows.length > 50 && <><button className="icon-button" aria-label="Предыдущие строки" disabled={page === 0} onClick={() => setPage(page - 1)}><ArrowLeft size={15} /></button><button className="icon-button" aria-label="Следующие строки" disabled={(page + 1) * 50 >= table.rows.length} onClick={() => setPage(page + 1)}><ArrowRight size={15} /></button></>}</div></div></div></div></>}
            </>}
          </>}
          <div className="editor-status"><span><span className={`status-dot ${busy ? 'pulsing' : ''}`} />{busy ? 'Идёт распознавание' : done.length ? `${done.length} документов · ${totalRows} строк готовы к экспорту` : `${queued.length} фото в очереди`}</span>{uncertain > 0 ? <span className="amber">{uncertain} ячеек требуют проверки</span> : <span>Изменения попадут в Excel</span>}</div>
        </div>
      </section>}
      <footer className="page-footer"><span>Фото в Excel <span className="footer-dot">·</span> Конвертер документов</span><span>Фотографии отправляются в OpenRouter только для распознавания.</span></footer>
    </main>
  </div>;
}
function Brand() { return <a className="brand" href="/" aria-label="Фото в Excel — главная"><span className="brand-mark"><Table2 size={22} /></span><span>Фото <span className="brand-to">в</span> Excel</span><span className="brand-tag">КОНВЕРТЕР</span></a>; }
function Step({ number, title, active, done }: { number: string; title: string; active: boolean; done: boolean }) { return <div className={`step ${active ? 'active' : ''} ${done ? 'done' : ''}`}><span className="step-number">{done ? <Check size={14} /> : number}</span><span>{title}</span></div>; }
function Feature({ title, text }: { title: string; text: string }) { return <div className="feature"><span><Check size={14} /></span><div><strong>{title}</strong><p>{text}</p></div></div>; }
