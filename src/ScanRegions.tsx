import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { regionKinds, regionLabels, type Region, type RegionBox, type RegionKind } from '../shared/regions';

type Props = {
  width: number;
  height: number;
  image: string;
  endpoint: string;
  saved: Region[];
  children: (overlay: (onScan: boolean) => ReactNode) => ReactNode;
};

export function ScanRegions({ width, height, image, endpoint, saved, children }: Props) {
  const [regions, setRegions] = useState(saved);
  const [active, setActive] = useState<Region | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [kind, setKind] = useState<RegionKind>('seal');
  const [draft, setDraft] = useState<RegionBox | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const start = useRef<{ x: number; y: number } | null>(null);
  const pending = useRef(false);

  function open(region: Region) {
    setActive(region);
    setDraft(null);
    setDrawing(false);
    setError('');
  }
  function point(event: PointerEvent<SVGRectElement>) {
    const svg = event.currentTarget.ownerSVGElement!;
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM()!.inverse());
    const clamp = (v: number) => Math.max(0, Math.min(1000, Math.round(v)));
    return { x: clamp((p.x * 1000) / width), y: clamp((p.y * 1000) / height) };
  }
  function drag(event: PointerEvent<SVGRectElement>) {
    if (!start.current) return;
    const a = start.current,
      b = point(event);
    const box = {
      kind,
      left: Math.min(a.x, b.x),
      right: Math.max(a.x, b.x),
      top: Math.min(a.y, b.y),
      bottom: Math.max(a.y, b.y),
    };
    setDraft(box);
    return box;
  }
  function bounds(box: RegionBox) {
    return {
      x: (box.left * width) / 1000,
      y: (box.top * height) / 1000,
      width: ((box.right - box.left) * width) / 1000,
      height: ((box.bottom - box.top) * height) / 1000,
    };
  }
  async function recognize(box: RegionBox) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(box),
      });
      if (!response.ok) {
        const message = await response.json().catch(() => null);
        throw new Error(message?.error || 'Не удалось отправить фрагмент.');
      }
      const { region }: { region: Region } = await response.json();
      setRegions((items) => [...items.filter((r) => r.id !== region.id), region]);
      open(region);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось отправить фрагмент.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function overlay(onScan: boolean) {
    return (
      <>
        {regions.map((r, i) => {
          const b = bounds(r),
            label = regionLabels[r.kind] + ' ' + (i + 1);
          return (
            <g key={r.id} className="region-frame" data-status={r.status} onClick={() => open(r)}>
              <title>{label}</title>
              <rect {...b} vectorEffect="non-scaling-stroke" strokeWidth={active?.id === r.id ? 3 : 1.5} />
              <text x={b.x + 2} y={Math.max(24, b.y - 4)} fontSize={Math.round(width * 0.017)}>
                {label}
              </text>
            </g>
          );
        })}
        {draft && (
          <rect {...bounds(draft)} className="region-draft" vectorEffect="non-scaling-stroke" pointerEvents="none" />
        )}
        {drawing && onScan && (
          <rect
            width={width}
            height={height}
            fill="transparent"
            style={{ cursor: 'crosshair', touchAction: 'none' }}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              start.current = point(event);
              setDraft(null);
            }}
            onPointerMove={drag}
            onPointerUp={(event) => {
              if (!start.current) return;
              const box = drag(event);
              start.current = null;
              if (box && box.right > box.left && box.bottom > box.top) setDrawing(false);
              else setDraft(null);
            }}
            onPointerCancel={() => {
              start.current = null;
              setDraft(null);
            }}
          />
        )}
      </>
    );
  }
  const box = !drawing && (draft || active);
  const b = box ? bounds(box) : null;
  return (
    <>
      <div className="region-tools">
        <button
          type="button"
          disabled={busy}
          aria-pressed={drawing}
          onClick={() => {
            setActive(null);
            setDraft(null);
            setDrawing(!drawing);
            setError('');
          }}
        >
          {drawing ? 'Отменить выделение' : 'Выделить фрагмент'}
        </button>
        {(draft || drawing) && (
          <label>
            Тип{' '}
            <select
              aria-label="Тип фрагмента"
              value={kind}
              onChange={(e) => {
                const k = e.target.value as RegionKind;
                setKind(k);
                if (draft) setDraft({ ...draft, kind: k });
              }}
            >
              {regionKinds.map((k) => (
                <option key={k} value={k}>
                  {regionLabels[k]}
                </option>
              ))}
            </select>
          </label>
        )}
        {drawing && <small>Обведите фрагмент на скане слева.</small>}
        {!!regions.length && (
          <label>
            Фрагменты{' '}
            <select
              aria-label="Фрагменты листа"
              value={active?.id ?? ''}
              onChange={(e) => {
                const r = regions.find((item) => item.id === e.target.value);
                if (r) open(r);
                else setActive(null);
              }}
            >
              <option value="">Выберите область</option>
              {regions.map((r, i) => (
                <option key={r.id} value={r.id}>
                  {regionLabels[r.kind]} {i + 1}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {children(overlay)}
      {box && b && (
        <section className="region-reading" aria-label="Расшифровка фрагмента">
          {active && active.status !== 'error' ? (
            <a
              className="region-preview"
              href={image + '&region=' + active.id}
              target="_blank"
              rel="noreferrer"
              title="Открыть вырезку в полном размере"
            >
              <img src={image + '&region=' + active.id} alt="Фрагмент, переданный на распознавание" />
            </a>
          ) : (
            <svg role="img" aria-label="Выбранный фрагмент скана" viewBox={[0, 0, b.width, b.height].join(' ')}>
              <svg
                width={b.width}
                height={b.height}
                viewBox={[b.x, b.y, b.width, b.height].join(' ')}
                overflow="hidden"
              >
                <image href={image} width={width} height={height} />
              </svg>
            </svg>
          )}
          <div>
            <strong>{regionLabels[box.kind]}</strong>
            {active?.text && (
              <p>
                {active.text.split(/(\[неразборчиво\])/gi).map((s, i) =>
                  s.toLowerCase() === '[неразборчиво]' ? (
                    <mark key={i} className="review-value">
                      {s}
                    </mark>
                  ) : (
                    s
                  )
                )}
              </p>
            )}
            {active?.status === 'partial' && <small>Часть текста не удалось прочитать.</small>}
            {active?.status === 'unreadable' && <p>Текст не удалось прочитать.</p>}
            {active?.status === 'error' && <p>Распознавание не завершилось.</p>}
            {(draft || active?.status === 'error') && (
              <button disabled={busy} onClick={() => recognize(box)}>
                {busy ? 'Распознаём…' : draft ? 'Распознать фрагмент' : 'Повторить распознавание'}
              </button>
            )}
            {error && <p role="alert">{error}</p>}
          </div>
          <button
            aria-label="Закрыть фрагмент"
            onClick={() => {
              setActive(null);
              setDraft(null);
              setError('');
            }}
          >
            ×
          </button>
        </section>
      )}
    </>
  );
}
