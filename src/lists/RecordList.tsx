import { useMemo, useState, type ReactNode } from 'react';
import { Bookmark, ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from 'lucide-react';
import {
  arrange,
  caption,
  choices,
  defaultConfig,
  librarySchema,
  pageGroups,
  type Column,
  type Config,
  type Group,
  type Library,
} from './model';
import s from './lists.module.css';

type Props<T> = {
  scope: string;
  rows: T[];
  columns: Column<T>[];
  quickFilter?: { key: string; value: string };
  pageSize?: number;
  placeholder?: string;
  empty?: ReactNode;
  children: (groups: Group<T>[], config: Config) => ReactNode;
};
function read(key: string): Library {
  try {
    return librarySchema.parse(JSON.parse(localStorage.getItem(key) || 'null'));
  } catch {
    return { active: '', views: [] };
  }
}
export function RecordList<T>(props: Props<T>) {
  return <ScopedList key={props.scope} {...props} />;
}
function ScopedList<T>({
  scope,
  rows,
  columns,
  children,
  pageSize = 25,
  quickFilter,
  placeholder = 'Поиск по списку',
  empty,
}: Props<T>) {
  const key = 'documents.views.v1.' + scope;
  const [library, setLibrary] = useState(() => read(key));
  const saved = library.views.find((v) => v.id === library.active);
  const [config, setConfig] = useState<Config>(() => saved?.config || defaultConfig);
  const [panel, setPanel] = useState<'' | 'settings' | 'views'>('');
  const [field, setField] = useState(columns[0]?.key || '');
  const [name, setName] = useState(saved?.name || '');
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const size = config.size || pageSize;
  const groups = useMemo(() => arrange(rows, columns, config), [rows, columns, config]);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const current = Math.min(page, Math.max(0, Math.ceil(total / size) - 1));
  const visible = pageGroups(groups, current * size, size);
  const dirty = JSON.stringify(config) !== JSON.stringify(saved?.config || defaultConfig);
  const col = columns.find((c) => c.key === field) || columns[0];
  const filterKeys = columns.filter((c) => config.filters[c.key]?.length);
  function change(patch: Partial<Config>) {
    setConfig((old) => ({ ...old, ...patch }));
    setPage(0);
  }
  function persist(next: Library) {
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setLibrary(next);
      setError('');
      return true;
    } catch {
      setError('Браузер не смог сохранить представление. Проверьте доступ к локальному хранилищу.');
      return false;
    }
  }
  function select(id: string) {
    const latest = read(key);
    const view = latest.views.find((v) => v.id === id);
    if (persist({ ...latest, active: view?.id || '' })) {
      change(view?.config || defaultConfig);
      setName(view?.name || '');
    }
  }
  function save(copy: boolean) {
    const latest = read(key);
    const title = name.trim();
    if (
      !title ||
      latest.views.some((v) => (copy || v.id !== saved?.id) && v.name.toLowerCase() === title.toLowerCase())
    ) {
      setError('Введите уникальное название представления.');
      return;
    }
    const id = copy || !saved ? crypto.randomUUID() : saved.id;
    const view = { id, name: title, config };
    const views = latest.views.some((v) => v.id === id)
      ? latest.views.map((v) => (v.id === id ? view : v))
      : [...latest.views, view];
    if (persist({ active: id, views })) {
      setName(title);
      setPanel('');
    }
  }
  function remove() {
    const latest = read(key);
    if (saved && persist({ active: '', views: latest.views.filter((v) => v.id !== saved.id) })) {
      setName('');
      setPanel('');
    }
  }
  function toggleFilter(column: string, value: string) {
    const list = config.filters[column] || [];
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    const filters = { ...config.filters };
    if (next.length) filters[column] = next;
    else delete filters[column];
    change({ filters });
  }
  return (
    <div className={s.list}>
      {library.views.length > 0 && (
        <div className={s.views} role="group" aria-label="Мои представления">
          <button type="button" aria-pressed={!saved} onClick={() => select('')}>
            Все записи
          </button>
          {library.views.map((v) => (
            <button type="button" key={v.id} aria-pressed={v.id === saved?.id} onClick={() => select(v.id)}>
              {v.name}
            </button>
          ))}
        </div>
      )}
      <div className={s.bar}>
        <label className={s.search}>
          <Search size={15} />
          <input
            type="search"
            aria-label={placeholder}
            placeholder={placeholder}
            value={config.query}
            onChange={(e) => change({ query: e.target.value })}
          />
        </label>
        {quickFilter && (
          <button
            type="button"
            aria-pressed={config.filters[quickFilter.key]?.includes(quickFilter.value) || false}
            onClick={() => toggleFilter(quickFilter.key, quickFilter.value)}
          >
            {quickFilter.value}
          </button>
        )}
        <button
          type="button"
          aria-expanded={panel === 'settings'}
          onClick={() => setPanel(panel === 'settings' ? '' : 'settings')}
        >
          <SlidersHorizontal size={15} />
          Настроить{filterKeys.length > 0 && <b>{filterKeys.length}</b>}
        </button>
        <button
          type="button"
          aria-expanded={panel === 'views'}
          onClick={() => setPanel(panel === 'views' ? '' : 'views')}
        >
          <Bookmark size={15} />
          <span>Представления</span>
          {dirty && <i aria-label="Есть изменения">•</i>}
        </button>
      </div>
      {panel === 'settings' && (
        <section className={s.panel} aria-label="Настройка списка">
          <div className={s.controls}>
            <label>
              Группировка
              <select
                aria-label="Группировка"
                value={config.group}
                onChange={(e) => change({ group: e.target.value })}
              >
                <option value="">Без группировки</option>
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Сортировка
              <select
                aria-label="Сортировка"
                value={config.sort}
                onChange={(e) => change({ sort: e.target.value })}
              >
                <option value="">Исходный порядок</option>
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {config.sort && (
              <label>
                Порядок
                <select
                  aria-label="Порядок"
                  value={config.descending ? 'desc' : 'asc'}
                  onChange={(e) => change({ descending: e.target.value === 'desc' })}
                >
                  <option value="asc">По возрастанию</option>
                  <option value="desc">По убыванию</option>
                </select>
              </label>
            )}
            <label>
              Фильтр по полю
              <select aria-label="Фильтр по полю" value={col.key} onChange={(e) => setField(e.target.value)}>
                {columns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={s.options} role="group" aria-label={col.label}>
            {choices(rows, col, config.filters[col.key] || []).map((v) => (
              <label key={v}>
                <input
                  type="checkbox"
                  checked={config.filters[col.key]?.includes(v) || false}
                  onChange={() => toggleFilter(col.key, v)}
                />
                {caption(col, v)}
              </label>
            ))}
          </div>
        </section>
      )}
      {panel === 'views' && (
        <section className={s.panel} aria-label="Сохранённые представления">
          <div className={s.controls}>
            <label>
              Название представления
              <input
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например, без оригиналов"
              />
            </label>
            <button type="button" onClick={() => save(false)}>
              Сохранить
            </button>
            {saved && (
              <>
                <button type="button" onClick={() => save(true)}>
                  Сохранить как новое
                </button>
                <button type="button" onClick={remove}>
                  Удалить представление
                </button>
              </>
            )}
          </div>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {(dirty || config.group || config.sort || filterKeys.length > 0 || config.query) && (
        <div className={s.summary}>
          <span>
            {total} из {rows.length}
          </span>
          {filterKeys.flatMap((c) =>
            config.filters[c.key].map((v) => (
              <button key={JSON.stringify([c.key, v])} onClick={() => toggleFilter(c.key, v)}>
                {c.label} · {caption(c, v)} <X size={12} />
              </button>
            )),
          )}
          {config.group && <span>Группы · {columns.find((c) => c.key === config.group)?.label}</span>}
          {config.sort && (
            <span>
              {columns.find((c) => c.key === config.sort)?.label} {config.descending ? '↓' : '↑'}
            </span>
          )}
          {dirty && <button onClick={() => change(saved?.config || defaultConfig)}>Сбросить изменения</button>}
        </div>
      )}
      {visible.length ? (
        children(visible, config)
      ) : (
        <div className={s.empty}>
          {!rows.length ? (
            empty || 'Пока нет записей'
          ) : (
            <>
              Совпадений нет{' '}
              <button onClick={() => change({ ...config, query: '', filters: {} })}>Сбросить фильтры</button>
            </>
          )}
        </div>
      )}
      {total > 0 && (total > size || pageSize === 10 || size !== pageSize) && (
        <footer className={s.pager}>
          <span>
            {current * size + 1}–{Math.min(total, (current + 1) * size)} из {total}
          </span>
          <label>
            По{' '}
            <select
              aria-label="Показывать по"
              value={size}
              onChange={(e) => {
                change({ size: Number(e.target.value) === pageSize ? null : Number(e.target.value) });
              }}
            >
              {[...new Set([10, pageSize, 25, 50])].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <button aria-label="Предыдущая страница" disabled={!current} onClick={() => setPage(current - 1)}>
            <ChevronLeft size={15} />
          </button>
          <button
            aria-label="Следующая страница"
            disabled={(current + 1) * size >= total}
            onClick={() => setPage(current + 1)}
          >
            <ChevronRight size={15} />
          </button>
        </footer>
      )}
    </div>
  );
}
export function GroupTitle({ group }: { group: Pick<Group<unknown>, 'label' | 'total'> }) {
  return group.label ? (
    <h3 className={s.group}>
      {group.label}
      <small>{group.total}</small>
    </h3>
  ) : null;
}
