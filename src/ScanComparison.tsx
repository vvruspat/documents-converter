import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { ChevronLeft, ChevronRight, Download, ExternalLink, Minus, Plus, X } from 'lucide-react';
import type { Card } from '../shared/catalog';
import { fieldLabels, fieldLines, locate, type Field, type ScanLayout } from '../shared/scan';

type Layout = ScanLayout & { shared: boolean; evidence: { field: Field; quote: string }[] };
export function ScanComparison({ card, close, preferredJob }: { card: Card; close: () => void; preferredJob: string }) {
  const dialog = useRef<HTMLDialogElement>(null),
    left = useRef<HTMLDivElement>(null),
    right = useRef<HTMLDivElement>(null);
  const [sourceIndex, setSource] = useState(
    Math.max(
      0,
      card.sources.findIndex((s) => s.job === preferredJob)
    )
  );
  const source = card.sources[sourceIndex];
  const [page, setPage] = useState(source.first),
    [zoom, setZoom] = useState(100);
  const [field, setField] = useState<Field | ''>(''),
    [hover, setHover] = useState<number | null>(null);
  const [result, setResult] = useState<{ key: string; layout?: Layout; error?: string }>();
  const [retry, setRetry] = useState(0);
  const base = `/api/registry/${source.job}/documents/${source.index}`,
    key = base + '/layout?page=' + page;
  const layout = result?.key === key ? result.layout : undefined;
  const error = result?.key === key ? result.error : undefined;
  useEffect(() => {
    const el = dialog.current!;
    if (typeof el.showModal === 'function') {
      el.showModal();
      return () => el.close();
    }
    el.setAttribute('open', '');
  }, []);
  useEffect(() => {
    const cancel = new AbortController();
    setResult(undefined);
    setHover(null);
    fetch(key, { signal: cancel.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error);
        const data = await r.json();
        if (!cancel.signal.aborted) setResult({ key, layout: data });
      })
      .catch((e) => {
        if (!cancel.signal.aborted) setResult({ key, error: e.message || 'Не удалось открыть страницу.' });
      });
    return () => cancel.abort();
  }, [key, retry]);
  const value = field ? card[field] : '';
  const marks = useMemo(() => {
    const marks: { key: Field; first: number; last: number; lines: ReturnType<typeof fieldLines> }[] = [];
    if (!layout) return marks;
    for (const key of new Set([...card.reviewFields, ...Object.keys(fieldLabels) as Field[]])) {
      if (field && field !== key) continue;
      if (!card[key] && !card.reviewFields.includes(key)) continue;
      const quote = layout.evidence.find((item) => item.field === key)?.quote;
      const range = (quote && locate(layout.words, quote)) || (!layout.shared && locate(layout.words, card[key], key));
      if (!range) continue;
      const [first, last] = range;
      if (marks.some((mark) => first <= mark.last && last >= mark.first)) continue;
      marks.push({ key, first, last, lines: card[key] ? fieldLines(layout.words.slice(first, last + 1), card[key]) : [] });
    }
    return marks;
  }, [card, field, layout]);
  useEffect(() => {
    if (!field || !marks.length || !layout || !left.current) return;
    const pane = left.current;
    const first = layout.words[marks[0].first];
    const scale = (pane.querySelector('svg')?.clientWidth ?? 0) / layout.width;
    if (first && scale)
      pane.scrollTo({ left: first.x * scale - pane.clientWidth / 2, top: first.y * scale - pane.clientHeight / 2 });
  }, [field, marks, layout]);
  function sync(e: UIEvent<HTMLDivElement>, other: HTMLDivElement | null) {
    if (other) {
      const source = e.currentTarget;
      if (Math.abs(other.scrollTop - source.scrollTop) > 1) other.scrollTop = source.scrollTop;
      if (Math.abs(other.scrollLeft - source.scrollLeft) > 1) other.scrollLeft = source.scrollLeft;
    }
  }
  return (
    <dialog className="scan-dialog" ref={dialog} aria-labelledby="compare-heading" onCancel={close}>
      <header>
        <div>
          <small>
            {card.kind} · {card.number || 'Без номера'}
            {card.uncertain && ' · Требует проверки'}
          </small>
          <h2 id="compare-heading">{card.name}</h2>
        </div>
        <button aria-label="Закрыть сравнение" autoFocus onClick={close}>
          <X size={19} />
        </button>
      </header>
      <div className="scan-controls">
        <label>
          Исходник{' '}
          <select
            value={sourceIndex}
            onChange={(e) => {
              const i = Number(e.target.value);
              setSource(i);
              setPage(card.sources[i].first);
            }}
          >
            {card.sources.map((s, i) => (
              <option key={i} value={i}>
                {s.file} · стр. {s.first}
                {s.last !== s.first && '–' + s.last}
              </option>
            ))}
          </select>
        </label>
        <a href={base + '/pdf'} download>
          <Download size={16} />
          PDF документа
        </a>
        <a href={`/api/registry/${source.job}/source#page=${page}`} target="_blank" rel="noreferrer">
          Оригинал <ExternalLink size={14} />
        </a>
      </div>
      <div className="scan-field">
        <label>
          Реквизит{' '}
          <select value={field} onChange={(e) => setField(e.target.value as Field)}>
            <option value="">Все реквизиты</option>
            {Object.entries(fieldLabels).map(([k, label]) => (
              <option key={k} value={k}>
                {label}{card.reviewFields.includes(k as Field) ? ' · проверить' : ''}
              </option>
            ))}
          </select>
        </label>
        {field && <b className={card.reviewFields.includes(field) ? 'review-value' : undefined}>
          {value || (card.reviewFields.includes(field) ? 'Не удалось прочитать' : 'Не указано')}
        </b>}
        {card.reviewFields.length > 0 && <div className="scan-issues" aria-label="Реквизиты для проверки">
          <span>Проверить</span>
          {card.reviewFields.map(key => <button className="review-value" key={key} onClick={() => setField(key)}>{fieldLabels[key]}</button>)}
        </div>}
        {layout && field && (value || card.reviewFields.includes(field)) && !marks.length && <small>Место на листе не подтверждено</small>}
      </div>
      <div className="scan-headings">
        <strong>Скан</strong>
        <strong>Данные реестра и распознанный текст</strong>
      </div>
      {layout ? (
        <div className="scan-pair">
          {['scan', 'text'].map((side, i) => (
            <div
              key={side}
              className="scan-scroll"
              ref={i ? right : left}
              onScroll={(e) => sync(e, i ? left.current : right.current)}
            >
              <svg
                role="img"
                aria-label={i ? 'Распознанные слова в координатах скана' : 'Нормализованный скан'}
                style={{ width: zoom + '%' }}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                onMouseLeave={() => setHover(null)}
              >
                {!i && <image href={base + '/image?page=' + page} width={layout.width} height={layout.height} />}
                {layout.words.map((w, j) => {
                  const mark = marks.find((mark) => j >= mark.first && j <= mark.last);
                  const suspect = mark && card.reviewFields.includes(mark.key);
                  return (
                    <g key={j} onMouseEnter={() => setHover(j)}>
                      <rect
                        x={w.x}
                        y={w.y}
                        width={w.w}
                        height={w.h}
                        fill={suspect ? '#ffbe32' : hover === j || (field && mark) ? '#53bbcd' : 'transparent'}
                        opacity={0.43}
                      />
                      {i === 1 && !mark?.lines.length && (
                        <text
                          x={w.x}
                          y={w.y + w.h * 0.86}
                          fontSize={w.h}
                          textLength={w.w}
                          lengthAdjust="spacingAndGlyphs"
                        >
                          {w.text}
                        </text>
                      )}
                    </g>
                  );
                })}
                {i === 1 &&
                  marks.flatMap((mark) =>
                    mark.lines.map((line, n) => (
                      <text
                        key={mark.key + n}
                        data-field={mark.key}
                        pointerEvents="none"
                        x={line.x}
                        y={line.y + line.h * 0.86}
                        fontSize={line.h}
                        textLength={line.w}
                        lengthAdjust="spacingAndGlyphs"
                      >
                        {line.text}
                      </text>
                    ))
                  )}
              </svg>
            </div>
          ))}
        </div>
      ) : (
        <p role="status" className="scan-wait">
          {error || 'Готовим страницу для сравнения…'}{' '}
          {error && <button onClick={() => setRetry((v) => v + 1)}>Повторить</button>}
        </p>
      )}
      {layout && (!layout.words.length || layout.shared) && (
        <small>
          {!layout.words.length ? 'На листе не удалось распознать текст. ' : ''}
          {layout.shared && 'Лист содержит несколько документов. В PDF он сохраняется целиком.'}
        </small>
      )}
      <footer>
        <button aria-label="Предыдущий лист" disabled={page === source.first} onClick={() => setPage(page - 1)}>
          <ChevronLeft size={16} />
        </button>
        <span>
          Лист {page - source.first + 1} из {source.last - source.first + 1}
        </span>
        <button aria-label="Следующий лист" disabled={page === source.last} onClick={() => setPage(page + 1)}>
          <ChevronRight size={16} />
        </button>
        <button aria-label="Уменьшить" disabled={zoom <= 100} onClick={() => setZoom(zoom - 50)}>
          <Minus size={15} />
        </button>
        <span>{zoom}%</span>
        <button aria-label="Увеличить" disabled={zoom >= 350} onClick={() => setZoom(zoom + 50)}>
          <Plus size={15} />
        </button>
      </footer>
    </dialog>
  );
}
