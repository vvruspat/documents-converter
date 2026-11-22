import { RecordList, GroupTitle } from './lists/RecordList';
import { useEffect, useState } from 'react';
import { DocumentList, SourceLink as Scan } from './DocumentList';
import { Layers, Plus, Sparkles } from 'lucide-react';
import { assess, kinds, type Card, type DocumentSet, type Requirement, type Source } from '../shared/catalog';

async function request(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
  return data;
}
const empty = (): Requirement => ({ kind: 'Паспорт', number: '', organization: '', batch: '' });
type Answer = { text: string; source: Source };
export function Catalog({ project, revision, view }: { project: string; revision: string; view: string }) {
  const url = '?project=' + encodeURIComponent(project);
  const [cards, setCards] = useState<Card[]>([]);
  const [sets, setSets] = useState<DocumentSet[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [answers, setAnswers] = useState<Answer[] | null>(null);
  const [draft, setDraft] = useState<Requirement[]>([]);
  const [name, setName] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    request('/api/catalog' + url).then(data => {
      if (active) { setCards(data.items); setSets(data.sets); }
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [url, revision, refresh]);
  async function submit(path: string, body: unknown) {
    setBusy(true); setError('');
    try {
      const result = await request(path + url, body);
      if (path.endsWith('/ask')) setAnswers(result.answers);
      else { if (path.endsWith('/sets')) { setDraft([]); setName(''); } setRefresh(v => v + 1); }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="catalog">
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div hidden={view !== 'sets'} className="set-panel">
    {!draft.length && <div className="set-bar"><span>{loading ? 'Загрузка…' : 'Комплектов: ' + sets.length}</span><button className="accent-control" onClick={() => setDraft([empty()])}><Plus size={15}/> Создать комплект</button></div>}
    {!loading && !sets.length && !draft.length && <div className="library-empty"><Layers/><p>В проекте пока нет комплектов</p></div>}
    {sets.length>0 && <RecordList scope={'archive.sets.'+project} rows={sets} columns={[
      {key:'name', label:'Название',value:s=>s.name},{key:'count',label:'Число позиций',value:s=>s.requirements.length},
      {key:'kind',label:'Виды документов',value:s=>s.requirements.map(r=>r.kind)}]}>
      {groups=>groups.map(group=><section key={group.key}><GroupTitle group={group}/>{group.rows.map(set => {
      const positions = set.requirements.map((req,i) => assess(req, cards, set.confirmations[i]));
      const found = positions.filter(r => ['Найден','Подтверждён'].includes(r.status)).length;
      return <details key={set.id} className="kit-card"><summary><Layers size={19}/><strong>{set.name}</strong><span>{found} из {positions.length}</span></summary><progress value={found} max={positions.length} aria-label="Найденные позиции"/>
        <div className="kit-breakdown"><span>На проверке <b>{positions.filter(p => p.status === 'На проверку').length}</b></span><span>Отсутствуют <b>{positions.filter(p => p.status === 'Отсутствует').length}</b></span></div>
        <ul>{positions.map(({ status, matches }, i) => <li key={i}><b className="kit-status" data-status={status}>{status}</b>  {Object.values(set.requirements[i]).filter(Boolean).join(' · ')}
          {matches.map(c => <div key={c.id}>{c.name} · <Scan source={c.sources[0]} /> <button disabled={busy} onClick={() => void submit('/api/catalog/confirm', { id: set.id, position: i, card: status === 'Подтверждён' ? null : c.id })}>{status === 'Подтверждён' ? 'Снять подтверждение' : 'Подтвердить'}</button></div>)}</li>)}</ul>
        <button type="button" onClick={() => { setName(''); setDraft(set.requirements.map(r => ({ ...r }))); }}>Использовать как шаблон</button>
      </details>;
    })}</section>)}</RecordList>}
    {draft.length > 0 &&
      <form onSubmit={e => { e.preventDefault(); void submit('/api/catalog/sets', { name, requirements: draft }); }}>
        <label>Название комплекта<input required maxLength={300} placeholder="Монтаж панелей · С2 · этаж 5" value={name} onChange={e => setName(e.target.value)} /></label>
        {draft.map((req, i) => {
          const edit = (key: keyof Requirement, value: string) => setDraft(items => items.map((item, j) => j === i ? { ...item, [key]: value } : item));
          return <fieldset key={i}><legend>Позиция {i + 1}</legend><label>Вид документа<select value={req.kind} onChange={e => edit('kind', e.target.value)}>{kinds.map(k => <option key={k}>{k}</option>)}</select></label>
            {([['number','Номер документа'],['batch','Партия'],['organization','Организация'],['section','Секция'],['floor','Этаж'],['work','Вид работ']] as const).map(([key,label]) => <label key={key}>{label}<input maxLength={300} value={req[key] || ''} onChange={e => edit(key,e.target.value)} /></label>)}
            {draft.length > 1 && <button type="button" onClick={() => setDraft(items => items.filter((_,j) => j !== i))}>Убрать</button>}</fieldset>;
        })}
        <button type="button" onClick={() => setDraft(items => [...items,empty()])}>Добавить позицию</button>
        <button disabled={busy}>Сохранить комплект</button><button type="button" onClick={() => setDraft([])}>Отмена</button>
      </form>}
    </div>
    <div hidden={view !== 'catalog'}><DocumentList project={project} cards={cards} loading={loading}/></div>
    <div hidden={view !== 'ask'} className="ask-panel"><Sparkles size={24}/>
    <form onSubmit={e => { e.preventDefault(); setAnswers(null); void submit('/api/catalog/ask', { question }); }}>
      <label>О чём найти сведения в документах?<textarea rows={3} required minLength={3} maxLength={1000} value={question} onChange={e => setQuestion(e.target.value)} placeholder="Каким паспортом подтверждена партия 373?" /></label>
      <button disabled={busy || loading || !cards.length}>{busy ? 'Ищем ответ…' : 'Найти ответ'}</button>
    </form>
    {answers && (answers.length ? answers.map((a,i) => <p key={i}>{a.text} <Scan source={a.source} /></p>) : <p>В найденных документах недостаточно сведений для ответа.</p>)}
    </div>
  </section>;
}
