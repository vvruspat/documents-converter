import { useState } from 'react';
import { Paperclip, Plus, X } from 'lucide-react';
import { entry, type Entry, type SavedProject } from '../../shared/construction';
import s from './projects.module.css';

const groups = [
  { key: 'materials', kind: 'material', label: 'Материал или сертификат' },
  { key: 'schemes', kind: 'scheme', label: 'Исполнительная схема' },
  { key: 'attachments', kind: 'attachment', label: 'Реестр или приложение' },
  { key: 'protocols', kind: 'protocol', label: 'Протокол' },
] as const;
export const isDocumentLink = (key: string) => groups.some((g) => g.key === key);
export type DocumentDraft = { row: Entry; file?: File };
export function ActDocuments({
  project,
  links,
  drafts,
  changeLink,
  changeDraft,
}: {
  project: SavedProject;
  links: Entry['links'];
  drafts: Map<string, DocumentDraft>;
  changeLink: (key: string, ids: string[]) => void;
  changeDraft: (doc: DocumentDraft) => void;
}) {
  const [key, setKey] = useState<string>(groups[0].key);
  const [query, setQuery] = useState('');
  const group = groups.find((g) => g.key === key)!;
  const ids = links[key] || [];
  const available = project.rows.filter(
    (r) =>
      r.kind === group.kind &&
      !ids.includes(r.id) &&
      [r.v.name, r.v.number].join(' ').toLowerCase().includes(query.trim().toLowerCase()),
  );
  const records = new Map(project.rows.map((r) => [r.id, r]));
  function create() {
    const row = entry(group.kind, { name: '' });
    changeDraft({ row });
    changeLink(key, [...ids, row.id]);
  }
  return (
    <div className={s.actDocuments}>
      <div className={s.inline}>
        <label className={s.field}>
          Вид документа
          <select
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              setQuery('');
            }}
          >
            {groups.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className={s.secondary} onClick={create}>
          <Plus size={15} /> Новый документ
        </button>
      </div>
      <details key={key} className={s.linkField}>
        <summary>Выбрать из проекта</summary>
        <input
          type="search"
          aria-label="Поиск документа"
          value={query}
          placeholder="Название или номер"
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.preventDefault();
          }}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className={s.checks}>
          {available.map((r) => (
            <button
              key={r.id}
              type="button"
              className={s.pickDocument}
              onClick={() => changeLink(key, [...ids, r.id])}
            >
              <Plus size={14} />
              {[r.v.name, r.v.number].filter(Boolean).join(' · ')}
            </button>
          ))}
          {!available.length && <small>Нет подходящих документов</small>}
        </div>
      </details>
      {groups.flatMap((g) =>
        (links[g.key] || []).map((id) => {
          const draft = drafts.get(id);
          const saved = records.get(id);
          const row = draft?.row || saved;
          if (!row) return null;
          const put = (field: string, value: string) =>
            changeDraft({
              ...draft,
              row: { ...row, v: { ...row.v, [field]: value } },
            });
          return (
            <section key={id} className={s.attachment} aria-label={row.v.name || g.label}>
              <header>
                <strong>{saved ? [row.v.name, row.v.number].filter(Boolean).join(' · ') : g.label}</strong>
                <button
                  type="button"
                  className={s.icon}
                  aria-label={'Отвязать · ' + (row.v.name || g.label)}
                  onClick={() =>
                    changeLink(
                      g.key,
                      links[g.key].filter((v) => v !== id),
                    )
                  }
                >
                  <X size={15} />
                </button>
              </header>
              {!saved && (
                <div className={s.formGrid}>
                  <label className={s.field}>
                    Название документа
                    <input value={row.v.name} onChange={(e) => put('name', e.target.value)} />
                  </label>
                  <label className={s.field}>
                    Номер документа
                    <input value={row.v.number || ''} onChange={(e) => put('number', e.target.value)} />
                  </label>
                </div>
              )}
              {saved?.file && (
                <a download href={'/api/construction/' + project.id + '/file/' + id}>
                  <Paperclip size={14} />
                  {saved.file}
                </a>
              )}
              <label className={s.field}>
                {saved?.file ? 'Заменить оригинал' : 'Загрузить оригинал'}
                <input
                  type="file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file)
                      changeDraft({
                        row:
                          !saved && !row.v.name.trim()
                            ? { ...row, v: { ...row.v, name: file.name.replace(/\.[^.]+$/, '') || file.name } }
                            : row,
                        file,
                      });
                  }}
                />
              </label>
              {draft?.file && (
                <div className={s.inline}>
                  <small>К сохранению · {draft.file.name}</small>
                  <button type="button" className={s.text} onClick={() => changeDraft({ row })}>
                    Снять файл
                  </button>
                </div>
              )}
            </section>
          );
        }),
      )}
    </div>
  );
}
