import { z } from 'zod';
import { ruleSchema, bookmark } from './standard-rules.js';

export const kinds = [
  'pack',
  'work',
  'person',
  'material',
  'scheme',
  'protocol',
  'attachment',
  'standard',
  'template',
] as const;
export type Kind = (typeof kinds)[number];
export const labels: Record<Kind, string> = {
  pack: 'Комплекты',
  work: 'Акты и работы',
  person: 'Ответственные лица',
  material: 'Материалы и сертификаты',
  scheme: 'Исполнительные схемы',
  protocol: 'Протоколы и акты контроля',
  attachment: 'Реестры и приложения',
  standard: 'Нормативы',
  template: 'Шаблоны актов',
};
export const acceptsOriginal = (kind: Kind) => ['work', 'material', 'protocol', 'scheme', 'attachment', 'template'].includes(kind);
export const formTypes = { hidden: 'АОСР', structure: 'АООК', incoming: 'АВК' } as const;
export const roles = [
  'СК Заказчика',
  'Генподрядчик',
  'СК Генподрядчика',
  'Подрядчик',
  'Авторский надзор',
  'Иное лицо 1',
  'Иное лицо 2',
  'Иное лицо 3',
];
export type Field = {
  key: string;
  label: string;
  type?: 'date' | 'long' | 'choice' | 'link';
  options?: readonly string[];
  target?: Kind;
  many?: boolean;
  required?: boolean;
};
const f = (key: string, label: string, type?: Field['type']): Field => ({ key, label, type });
const choice = (key: string, label: string, options: readonly string[]): Field => ({
  key,
  label,
  options,
  type: 'choice',
});
const link = (key: string, label: string, target: Kind, many = false, required = false): Field => ({
  key,
  label,
  target,
  many,
  required,
  type: 'link',
});
const title = (label: string): Field => ({ key: 'name', label, required: true });
const documentFields = [
  f('docType', 'Вид документа'),
  f('number', 'Номер документа'),
  f('date', 'Дата или срок действия'),
  f('issuer', 'Организация'),
  f('pages', 'Число листов'),
];
const attachmentLinks = [
  link('materials', 'Материалы и документы качества', 'material', true),
  link('schemes', 'Схемы', 'scheme', true),
  link('protocols', 'Испытания и обследования', 'protocol', true),
  link('attachments', 'Реестры и прочие приложения', 'attachment', true),
];
export const fields: Record<Kind, Field[]> = {
  pack: [title('Название комплекта'), f('number', 'Номер комплекта'), ...attachmentLinks],
  person: [
    title('Фамилия, имя, отчество'),
    choice('role', 'Представитель', [...roles, 'Иное лицо']),
    f('position', 'Должность'),
    f('company', 'Организация'),
    f('authority', 'Приказ или доверенность'),
    f('nrs', 'Номер специалиста в НРС'),
    f('start', 'Начало полномочий', 'date'),
    f('end', 'Окончание полномочий', 'date'),
    f('details', 'Реквизиты организации', 'long'),
    choice('includeDetails', 'Печатать реквизиты', ['да', 'нет']),
  ],
  material: [
    title('Наименование материала'),
    f('category', 'Категория'),
    ...documentFields,
    f('received', 'Дата поступления', 'date'),
    f('quantity', 'Количество'),
    f('unit', 'Единица измерения'),
    f('incoming', 'Номер АВК'),
    f('incomingDate', 'Дата АВК', 'date'),
    f('vehicle', 'Вагон или автомашина'),
    f('manufactured', 'Дата изготовления'),
    f('samplePlace', 'Место отбора пробы'),
    f('sampleDate', 'Дата отбора пробы'),
    f('packaging', 'Упаковка'),
    f('batch', 'Масса, партия, номер'),
    f('drawing', 'Шифр РД'),
    f('verdict', 'Заключение о качестве'),
  ],
  scheme: [title('Наименование схемы'), ...documentFields],
  attachment: [title('Наименование документа'), ...documentFields],
  protocol: [title('Наименование протокола'), ...documentFields],
  standard: [title('Обозначение'), f('description', 'Название норматива', 'long')],
  template: [
    title('Название шаблона'),
    f('description', 'Полное название акта'),
    choice('form', 'Вид акта', Object.keys(formTypes)),
  ],
  work: [
    f('name', 'Выполненные работы'),
    link('pack', 'Комплекты ИД', 'pack', true, true),
    link('template', 'Шаблон акта', 'template'),
    f('number', 'Номер акта'),
    f('suffix', 'Суффикс'),
    f('start', 'Начало работ', 'date'),
    f('end', 'Окончание работ', 'date'),
    f('date', 'Дата акта', 'date'),
    f('conditions', 'Условия производства'),
    f('quantity', 'Объём'),
    f('unit', 'Единица измерения'),
    f('level1', 'Уровень 1'),
    f('level2', 'Уровень 2'),
    f('level3', 'Уровень 3'),
    f('elevation', 'Отметка'),
    f('axes', 'В осях'),
    f('next', 'Последующие работы', 'long'),
    ...roles.map((role, i) => link('signer' + i, 'Подпись · ' + role, 'person')),
    ...attachmentLinks,
    link('children', 'Освидетельствованные скрытые работы', 'work', true),
    f('design', 'Проектная и рабочая документация', 'long'),
    link('standards', 'Своды правил', 'standard', true),
    f('compliance', 'Другие нормативные документы', 'long'),
    f('manual', 'Дополнительные приложения', 'long'),
    f('copies', 'Количество экземпляров'),
    f('pages', 'Листов в акте'),
    f('notes', 'Дополнительные сведения', 'long'),
    choice('use', 'Использование по назначению', ['да', 'нет']),
    f('load', 'Нагрузка от проектной, %'),
    f('loadTerms', 'Условия полного нагружения', 'long'),
  ],
};
export const projectFields: Field[] = [
  title('Название проекта'),
  f('object', 'Объект капитального строительства', 'long'),
  f('address', 'Адрес объекта'),
  ...[
    ['customer', 'Застройщик'],
    ['builder', 'Генподрядчик'],
    ['designer', 'Проектировщик'],
    ['contractor', 'Исполнитель'],
  ].flatMap(([key, label]) => [f(key, label), f(key + 'Details', 'Реквизиты · ' + label, 'long')]),
  ...['Заказчик', 'Подрядчик', 'Субподрядчик'].flatMap((role, i) => [
    f('avkPosition' + i, 'АВК · ' + role + ' · должность и организация'),
    f('avkName' + i, 'АВК · ' + role + ' · ФИО'),
  ]),
  f('mask', 'Маска номера ({номер}, {id}, {тип}, {суффикс}, {уровень1}, {уровень2}, {уровень3})'),
  choice('shortNames', 'Краткие ФИО в подписях', ['да', 'нет']),
  choice('includeAvk', 'Включать АВК материалов', ['да', 'нет']),
  ...[
    ['hiddenMat', 'АОСР · материалы'],
    ['hiddenDocs', 'АОСР · схемы и протоколы'],
    ['structureMat', 'АООК · материалы'],
    ['structureDocs', 'АООК · схемы и протоколы'],
  ].map(([key, label]) => choice(key, 'Отдельный реестр при более 5 позициях · ' + label, ['да', 'нет'])),
  choice('order', 'Порядок приложений', [
    'Схемы, протоколы, материалы',
    'Схемы, материалы, протоколы',
    'Протоколы, схемы, материалы',
    'Протоколы, материалы, схемы',
    'Материалы, схемы, протоколы',
    'Материалы, протоколы, схемы',
  ]),
];
const valuesSchema = z.record(z.string().max(40), z.string().max(32000));
export const rowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(kinds),
  v: valuesSchema,
  links: z.record(z.string(), z.array(z.uuid()).max(5000)),
  file: z.string().max(200).optional(),
  rules: z.array(ruleSchema).max(100).optional(),
});
export type Entry = z.infer<typeof rowSchema>;
export const projectSchema = z.object({ v: valuesSchema, rows: z.array(rowSchema).max(15000) });
export type Project = z.infer<typeof projectSchema>;
export interface SavedProject extends Project {
  id: string;
  version: number;
}
export type ProjectSummary = { id: string; name: string; packs: number; works: number };
export function entry(kind: Kind, v: Record<string, string>, links: Entry['links'] = {}): Entry {
  // Web Crypto randomUUID requires HTTPS. getRandomValues also works on a local HTTP preview.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return { id: hex.replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5'), kind, v, links };
}
// The workbook stores the catalogue caption in a semicolon-separated list.
export function matchStandardText(raw: string, rows: Entry[]) {
  const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
  const candidates = new Map<string, string | null>();
  for (const row of rows) {
    if (row.kind !== 'standard') continue;
    const key = normalize([row.v.name, row.v.description].filter(Boolean).join(' '));
    candidates.set(key, candidates.has(key) ? null : row.id);
  }
  const ids = new Set<string>();
  const remaining = raw.split(';').filter((part) => {
    const id = candidates.get(normalize(part));
    if (!id) return true;
    ids.add(id);
    return false;
  });
  return { ids: [...ids], remaining: ids.size ? remaining.join(';').trim() : raw };
}
export const workTitle = (v: Entry['v']) =>
  [
    v.name,
    v.conditions,
    v.level1,
    v.level2,
    v.level3,
    v.elevation,
    v.axes,
    v.quantity && '(' + [v.quantity, v.unit].filter(Boolean).join(' ') + ')',
  ]
    .filter(Boolean)
    .join(' ');
export const numberOf = (p: Project, w: Entry) =>
  (p.v.mask || '{номер}').replace(
    /\{(номер|id|тип|суффикс|уровень1|уровень2|уровень3)\}/g,
    (_, k: string) =>
      ({
        id: w.v.sourceId || String(p.rows.filter((r) => r.kind === 'work').findIndex((r) => r.id === w.id) + 1),
        номер: w.v.number,
        тип: p.rows.find((r) => r.id === w.links.template?.[0])?.v.name,
        суффикс: w.v.suffix,
        уровень1: w.v.level1,
        уровень2: w.v.level2,
        уровень3: w.v.level3,
      })[k] || '',
  );
export function validateProject(p: Project): string | undefined {
  if (!p.v.name?.trim()) return 'Укажите название проекта.';
  const byId = new Map(p.rows.map((r) => [r.id, r]));
  if (byId.size !== p.rows.length) return 'Повторяющийся идентификатор записи.';
  for (const row of p.rows) {
    const spec = fields[row.kind],
      prefix = (row.v.name || labels[row.kind]) + ': ';
    if (row.rules?.length) {
      if (row.kind !== 'standard') return prefix + 'правила доступны в карточке норматива.';
      for (const rule of row.rules) {
        if (rule.action !== 'require' && (!bookmark(rule.field, rule.form) || !rule.text.trim()))
          return prefix + 'выберите доступное поле и укажите текст правила.';
      }
    }
    if (Object.keys(row.links).some((k) => !spec.some((f) => f.type === 'link' && f.key === k)))
      return prefix + 'неизвестная связь.';
    for (const field of spec) {
      const selected = row.links[field.key] || [],
        value = row.v[field.key];
      if (field.required && !(field.type === 'link' ? selected.length : value?.trim()))
        return prefix + 'заполните «' + field.label + '».';
      if (field.type === 'choice' && value && !field.options?.includes(value))
        return prefix + 'проверьте «' + field.label + '».';
      if (
        field.type === 'link' &&
        ((!field.many && selected.length > 1) ||
          new Set(selected).size !== selected.length ||
          selected.some((id) => byId.get(id)?.kind !== field.target))
      )
        return prefix + 'связь используется или недоступна · ' + field.label;
    }
    if (row.kind === 'template' && !Object.hasOwn(formTypes, row.v.form)) return prefix + 'выберите вид акта.';
    if (row.kind === 'work') {
      const form = (work: Entry) => byId.get(work.links.template?.[0])?.v.form;
      if (
        row.links.children?.length &&
        (form(row) !== 'structure' ||
          row.links.children.some((id) => {
            const child = byId.get(id)!;
            return form(child) !== 'hidden';
          }))
      )
        return prefix + 'для АООК выберите АОСР проекта.';
      if (row.v.start && row.v.end && row.v.start > row.v.end) return prefix + 'окончание раньше начала работ.';
    }
  }
}

export function canSign(person: Entry, date: string) {
  return !date || ((!person.v.start || person.v.start <= date) && (!person.v.end || person.v.end >= date));
}
