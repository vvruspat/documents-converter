import { formTypes } from '../../shared/construction';
import {
  attachments,
  bookmark,
  ruleForms,
  textFields,
  type RuleForm,
  type StandardRule,
  type TextField,
} from '../../shared/standard-rules';
import s from './projects.module.css';

export function StandardRules({
  rules,
  change,
}: {
  rules: StandardRule[];
  change: (rules: StandardRule[]) => void;
}) {
  return (
    <section className={s.ruleSection}>
      <h3>Правила норматива</h3>
      <p>
        Правило действует для работ, в которых выбран этот норматив. Изменения текста применяются при выгрузке.
      </p>
      {rules.map((rule, index) => {
        const update = (next: StandardRule) => change(rules.map((item, i) => (i === index ? next : item)));
        const scope = { form: rule.form, workContains: rule.workContains, clause: rule.clause };
        return (
          <fieldset className={s.rule} key={index}>
            <legend>Правило {index + 1}</legend>
            <div className={s.formGrid}>
              <label className={s.field}>
                Вид акта
                <select
                  value={rule.form}
                  onChange={(e) => {
                    const form = e.target.value as RuleForm;
                    update(
                      rule.action === 'require'
                        ? { ...rule, form }
                        : { ...rule, form, field: bookmark(rule.field, form) ? rule.field : 'design' },
                    );
                  }}
                >
                  {ruleForms.map((form) => (
                    <option key={form} value={form}>
                      {formTypes[form]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s.field}>
                Действие
                <select
                  value={rule.action}
                  onChange={(e) => {
                    const action = e.target.value as StandardRule['action'];
                    if (action === 'require') update({ ...scope, action, category: 'protocols', document: '' });
                    else
                      update(
                        rule.action === 'require'
                          ? { ...scope, action, field: 'design', text: '' }
                          : { ...rule, action },
                      );
                  }}
                >
                  <option value="append">Дополнить поле</option>
                  <option value="replace">Заменить текст поля</option>
                  <option value="require">Потребовать приложение</option>
                </select>
              </label>
              <label className={s.field}>
                Название работы содержит
                <input
                  value={rule.workContains}
                  maxLength={300}
                  placeholder="Пусто — все работы этого вида акта"
                  onChange={(e) => update({ ...rule, workContains: e.target.value })}
                />
              </label>
              <label className={s.field}>
                Основание правила
                <input
                  value={rule.clause}
                  maxLength={500}
                  placeholder="Пункт, редакция или лист проекта"
                  onChange={(e) => update({ ...rule, clause: e.target.value })}
                />
              </label>
              {rule.action === 'require' ? (
                <>
                  <label className={s.field}>
                    Категория приложения
                    <select
                      value={rule.category}
                      onChange={(e) => update({ ...rule, category: e.target.value as keyof typeof attachments })}
                    >
                      {Object.entries(attachments).map(([key, label]) => (
                        <option value={key} key={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={s.field}>
                    Вид или название документа
                    <input
                      value={rule.document}
                      maxLength={500}
                      placeholder="Точное совпадение или любой в категории"
                      onChange={(e) => update({ ...rule, document: e.target.value })}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className={s.field}>
                    Поле акта
                    <select
                      value={rule.field}
                      onChange={(e) => update({ ...rule, field: e.target.value as TextField })}
                    >
                      {(Object.keys(textFields) as TextField[])
                        .filter((key) => bookmark(key, rule.form))
                        .map((key) => (
                          <option value={key} key={key}>
                            {textFields[key].label}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className={s.field}>
                    Текст для выгрузки
                    <textarea
                      required
                      maxLength={4000}
                      value={rule.text}
                      onChange={(e) => update({ ...rule, text: e.target.value })}
                    />
                  </label>
                </>
              )}
            </div>
            <button type="button" className={s.text} onClick={() => change(rules.filter((_, i) => i !== index))}>
              Удалить правило
            </button>
          </fieldset>
        );
      })}
      <button
        type="button"
        className={s.secondary}
        disabled={rules.length >= 100}
        onClick={() =>
          change([
            ...rules,
            { form: 'hidden', action: 'append', field: 'notes', clause: '', workContains: '', text: '' },
          ])
        }
      >
        Добавить правило
      </button>
    </section>
  );
}
