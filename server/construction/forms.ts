import JSZip from 'jszip';
import { roles } from '../../shared/construction.js';

// Independent blank forms. Uploaded project-specific Word layouts use the same bookmark contract.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const titles: Record<string, string> = {
  hidden: 'Акт освидетельствования скрытых работ',
  structure: 'Акт освидетельствования ответственных конструкций',
  incoming: 'Акт результатов входного контроля материалов и оборудования',
};
const cache = new Map<string, Promise<Buffer>>();
export function baseForm(form: string) {
  if (!Object.hasOwn(titles, form)) throw Error('Unknown form type');
  if (!cache.has(form)) cache.set(form, build(form));
  return cache.get(form)!;
}
async function build(form: string) {
  let seq = 0;
  const run = (text: string, bold = false, size = 22) =>
    '<w:r><w:rPr>' +
    (bold ? '<w:b/>' : '') +
    '<w:sz w:val="' +
    size +
    '"/></w:rPr><w:t xml:space="preserve">' +
    text +
    '</w:t></w:r>';
  const mark = (name: string) => {
    const id = ++seq;
    return (
      '<w:bookmarkStart w:id="' +
      id +
      '" w:name="' +
      name +
      '"/>' +
      run(name) +
      '<w:bookmarkEnd w:id="' +
      id +
      '"/>'
    );
  };
  const p = (content: string, keep = false) =>
    '<w:p><w:pPr>' + (keep ? '<w:keepNext/>' : '') + '<w:spacing w:after="65"/></w:pPr>' + content + '</w:p>';
  const field = (label: string, key: string) => p(run(label + '　', true) + mark(key));
  const simpleTable = (rows: string[][]) =>
    '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((edge) => '<w:' + edge + ' w:val="single" w:sz="4" w:color="C1CBC5"/>')
      .join('') +
    '</w:tblBorders></w:tblPr><w:tblGrid>' +
    rows[0].map(() => '<w:gridCol w:w="' + Math.floor(9300 / rows[0].length) + '"/>').join('') +
    '</w:tblGrid>' +
    rows
      .map(
        (row) =>
          '<w:tr>' +
          row
            .map(
              (cell) =>
                '<w:tc><w:tcPr><w:tcW w:type="pct" w:w="' +
                Math.floor(5000 / row.length) +
                '"/></w:tcPr>' +
                cell +
                '</w:tc>',
            )
            .join('') +
          '</w:tr>',
      )
      .join('') +
    '</w:tbl>';
  const optional = (content: string) => simpleTable([[content]]);
  const body = [p(run(titles[form], true, 30), true)];
  if (form === 'incoming') {
    body.push(
      field('Номер акта', 'номер_акта'),
      field('Объект', 'наименование_объекта'),
      p(run('Комиссия', true), true),
    );
    ['ТНЗ', 'П', 'СП'].forEach((key, i) =>
      body.push(
        p(
          run(
            [
              'Строительный контроль заказчика',
              'Строительный контроль подрядчика',
              'Строительный контроль субподрядчика',
            ][i] + ': ',
          ) +
            mark('Должность_' + key) +
            run('　') +
            mark('ФИО_' + key + '2'),
        ),
      ),
    );
    body.push(
      p(run('Ведомость материалов и оборудования', true), true),
      simpleTable([
        ['№', 'Материал', 'Объём', 'Ед. изм.', 'Документ качества', 'Шифр РД'].map((h) => p(run(h, true, 19))),
      ]),
      p(mark('таблица')),
      field('Рабочая документация', 'шифр_рд2'),
      p(run('Выявленные отклонения и заключение комиссии: __________________________________________')),
      p(run('Подписи комиссии', true), true),
    );
    ['ТНЗ', 'П', 'СП'].forEach((key, i) =>
      body.push(p(run('________________　') + mark('ФИО_' + key) + run('　') + mark('дата' + (i + 1)))),
    );
  } else {
    const date = (suffix: string) =>
      mark('день_' + suffix) + run(' ') + mark('месяц_' + suffix) + run(' ') + mark('год_' + suffix) + run(' г.');
    body.push(
      p(run('Номер　') + mark('Номер_акта') + run('　　 Дата　') + date('а')),
      field('Объект капитального строительства', 'Наименование_объекта'),
      field('Застройщик или технический заказчик', 'реквизиты_заказчика'),
      field('Лицо, осуществляющее строительство', 'реквизиты_генподрядчика'),
      field('Лицо, подготовившее проектную документацию', 'реквизиты_проектировщика'),
      field('Лицо, выполнившее работы', 'н_исполнителя'),
      p(run('Представители сторон', true, 24), true),
    );
    const codes = ['ТНЗ', 'Г', 'ТНГ', 'Пд', 'Пр', 'И1', 'И2', 'И3'];
    codes.forEach((c, i) => body.push(optional(field(roles[i], 'Должность_' + c))));
    body.push(
      field('К освидетельствованию предъявлены', 'Наименование_работ'),
      field('Проектная и рабочая документация', form === 'structure' ? 'Проекты_АОСР' : 'Наим_пр_докум'),
    );
    if (form === 'structure')
      body.push(
        field('Акты освидетельствования скрытых работ', 'Акты_ОСР'),
        field('Применённые материалы', 'Материалы_АОСР'),
        field('Исполнительные схемы', 'Исполнительные_схемы_АОСР'),
        field('Протоколы скрытых работ', 'Протоколы_АОСР'),
        field('Результаты испытаний конструкций', 'Протоколы_АООК'),
      );
    else
      body.push(
        field('Применённые материалы и документы качества', 'Наименование_материалов'),
        field('Документы, подтверждающие соответствие работ', 'Исполнительные_схемы'),
      );
    body.push(
      p(run('Начало работ　', true) + date('н') + run('　　 Окончание　', true) + date('о')),
      field('Работы выполнены в соответствии с', form === 'structure' ? 'Выполнено_с_АОСР' : 'выполнено_с'),
    );
    if (form === 'structure')
      body.push(
        optional(p(run('Разрешается использование конструкций по назначению.') + mark('по_назначению'))),
        optional(field('Нагрузка от проектной, %', 'нагрузка')),
        optional(field('Условия полного нагружения', 'условия')),
      );
    body.push(
      optional(field('Последующие работы', 'Наименование_последующих_работ')),
      field('Дополнительные сведения', 'Доп_сведения'),
      field('Приложения', form === 'structure' ? 'Приложения_АООК' : 'приложения'),
      field('Количество экземпляров', 'экз'),
      p(run('Подписи представителей', true, 24), true),
    );
    codes.forEach((c, i) => body.push(optional(p(run(roles[i] + '　________________　') + mark('ФИО_' + c)))));
  }
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="' +
      W +
      '"><w:body>' +
      body.join('') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1080" w:bottom="1080" w:left="1360" w:right="1080"/></w:sectPr></w:body></w:document>',
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
