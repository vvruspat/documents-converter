import { useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Download, X, ScanText, Trash2 } from 'lucide-react';
import {
  acceptsOriginal,
  canSign,
  matchStandardText,
  fields,
  roles,
  projectFields,
  formTypes,
  type Entry,
  type Field,
  type SavedProject,
} from '../../shared/construction';
import { ActDocuments, isDocumentLink, type DocumentDraft } from './ActDocuments';
import { StandardRules } from './StandardRules';
import s from './projects.module.css';

export async function api(url: string, options?: RequestInit) {
  const response = await fetch('/api/construction' + url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const fallback =
      response.status === 413
        ? 'Размер загружаемых файлов превышает ограничение сервера.'
        : 'Сервер не смог выполнить запрос (HTTP ' + response.status + ').';
    throw Error(body.message || body.error || fallback);
  }
  return response;
}
export function Modal({
  title,
  close,
  children,
  busy = false,
  drawer = false,
  subtitle,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  busy?: boolean;
  subtitle?: string;
  drawer?: boolean;
}) {
  const opener = useRef(document.activeElement);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content
          className={drawer ? s.dialog + ' ' + s.drawer : s.dialog}
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            if (drawer && opener.current instanceof HTMLElement && opener.current.isConnected) {
              e.preventDefault();
              opener.current.focus({ preventScroll: true });
            }
          }}
        >
          <div className={s.modalHeading}>
            <div className={s.dialogTitle}>
              <Dialog.Title>{title}</Dialog.Title>
              {subtitle && <small title={subtitle}>{subtitle}</small>}
            </div>
            <Dialog.Close disabled={busy} className={s.icon} aria-label="Закрыть">
              <X size={19} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function recordTitle(r: Entry) {
  return (
    [
      r.v.number,
      r.v.name,
      r.kind === 'standard' ? r.v.description : '',
      r.kind === 'person' ? r.v.role : '',
      r.kind === 'material' ? r.v.docType : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'Шаг без названия'
  );
}
function Links({
  field,
  options,
  ids,
  onChange,
}: {
  field: Field;
  options: Entry[];
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  if (!field.many)
    return (
      <label className={s.field}>
        {field.label}
        <select
          required={field.required}
          value={ids[0] || ''}
          onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        >
          <option value="">Выберите…</option>
          {options.map((r) => (
            <option key={r.id} value={r.id}>
              {recordTitle(r)}
            </option>
          ))}
        </select>
      </label>
    );
  const visible = options.filter((r) => recordTitle(r).toLowerCase().includes(search.toLowerCase()));
  return (
    <details className={s.linkField}>
      <summary>
        {field.label} <span>{ids.length}</span>
      </summary>
      <input
        aria-label={'Поиск · ' + field.label}
        placeholder="Поиск по названию или номеру"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className={s.checks}>
        {visible.map((r) => (
          <label key={r.id}>
            <input
              type="checkbox"
              checked={ids.includes(r.id)}
              onChange={(e) => onChange(e.target.checked ? [...ids, r.id] : ids.filter((id) => id !== r.id))}
            />
            {recordTitle(r)}
          </label>
        ))}
        {!visible.length && <small>Нет подходящих записей</small>}
      </div>
    </details>
  );
}
type Props = {
  drawer?: boolean;
  openDocuments?: boolean;
  project: SavedProject;
  row?: Entry;
  title: string;
  close: () => void;
  save: (
    v: Entry['v'],
    links: Entry['links'],
    file?: File,
    detach?: boolean,
    rules?: Entry['rules'],
    documents?: DocumentDraft[],
  ) => Promise<void>;
  remove?: () => Promise<void>;
};
export function Editor({
  project,
  row,
  title,
  close,
  save,
  remove,
  drawer = false,
  openDocuments = false,
}: Props) {
  const [v, setV] = useState({ ...(row?.v || project.v) }),
    [links, setLinks] = useState<Entry['links']>(row?.links || {}),
    [rules, setRules] = useState(row?.rules || []),
    [file, setFile] = useState<File>(),
    [detach, setDetach] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [parseNote, setParseNote] = useState(''),
    [source, setSource] = useState(''),
    [confirm, setConfirm] = useState(false);
  const [section, setSection] = useState<'act' | 'documents'>(openDocuments ? 'documents' : 'act');
  const [drafts, setDrafts] = useState(new Map<string, DocumentDraft>());
  const docIds = new Set(
    Object.entries(links)
      .filter(([key]) => isDocumentLink(key))
      .flatMap(([, ids]) => ids),
  );
  const spec = row ? fields[row.kind] : projectFields;
  const put = (k: string, value: string) => setV((prior) => ({ ...prior, [k]: value }));
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function parse() {
    if (!file) return;
    const data = new FormData();
    data.append('file', file);
    const parsed = await (await api('/parse-certificate', { method: 'POST', body: data })).json();
    setV((prev) => ({
      ...prev,
      ...Object.fromEntries(Object.entries(parsed.values as Record<string, string>).filter(([, val]) => val)),
    }));
    setParseNote(parsed.warning || 'Проверьте распознанные поля перед сохранением.');
    setSource(parsed.text);
  }
  const changeLink = (k: string, ids: string[]) =>
    setLinks((prev) => ({
      ...prev,
      ...(k === 'template' && project.rows.find((r) => r.id === ids[0])?.v.form !== 'structure'
        ? { children: [] }
        : {}),
      [k]: ids,
    }));
  const form = project.rows.find((r) => r.id === links.template?.[0])?.v.form;
  const matched = row?.kind === 'work' && v.compliance ? matchStandardText(v.compliance, project.rows) : undefined;
  return (
    <Modal title={title} close={close} busy={busy} drawer={drawer} subtitle={drawer ? v.name : undefined}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            save(
              v,
              links,
              file,
              detach,
              rules.length ? rules : undefined,
              [...drafts.values()].filter((d) => docIds.has(d.row.id)),
            ),
          );
        }}
      >
        {drawer && (
          <div className={s.drawerTabs} role="group" aria-label="Разделы акта">
            <button type="button" aria-pressed={section === 'act'} onClick={() => setSection('act')}>
              Акт
            </button>
            <button type="button" aria-pressed={section === 'documents'} onClick={() => setSection('documents')}>
              Документы · {docIds.size}
            </button>
          </div>
        )}
        {section === 'documents' && (
          <div className={s.formBody}>
            <ActDocuments
              project={project}
              links={links}
              drafts={drafts}
              changeLink={changeLink}
              changeDraft={(doc) => setDrafts((prev) => new Map(prev).set(doc.row.id, doc))}
            />
          </div>
        )}
        <div className={s.formBody} hidden={section !== 'act'}>
          {row && acceptsOriginal(row.kind) && (
            <div className={s.fileBox}>
              <label className={s.field}>
                {row.kind === 'template' ? 'Файл шаблона Word' : 'Оригинал документа'}
                <input
                  type="file"
                  accept={row.kind === 'template' ? '.docx' : undefined}
                  onChange={(e) => {
                    setFile(e.target.files?.[0]);
                    setDetach(false);
                    setParseNote('');
                    setSource('');
                  }}
                />
              </label>
              {project.rows.some((r) => r.id === row.id) && (row.file || row.kind === 'template') && !detach && (
                <div className={s.inline}>
                  <a href={'/api/construction/' + project.id + '/file/' + row.id} download>
                    <Download size={14} /> {row.file || 'Скачать базовую форму DOCX'}
                  </a>
                  {row.file && (
                    <button
                      type="button"
                      className={s.text}
                      onClick={() => {
                        setFile(undefined);
                        setDetach(true);
                      }}
                    >
                      Убрать файл
                    </button>
                  )}
                </div>
              )}
              {row.kind === 'template' && (
                <small>
                  Для своей формы отредактируйте базовую форму в Word и сохраните именованные закладки.
                </small>
              )}
              {row.kind === 'material' && file && (
                <button type="button" className={s.secondary} disabled={busy} onClick={() => void run(parse)}>
                  <ScanText size={16} /> Распознать сертификат
                </button>
              )}
              {parseNote && <small role="status">{parseNote}</small>}
              {source && (
                <details>
                  <summary>Распознанный текст</summary>
                  <pre>{source}</pre>
                </details>
              )}
            </div>
          )}
          <div className={s.formGrid}>
            {v.sourcePages && <p className={s.wide}>Источник · {v.sourcePages}</p>}
            {v.review && <p className={s.wide}>Требует сверки · {v.review}</p>}
            {spec.map((field) => {
              if (drawer && isDocumentLink(field.key)) return null;
              if (
                row?.kind === 'work' &&
                ['children', 'use', 'load', 'loadTerms'].includes(field.key) &&
                form !== 'structure'
              )
                return null;
              if (field.type === 'link') {
                let options = project.rows.filter((r) => r.kind === field.target);
                if (field.key === 'children')
                  options = options.filter(
                    (r) => project.rows.find((t) => t.id === r.links.template?.[0])?.v.form === 'hidden',
                  );
                if (field.key.startsWith('signer')) {
                  options = options.filter((r) => canSign(r, v.date) || links[field.key]?.includes(r.id));
                  const role = roles[Number(field.key.slice(6))];
                  options.sort((a, b) => Number(b.v.role === role) - Number(a.v.role === role));
                }
                return (
                  <Links
                    key={field.key}
                    field={field}
                    options={options}
                    ids={links[field.key] || []}
                    onChange={(ids) => changeLink(field.key, ids)}
                  />
                );
              }
              const attrs = {
                value: v[field.key] || '',
                required: field.required,
                onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
                  put(field.key, e.target.value),
              };
              return (
                <label
                  className={s.field + ' ' + (field.type === 'long' || field.key === 'name' ? s.wide : '')}
                  key={field.key}
                >
                  {field.label}
                  {field.type === 'choice' ? (
                    <select {...attrs}>
                      <option value="">Выберите…</option>
                      {field.options?.map((o) => (
                        <option key={o} value={o}>
                          {field.key === 'form' ? formTypes[o as keyof typeof formTypes] : o}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'long' ? (
                    <textarea rows={2} {...attrs} />
                  ) : (
                    <input type={field.type === 'date' ? 'date' : 'text'} {...attrs} />
                  )}
                </label>
              );
            })}
          </div>
          {!!matched?.ids.length && (
            <button
              type="button"
              className={s.secondary}
              onClick={() => {
                changeLink('standards', [...new Set([...(links.standards || []), ...matched.ids])]);
                put('compliance', matched.remaining);
              }}
            >
              Связать нормативы из текста · {matched.ids.length}
            </button>
          )}
          {row?.kind === 'standard' && <StandardRules rules={rules} change={setRules} />}
        </div>
        {error && (
          <div className={s.alert} role="alert">
            {error}
          </div>
        )}
        <div className={s.footer}>
          {remove && (
            <button
              type="button"
              className={s.danger}
              disabled={busy}
              onClick={() => (confirm ? void run(remove) : setConfirm(true))}
            >
              <Trash2 size={15} />
              {confirm ? 'Подтвердить удаление' : 'Удалить'}
            </button>
          )}
          <button className={s.secondary} type="button" disabled={busy} onClick={close}>
            Отмена
          </button>
          <button className={s.primary} disabled={busy}>
            {busy ? 'Обработка…' : 'Сохранить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
