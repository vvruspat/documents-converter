import { useEffect, useRef, useState } from 'react';
import { Settings, X } from 'lucide-react';
import type { Models } from '../shared/models';

const fields: { key: keyof Models; label: string; hint: string }[] = [
  { key: 'recognition', label: 'Распознавание документов', hint: 'Фото, PDF и постраничный разбор реестров.' },
  { key: 'chat', label: 'Чат по архиву', hint: 'Ответы на вопросы по документам проекта.' },
  { key: 'regions', label: 'Сложные фрагменты', hint: 'Печати, штампы и рукописный текст.' },
];

export function ModelSettingsButton({ compact = false }: { compact?: boolean }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button
        type="button"
        className={compact ? 'button compact' : 'model-settings-trigger'}
        aria-label="Настройки моделей"
        title="Настройки моделей"
        onClick={() => setOpened(true)}
      >
        <Settings size={17} />
        <span>{compact ? 'Сменить модель' : 'Настройки'}</span>
      </button>
      {opened && <SettingsDialog close={() => setOpened(false)} />}
    </>
  );
}

function SettingsDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [values, setValues] = useState<Models>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    const el = dialog.current!;
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    const abort = new AbortController();
    fetch('/api/settings/models', { signal: abort.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Не удалось загрузить модели.');
        setValues(await res.json());
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => {
      abort.abort();
      el.close?.();
    };
  }, []);
  async function save() {
    if (!values || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/settings/models', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось сохранить настройки.');
      setValues(data);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ошибка сохранения.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="model-settings-dialog"
      aria-label="Модели OpenRouter"
      onCancel={(e) => {
        e.stopPropagation();
        close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="model-settings-heading">
          <h2>Модели OpenRouter</h2>
          <button type="button" aria-label="Закрыть настройки" className="icon-button" onClick={close}>
            <X size={18} />
          </button>
        </div>
        {values
          ? fields.map(({ key, label, hint }) => (
              <label key={key}>
                {label}
                <input
                  aria-label={label}
                  required
                  spellCheck={false}
                  autoCapitalize="none"
                  maxLength={256}
                  value={values[key]}
                  placeholder="provider/model"
                  disabled={busy}
                  onChange={(e) => {
                    setSaved(false);
                    setValues({ ...values, [key]: e.target.value });
                  }}
                />
                <small>{hint}</small>
              </label>
            ))
          : !error && <p>Загружаем настройки…</p>}
        {error && (
          <p role="alert" className="error-banner">
            {error}
          </p>
        )}
        <footer>
          <span role="status">{saved ? 'Настройки сохранены' : 'Общие для всех проектов'}</span>
          <button className="button primary" disabled={!values || busy || saved}>
            {busy ? 'Сохраняем…' : 'Сохранить'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
