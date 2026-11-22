import { evaluateStandardRules, withHiddenWorks } from '../../shared/standard-rules.js';
import { baseForm } from './forms.js';
import { BadRequestException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  canSign,
  workTitle,
  numberOf,
  type Project,
  type Entry,
  type SavedProject,
} from '../../shared/construction.js';
import { renderForm } from './office.js';
import type { Asset } from './store.js';

const unique = <T>(items: T[]) => [...new Set(items)];
const join = (...items: (string | undefined)[]) => unique(items.filter((s): s is string => Boolean(s))).join('; ');
const label = (r: Entry) =>
  join(r.v.name, [r.v.docType, r.v.number, localDate(r.v.date)].filter(Boolean).join(' '));
const localDate = (s: string) => s?.replace(/^(\d{4})-(\d\d)-(\d\d)$/, '$3.$2.$1') || '';
const safe = (s: string) =>
  s
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+|[. ]+$/g, '')
    .slice(0, 120) || 'Документ';
type RegisterRow = {
  type: string;
  name: string;
  number: string;
  date: string;
  org: string;
  pages: string;
  file: string;
  act: string;
  key: string;
};
function sheet(book: ExcelJS.Workbook, name: string, head: string[], rows: string[][], widths: number[]) {
  const s = book.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1 }],
    pageSetup: {
      orientation: 'landscape',
      paperSize: 9,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '1:1',
    },
  });
  s.addRow(head);
  s.addRows(rows);
  s.columns.forEach((c, i) => {
    c.width = widths[i] || 20;
    c.alignment = { vertical: 'middle', wrapText: true };
  });
  const header = s.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF264F53' } };
  header.height = 30;
  s.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: head.length } };
}
const xlsx = async (b: ExcelJS.Workbook) => Buffer.from(await b.xlsx.writeBuffer());
function dates(v: Record<string, string>, suffix: string, date: string) {
  const [y, m, d] = (date || '').split('-');
  v['год_' + suffix] = y || '';
  v['месяц_' + suffix] =
    'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' ')[
      Number(m) - 1
    ] || '';
  v['день_' + suffix] = d || '';
}
function signerValues(p: Project, people: (Entry | undefined)[], v: Record<string, string>) {
  for (const [i, code] of ['ТНЗ', 'Г', 'ТНГ', 'Пд', 'Пр', 'И1', 'И2', 'И3'].entries()) {
    const signer = people[i]?.v || {};
    v['Должность_' + code] = join(
      [signer.position, signer.company, signer.name].filter(Boolean).join(' '),
      signer.authority,
      signer.nrs,
      signer.includeDetails === 'да' ? signer.details : '',
    );
    const [surname, ...names] = (signer.name || '').trim().split(/\s+/);
    v['ФИО_' + code] =
      p.v.shortNames === 'да' && names.length >= 2
        ? surname + ' ' + names.map((n) => n[0] + '.').join('')
        : signer.name || '';
  }
}
const incomingValues = (
  p: Project,
  num: string,
  date: string,
  materials: Entry[],
  fallback: Record<string, string>,
) => {
  const v: Record<string, string> = {
    номер_акта: num,
    наименование_объекта: join(p.v.object || p.v.name, p.v.address),
    шифр_рд2: join(...materials.map((r) => r.v.drawing)),
    таблица: materials.map(label).join('\n'),
  };
  for (const [i, c] of ['ТНЗ', 'П', 'СП'].entries()) {
    const src = ['ТНЗ', 'ТНГ', 'Пд'][i];
    v['Должность_' + c] = p.v['avkPosition' + i] || fallback['Должность_' + src] || '';
    v['ФИО_' + c] = v['ФИО_' + c + '2'] = p.v['avkName' + i] || fallback['ФИО_' + src] || '';
    v['дата' + (i + 1)] = date;
  }
  return v;
};
const table = (ms: Entry[]) =>
  ms.map((m, i) => [
    String(i + 1),
    m.v.name,
    m.v.quantity,
    m.v.unit,
    join(m.v.docType, m.v.number, localDate(m.v.date)),
    m.v.drawing,
  ]);

function verificationJournal(book: ExcelJS.Workbook, materials: Entry[]) {
  sheet(
    book,
    'ЖВЗП',
    [
      'Поступление',
      'Транспорт',
      'Поставщик',
      'Продукция',
      'Документ качества',
      'Упаковка',
      'Масса, партия, номер',
      'Изготовление',
      'Место отбора',
      'Дата отбора',
      'Заключение и подпись',
    ],
    materials.map((r) => [
      localDate(r.v.received),
      r.v.vehicle,
      r.v.issuer,
      r.v.name,
      label(r),
      r.v.packaging,
      r.v.batch || join(r.v.quantity, r.v.unit),
      r.v.manufactured,
      r.v.samplePlace,
      r.v.sampleDate,
      r.v.verdict,
    ]),
    [16, 20, 35, 48, 52, 15, 22, 18, 24, 18, 40],
  );
}
export async function report(
  p: SavedProject,
  phase: string,
  pack: string,
  selected: string[],
  asset: (id: string) => Promise<Asset>,
) {
  const byId = new Map(p.rows.map((r) => [r.id, r]));
  if (byId.get(phase)?.kind !== 'phase') throw new BadRequestException('Выберите фазу.');
  if (pack && (byId.get(pack)?.kind !== 'pack' || byId.get(pack)?.links.phase[0] !== phase))
    throw new BadRequestException('Выберите комплект этой фазы.');
  const linked = (r: Entry, k: string) => (r.links[k] || []).map((id) => byId.get(id)!);
  const selectedWorks = p.rows.filter(
    (r) =>
      r.kind === 'work' &&
      r.links.phase[0] === phase &&
      (!pack || r.links.pack?.includes(pack)) &&
      (!selected.length || selected.includes(r.id)),
  );
  if (!selectedWorks.length || selected.some((id) => !selectedWorks.some((w) => w.id === id)))
    throw new BadRequestException('В выбранном комплекте нет указанных работ.');
  // A structure act must travel with the hidden-work acts on which it relies.
  const works = withHiddenWorks(selectedWorks, byId);
  const requirements: string[][] = [];
  const zip = new JSZip(),
    book = new ExcelJS.Workbook(),
    register: RegisterRow[] = [],
    usedMaterials = new Set<Entry>();
  const originals = new Map<string, string>(),
    incomingFiles = new Map<string, string>(),
    templates = new Map<string, Buffer>();
  let bytes = 0;
  const add = (file: string, data: Buffer) => {
    bytes += data.length;
    if (bytes > 300 * 1024 * 1024)
      throw new BadRequestException('Комплект превышает 300 МБ. Разделите его на несколько комплектов.');
    zip.file(file, data);
  };
  const actTitle: Record<string, string> = {
    hidden: 'Акт освидетельствования скрытых работ',
    structure: 'Акт освидетельствования ответственных конструкций',
    incoming: 'Акт входного контроля',
  };
  const order = (p.v.order || 'Схемы, протоколы, материалы')
    .toLowerCase()
    .split(', ')
    .map((k) => ({ схемы: 'scheme', протоколы: 'protocol', материалы: 'material' })[k]);
  const avkTemplate = p.rows.find((r) => r.kind === 'template' && r.v.form === 'incoming');
  const org = (key: string) => join(p.v[key], p.v[key + 'Details']);
  for (const [index, w] of works.entries()) {
    const t = linked(w, 'template')[0],
      form = t.v.form,
      v = w.v,
      num = numberOf(p, w),
      name = workTitle(v),
      children = linked(w, 'children');
    if (!v.number?.trim() || !v.date)
      throw new BadRequestException('Заполните номер и дату акта «' + v.name + '».');
    if (t.v.needsFile === 'да' && !t.file) throw new BadRequestException('Загрузите форму «' + t.v.name + '».');
    const aggregate = (k: string) => unique([w, ...children].flatMap((r) => linked(r, k)));
    const materials = aggregate('materials'),
      schemes = aggregate('schemes'),
      protocols = aggregate('protocols');
    const prefix = String(index + 1).padStart(3, '0') + ' ' + safe(t.v.name + ' ' + num);
    const folder = 'Акты/' + prefix,
      actFile = folder + '/' + prefix + '.docx';
    register.push({
      type: t.v.name,
      name: (t.v.description || actTitle[form]) + '. ' + name,
      number: num,
      date: localDate(v.date),
      org: p.v.contractor || '',
      pages: v.pages || '',
      file: actFile,
      act: num,
      key: w.id,
    });
    for (const m of materials) usedMaterials.add(m);
    const attachments = [...schemes, ...protocols, ...materials].sort(
      (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
    );
    for (const r of attachments) {
      if (r.file && !originals.has(r.id)) {
        const file = await asset(r.id),
          filePath = 'Приложения/' + String(originals.size + 1).padStart(3, '0') + ' ' + safe(file.name);
        add(filePath, file.data);
        originals.set(r.id, filePath);
      }
      register.push({
        key: r.id,
        type:
          r.v.docType ||
          { scheme: 'Исполнительная схема', material: 'Документ качества', protocol: 'Протокол' }[
            r.kind as 'scheme'
          ],
        name: r.v.name,
        number: r.v.number || '',
        date: localDate(r.v.date),
        org: r.v.issuer || '',
        pages: r.v.pages || '',
        file: originals.get(r.id) || 'Оригинал не загружен',
        act: num,
      });
    }
    let matText = join(...materials.map(label)),
      docText = join(...[...schemes, ...protocols].map(label));
    const annex: string[] = [];
    for (const [key, items, title] of [
      ['Mat', materials, 'Реестр документов качества'],
      ['Docs', [...schemes, ...protocols], 'Реестр схем и протоколов'],
    ] as const) {
      if (items.length <= 5 || p.v[form + key] !== 'да') continue;
      const reference = 'Приложение №' + (annex.length + 1) + ' — ' + title,
        filename = folder + '/' + reference + '.xlsx',
        b = new ExcelJS.Workbook();
      sheet(
        b,
        'Реестр',
        ['№', 'Наименование', 'Документ', 'Номер', 'Дата', 'Листов'],
        items.map((r, i) => [String(i + 1), r.v.name, r.v.docType, r.v.number, localDate(r.v.date), r.v.pages]),
        [8, 65, 36, 34, 24, 10],
      );
      add(filename, await xlsx(b));
      annex.push(reference);
      if (key === 'Mat') matText = reference;
      else docText = reference;
      register.push({
        key: filename,
        type: 'Реестр',
        name: reference,
        number: '',
        date: localDate(v.date),
        org: p.v.contractor || '',
        pages: '',
        file: filename,
        act: num,
      });
    }
    const avks: string[] = [];
    const props: Record<string, string> = {};
    const people = Array.from({ length: 8 }, (_, i) => linked(w, 'signer' + i)[0]);
    const expired = people.find((person) => person && !canSign(person, v.date));
    if (expired)
      throw new BadRequestException('Проверьте срок полномочий ' + expired.v.name + ' на дату акта ' + num + '.');
    signerValues(p, people, props);
    if (p.v.includeAvk === 'да' && form !== 'incoming') {
      for (const number of unique(materials.map((r) => r.v.incoming).filter(Boolean))) {
        const desc = 'АВК №' + number,
          group = p.rows.filter((r) => r.kind === 'material' && r.v.incoming === number);
        if (!incomingFiles.has(number)) {
          const file = 'Входной контроль/' + (incomingFiles.size + 1) + ' ' + safe(desc) + '.docx';
          const date = localDate(
            group
              .map((r) => r.v.incomingDate || r.v.received)
              .filter(Boolean)
              .sort()
              .at(-1) || '',
          );
          if (avkTemplate && !templates.has(avkTemplate.id))
            templates.set(
              avkTemplate.id,
              avkTemplate.file ? (await asset(avkTemplate.id)).data : await baseForm('incoming'),
            );
          add(
            file,
            await renderForm(
              avkTemplate ? templates.get(avkTemplate.id)! : await baseForm('incoming'),
              incomingValues(p, number, date, group, props),
              table(group),
            ),
          );
          incomingFiles.set(number, file);
        }
        avks.push(desc);
        register.push({
          key: 'avk:' + number,
          type: 'АВК',
          name: desc,
          number,
          date: '',
          org: p.v.contractor || '',
          pages: '',
          file: incomingFiles.get(number)!,
          act: num,
        });
      }
    }
    const design = join(...[w, ...children].map((r) => r.v.design));
    const compliance = join(
      ...[w, ...children].flatMap((r) => [
        r.v.compliance,
        ...linked(r, 'standards').map((s) => [s.v.name, s.v.description].filter(Boolean).join(' ')),
      ]),
    );
    const files = join(matText, docText, ...avks, v.manual);
    Object.assign(props, {
      Номер_акта: num,
      Наименование_объекта: join(p.v.object || p.v.name, p.v.address),
      реквизиты_заказчика: org('customer'),
      реквизиты_генподрядчика: org('builder'),
      реквизиты_проектировщика: org('designer'),
      реквизиты_подрядчика: org('contractor'),
      н_исполнителя: org('contractor'),
      Наименование_работ: name,
      Наименование_последующих_работ: v.next || '',
      Наим_пр_докум: design,
      Наименование_материалов: join(...avks, matText),
      Исполнительные_схемы: docText,
      выполнено_с: compliance,
      Доп_сведения: v.notes || '',
      экз: v.copies || '',
      приложения: files,
      Проекты_АОСР: design,
      Акты_ОСР: join(
        ...children.map((r) => numberOf(p, r) + ' от ' + localDate(r.v.date) + ' · ' + workTitle(r.v)),
      ),
      Материалы_АОСР: matText,
      Исполнительные_схемы_АОСР: annex.includes(docText) ? docText : join(...schemes.map(label)),
      Протоколы_АОСР: annex.includes(docText)
        ? docText
        : join(...unique(children.flatMap((r) => linked(r, 'protocols'))).map(label)),
      Протоколы_АООК: join(...linked(w, 'protocols').map(label)),
      Выполнено_с_АОСР: compliance,
      по_назначению: v.use === 'да' ? ' ' : '',
      нагрузка: v.load || '',
      условия: v.loadTerms || '',
      Приложения_АООК: files,
    });
    dates(props, 'а', v.date);
    dates(
      props,
      'н',
      v.start ||
        children
          .map((c) => c.v.start)
          .filter(Boolean)
          .sort()[0],
    );
    dates(
      props,
      'о',
      v.end ||
        children
          .map((c) => c.v.end)
          .filter(Boolean)
          .sort()
          .at(-1) ||
        '',
    );
    if (form === 'incoming')
      Object.assign(props, incomingValues(p, v.number, localDate(v.date), materials, props));
    const { changes, checks, conflicts } = evaluateStandardRules(w, byId);
    if (conflicts.length)
      throw new BadRequestException(
        'Акт ' + num + ' · разные замены поля «' + conflicts.join(', ') + '». Проверьте правила нормативов.',
      );
    for (const [key, change] of changes) {
      props[key] = [
        ...new Set([change.replacements.values().next().value ?? props[key], ...change.additions].filter(Boolean)),
      ].join('\n');
    }
    requirements.push(...checks.map((check) => [num, name, check.basis, check.document, check.status]));
    if (!templates.has(t.id)) templates.set(t.id, t.file ? (await asset(t.id)).data : await baseForm(form));
    add(
      actFile,
      await renderForm(templates.get(t.id)!, props, table(materials), form === 'structure', [...changes.keys()]),
    );
  }
  const head = ['№', 'Вид', 'Наименование', 'Номер', 'Дата', 'Организация', 'Листов', 'Файл в комплекте', 'Акт'];
  const registerRows = (rs: RegisterRow[]) =>
    rs.map((r, i) => [String(i + 1), r.type, r.name, r.number, r.date, r.org, r.pages, r.file, r.act]);
  const packName = byId.get(pack)?.v;
  sheet(
    book,
    'Комплект',
    ['Реестр исполнительной документации', 'Сведения о комплекте'],
    [
      ['Проект', p.v.name],
      ['Объект', p.v.object || p.v.name],
      ['Адрес', p.v.address],
      ['Фаза', byId.get(phase)!.v.name],
      ['Комплект', packName?.name || 'Все работы фазы'],
      ['Номер комплекта', packName?.number || ''],
      ['Застройщик', org('customer')],
      ['Генподрядчик', org('builder')],
      ['Проектировщик', org('designer')],
      ['Исполнитель', org('contractor')],
    ],
    [38, 96],
  );
  sheet(book, 'По актам', head, registerRows(register), [7, 24, 70, 26, 21, 32, 10, 54, 22]);
  const groups = new Map<string, RegisterRow>();
  for (const r of register) {
    const prior = groups.get(r.key);
    if (prior) prior.act = join(prior.act, r.act);
    else groups.set(r.key, { ...r });
  }
  sheet(
    book,
    'По типам',
    head,
    registerRows([...groups.values()].sort((a, b) => a.type.localeCompare(b.type, 'ru'))),
    [7, 24, 70, 26, 21, 32, 10, 54, 22],
  );
  sheet(
    book,
    'Общий журнал',
    ['Начало', 'Окончание', 'Выполненные работы', 'Объём', 'Ед. изм.', 'Акт'],
    works.map((r) => [
      localDate(r.v.start),
      localDate(r.v.end),
      workTitle(r.v),
      r.v.quantity,
      r.v.unit,
      numberOf(p, r),
    ]),
    [16, 16, 85, 14, 12, 24],
  );
  if (requirements.length)
    sheet(
      book,
      'Проверка приложений',
      ['Акт', 'Работа', 'Основание', 'Требуется', 'Состояние'],
      requirements,
      [22, 55, 40, 48, 55],
    );
  verificationJournal(book, [...usedMaterials]);
  const filename = safe(join(p.v.name, byId.get(phase)!.v.name, packName?.name, packName?.number));
  add('Реестр ' + filename + '.xlsx', await xlsx(book));
  return {
    name: filename + '.zip',
    data: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  };
}

export async function incomingReport(p: SavedProject, templateId: string, asset: (id: string) => Promise<Asset>) {
  const template = p.rows.find((r) => r.kind === 'template' && r.id === templateId && r.v.form === 'incoming');
  if (!template) throw new BadRequestException('Выберите шаблон АВК.');
  const data = template.file ? (await asset(template.id)).data : await baseForm('incoming');
  const materials = p.rows.filter((r) => r.kind === 'material');
  if (!materials.length) throw new BadRequestException('В проекте пока нет материалов.');
  const groups = new Map<string, Entry[]>(),
    zip = new JSZip(),
    book = new ExcelJS.Workbook();
  for (const row of materials) {
    if (row.v.incoming) groups.set(row.v.incoming, [...(groups.get(row.v.incoming) || []), row]);
  }
  const index: string[][] = [];
  let total = 0;
  for (const [number, rows] of groups) {
    const date = localDate(
      rows
        .map((r) => r.v.incomingDate || r.v.received)
        .filter(Boolean)
        .sort()
        .at(-1) || '',
    );
    const path = 'АВК/' + (index.length + 1) + ' ' + safe(number) + '.docx';
    const bytes = await renderForm(data, incomingValues(p, number, date, rows, {}), table(rows));
    total += bytes.length;
    if (total > 300 * 1024 * 1024) throw new BadRequestException('Объём актов превышает 300 МБ.');
    zip.file(path, bytes);
    index.push([number, date, join(...rows.map((r) => r.v.name)), path]);
  }
  sheet(book, 'Реестр АВК', ['Номер АВК', 'Дата', 'Материалы', 'Файл'], index, [24, 18, 70, 46]);
  verificationJournal(book, materials);
  zip.file('Входной контроль.xlsx', await xlsx(book));
  return {
    name: 'Входной контроль ' + safe(p.v.name) + '.zip',
    data: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  };
}
