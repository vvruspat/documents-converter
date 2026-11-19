import { useEffect, useState } from 'react';
import { assess, kinds, normalized, type Card, type DocumentSet, type Requirement, type Source } from '../shared/catalog';

async function request(path: string, body?: unknown) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Не удалось выполнить запрос.');
  return data;
}
function Scan({ source }: { source: Source }) {
  return <a href={`/api/registry/${source.job}/source#page=${source.first}`} target="_blank" rel="noreferrer">{source.file} · стр. {source.first}{source.last !== source.first && '–' + source.last}</a>;
}
const empty = (): Requirement => ({ kind: 'Паспорт', number: '', organization: '', batch: '' });
type Answer = { text: string; source: Source };
export function Catalog({ project, revision }: { project: string; revision: string }) {
  const url = '?project=' + encodeURIComponent(project);
  const [cards, setCards] = useState<Card[]>([]);
  const [sets, setSets] = useState<DocumentSet[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(40);
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
  const filtered = cards.filter(card => normalized([card.name, card.number, card.date, card.organization, card.kind, card.material, card.work, card.batch, card.floor, card.section, ...card.sources.map(s => s.file)].join(' ')).includes(normalized(query)));
  return <section className="catalog">
    {error && <p className="error-banner" role="alert">{error}</p>}
    <h2>Комплекты документации</h2>
    {sets.map(set => {
      const positions = set.requirements.map((req,i) => assess(req, cards, set.confirmations[i]));
      return <details key={set.id}><summary>{set.name} · найдено {positions.filter(r => ['Найден','Подтверждён'].includes(r.status)).length} из {positions.length}</summary>
        <ul>{positions.map(({ status, matches }, i) => <li key={i}><b>{status}</b> · {Object.values(set.requirements[i]).filter(Boolean).join(' · ')}
          {matches.map(c => <div key={c.id}>{c.name} · <Scan source={c.sources[0]} /> <button disabled={busy} onClick={() => void submit('/api/catalog/confirm', { id: set.id, position: i, card: status === 'Подтверждён' ? null : c.id })}>{status === 'Подтверждён' ? 'Снять подтверждение' : 'Подтвердить'}</button></div>)}</li>)}</ul>
        <button type="button" onClick={() => { setName(''); setDraft(set.requirements.map(r => ({ ...r }))); }}>Использовать как шаблон</button>
      </details>;
    })}
    {!draft.length ? <button onClick={() => setDraft([empty()])}>Создать комплект</button> :
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
    <h2>Документы проекта</h2>
    <label>Поиск по реквизитам<input value={query} onChange={e => { setQuery(e.target.value); setLimit(40); }} placeholder="Материал, номер, организация" /></label>
    <p role="status">{loading ? 'Загружаем каталог…' : `Документов: ${filtered.length}`}</p>
    {filtered.slice(0,limit).map(card => <details key={card.id}><summary>{card.name} {card.number} · {card.date || 'Дата не указана'} {card.uncertain && '· На проверку'}</summary>
      <p>{[card.organization, card.material, card.batch && 'Партия ' + card.batch, card.work, card.section && 'Секция ' + card.section, card.floor && 'Этаж ' + card.floor].filter(Boolean).join(' · ')}</p>
      {card.sources.map((source,i) => <div key={i}><Scan source={source} /></div>)}
    </details>)}
    {filtered.length > limit && <button onClick={() => setLimit(v => v + 40)}>Показать ещё</button>}
    <h2>Вопрос по документам</h2>
    <form onSubmit={e => { e.preventDefault(); setAnswers(null); void submit('/api/catalog/ask', { question }); }}>
      <label>Вопрос<input required minLength={3} maxLength={1000} value={question} onChange={e => setQuestion(e.target.value)} placeholder="Каким паспортом подтверждена партия 373?" /></label>
      <button disabled={busy || loading || !cards.length}>Спросить AI</button>
    </form>
    {answers && (answers.length ? answers.map((a,i) => <p key={i}>{a.text} <Scan source={a.source} /></p>) : <p>В найденных документах недостаточно сведений для ответа.</p>)}
  </section>;
}
