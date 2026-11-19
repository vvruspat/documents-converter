import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, ClipboardList, FileBadge, FileText, FolderOpen, ListFilter, Search, Shapes, X } from 'lucide-react';
import { normalized, type Card, type Source } from '../shared/catalog';

const icons = { 'Акт': ClipboardList, 'Паспорт': BookOpen, 'Сертификат': FileBadge, 'Исполнительная схема': Shapes };
function DocumentIcon({ kind }: { kind: string }) {
  const Icon = icons[kind as keyof typeof icons] ?? FileText;
  return <span className="document-icon" data-kind={kind}><Icon size={18} /></span>;
}
export function SourceLink({ source }: { source: Source }) {
  return <a className="source-link" href={`/api/registry/${source.job}/source#page=${source.first}`} target="_blank" rel="noreferrer">
    <FileText size={15}/><span>{source.file} · стр. {source.first}{source.last !== source.first && '–' + source.last}</span><ArrowUpRight size={15}/>
  </a>;
}
function ScanShortcut({ source }: { source: Source }) {
  return <a className="scan-shortcut" target="_blank" rel="noreferrer" href={`/api/registry/${source.job}/source#page=${source.first}`}>
    <span>{source.file}</span><small>Лист {source.first}{source.last !== source.first && '–' + source.last} ↗</small></a>;
}
function DocumentDialog({ card, close }: { card: Card; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
      return () => dialog.close();
    }
    dialog.setAttribute('open', '');
  }, []);
  const fields = [['Номер документа', card.number], ['Дата', card.date], ['Организация', card.organization], ['Материал',card.material], ['Партия',card.batch], ['Вид работ',card.work], ['Секция',card.section], ['Этаж',card.floor]];
  return <dialog ref={ref} className="document-dialog" aria-labelledby="card-heading" onCancel={close} onClick={e => { if (e.target === ref.current) close(); }}>
    <article><div className="dialog-top"><DocumentIcon kind={card.kind}/><span>{card.kind}</span><button className="round-control" aria-label="Закрыть карточку" onClick={close} autoFocus><X size={18}/></button></div>
      <h2 id="card-heading">{card.name}</h2>{card.uncertain && <span className="review-state">Требует проверки</span>}
      <dl>{fields.filter(([,v],i) => v || i < 3).map(([k,v]) => <div key={k}><dt>{k}</dt><dd>{v || 'Не указано'}</dd></div>)}</dl>
      <h3>Исходные сканы</h3>{card.sources.map((s,i) => <SourceLink source={s} key={i}/>)}
    </article></dialog>;
}
const perPage = 20;
export function DocumentList({ cards, loading }: { cards: Card[]; loading: boolean }) {
  const [query,setQuery] = useState(''), [kind,setKind] = useState(''), [review,setReview] = useState(false);
  const [volume,setVolume] = useState('');
  const volumes = new Map(cards.flatMap(card => card.sources.map(s => [s.job, s.file] as const)));
  const [page,setPage] = useState(0), [opened,setOpened] = useState<Card | null>(null);
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  const filtered = cards.filter(c => {
    if ((volume && !c.sources.some(s => s.job === volume)) || (kind && c.kind !== kind) || (review && !c.uncertain)) return false;
    const text = normalized([c.name,c.number,c.organization,c.kind,c.section,c.floor,c.date,c.material,c.batch,c.work,...c.sources.map(s=>s.file)].join(' '));
    return terms.every(term => text.includes(term));
  });
  const current = Math.min(page, Math.max(0, Math.ceil(filtered.length/perPage)-1)), start = current*perPage;
  return <section className="library-panel">
    <div className="library-toolbar"><label className="search-box"><Search size={18}/><input type="search" aria-label="Поиск по документам" placeholder="Название, номер или организация" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/></label>
      <label className="kind-filter"><ListFilter size={16}/><select aria-label="Вид документа" value={kind} onChange={e=>{setKind(e.target.value);setPage(0);}}><option value="">Все виды</option>{[...new Set(cards.map(c=>c.kind))].sort().map(k=><option key={k}>{k}</option>)}</select></label>
      <label className="kind-filter"><FolderOpen size={16}/><select aria-label="Исходный PDF" value={volume} onChange={e=>{setVolume(e.target.value);setPage(0);}}><option value="">Все PDF</option>{[...volumes].map(([id,file])=><option key={id} value={id}>{file}</option>)}</select></label></div>
    <div className="library-switch"><button aria-pressed={!review} onClick={()=>{setReview(false);setPage(0);}}>Все документы <b>{cards.length}</b></button><button aria-pressed={review} onClick={()=>{setReview(true);setPage(0);}}>Требуют проверки <b>{cards.filter(c=>c.uncertain).length}</b></button></div>
    {filtered.length > 0 ? <><table className="document-table"><thead><tr><th>Документ</th><th>Организация</th><th>Дата</th><th className="scan-column">Исходник</th><th aria-label="Открыть"/></tr></thead><tbody>
      {filtered.slice(start,start+perPage).map(c=><tr key={c.id} onClick={()=>setOpened(c)}><td><div className="document-title"><DocumentIcon kind={c.kind}/><div><button onClick={e=>{e.stopPropagation();setOpened(c);}}>{c.name}</button><small>{[c.kind,c.number].filter(Boolean).join(' · ')}</small></div></div></td>
        <td>{c.organization || '—'}</td><td>{c.date || '—'}</td><td className="scan-column" onClick={e=>e.stopPropagation()}><ScanShortcut source={c.sources.find(s=>s.job===volume) ?? c.sources[0]}/></td><td><ChevronRight size={15}/></td></tr>)}</tbody></table>
      <footer className="library-pager"><span>{start+1}–{Math.min(start+perPage,filtered.length)} из {filtered.length}</span><button aria-label="Предыдущая страница" disabled={!current} onClick={()=>setPage(current-1)}><ChevronLeft size={16}/></button><button aria-label="Следующая страница" disabled={start+perPage>=filtered.length} onClick={()=>setPage(current+1)}><ChevronRight size={16}/></button></footer></> :
      <div className="library-empty"><FolderOpen/><p>{loading ? 'Загружаем документы…' : cards.length ? 'Документы не найдены' : 'В проекте пока нет документов'}</p>{(query || kind || review || volume) && <button onClick={()=>{setKind('');setQuery('');setVolume('');setReview(false);setPage(0);}}><X size={14}/> Сбросить фильтры</button>}</div>}
    {opened && <DocumentDialog card={opened} close={()=>setOpened(null)}/>}
  </section>;
}
