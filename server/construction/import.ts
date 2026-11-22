import ExcelJS from 'exceljs';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { BadRequestException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { entry, formTypes, matchStandardText, type Entry, type Kind, type Project } from '../../shared/construction.js';
import { openOfficeZip } from './office.js';

export const formsDir = path.resolve('server/construction/forms');
export async function newProject(name: string, phaseName: string, withStandards = true): Promise<Project> {
  const standards: [string, string][] = withStandards
    ? JSON.parse(await readFile(path.join(formsDir, 'standards.json'), 'utf8'))
    : [];
  return {
    v: {
      name,
      mask: '№{номер}{суффикс}',
      shortNames: 'да',
      hiddenMat: 'да',
      hiddenDocs: 'да',
      structureMat: 'да',
      structureDocs: 'да',
      includeAvk: 'нет',
      order: 'Схемы, протоколы, материалы',
    },
    rows: [
      entry('phase', { name: phaseName }),
      ...Object.entries(formTypes).map(([form, name]) => entry('template', { name, form })),
      ...standards.map(([name, description]) => entry('standard', { name, description })),
    ],
  };
}
function text(cell: ExcelJS.Cell): string {
  let value = cell.value;
  if (value && typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) value = value.result ?? null;
    else if ('richText' in value)
      return value.richText
        .map((t) => t.text)
        .join('')
        .trim();
  }
  if (value instanceof Date) return value.getUTCFullYear() > 1900 ? value.toISOString().slice(0, 10) : '';
  return value == null || typeof value === 'object'
    ? ''
    : String(value)
        .replace(/_x000D_/gi, '')
        .trim();
}
export async function readImportWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const part = 'xl/workbook.xml';
  const zip = await openOfficeZip(buffer, part);
  try {
    const xml = await zip.file(part)!.async('string');
    const document = new DOMParser().parseFromString(xml, 'application/xml');
    const root = document.documentElement;
    if (!root || root.localName !== 'workbook') throw Error('Invalid workbook');
    const names = Array.from(root.getElementsByTagNameNS(root.namespaceURI, 'definedNames'));
    // ExcelJS materializes every address in each named range. Import uses cell values
    // and cached formula results, so even a whole-column filter needs no name index.
    if (names.length) {
      for (const node of names) node.parentNode!.removeChild(node);
      zip.file(part, new XMLSerializer().serializeToString(document));
      buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    }
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(buffer as unknown as Parameters<typeof book.xlsx.load>[0], {
      ignoreNodes: ['dataValidations'],
    });
    return book;
  } catch {
    throw new BadRequestException('Не удалось прочитать книгу Excel.');
  }
}

export async function importBook(buffer: Buffer, phaseName: string) {
  const book = await readImportWorkbook(buffer);
  const sheet = (name: string) => {
    const found = book.getWorksheet(name);
    if (!found) throw new BadRequestException('В книге отсутствует лист «' + name + '».');
    return found;
  };
  const req = sheet('Реквизиты'),
    setting = sheet('Настройки'),
    rv = (n: number) => text(req.getCell('B' + n));
  const p = await newProject(rv(4) || 'Импортированный проект', phaseName, false),
    phase = p.rows[0].id,
    warnings = new Set<string>();
  p.v.object = rv(4);
  p.v.address = rv(5);
  for (const [i, k] of ['customer', 'builder', 'designer', 'contractor'].entries()) {
    p.v[k] = rv(8 + i * 4);
    p.v[k + 'Details'] = rv(9 + i * 4);
  }
  for (let i = 0; i < 3; i++) {
    p.v['avkPosition' + i] = rv(27 + i * 4);
    p.v['avkName' + i] = rv(28 + i * 4);
  }
  for (const [k, cell] of Object.entries({
    shortNames: 'B23',
    includeAvk: 'B14',
    hiddenMat: 'D10',
    hiddenDocs: 'D11',
    structureMat: 'B20',
    structureDocs: 'B17',
  }))
    p.v[k] = text(setting.getCell(cell));
  const masks: Record<string, string> = {
    id: '{id}',
    'Номер акта': '{номер}',
    Тип: '{тип}',
    'Суффикс акта': '{суффикс}',
    Уровень1: '{уровень1}',
    Уровень2: '{уровень2}',
    Уровень3: '{уровень3}',
  };
  p.v.mask =
    Array.from({ length: 13 }, (_, i) => text(setting.getCell(7, i + 2)))
      .map((t) => masks[t] ?? t)
      .join('') || '{номер}';
  const order = [27, 28, 29]
    .sort((a, b) => Number(text(setting.getCell(a, 2))) - Number(text(setting.getCell(b, 2))))
    .map((r) => text(setting.getCell(r, 3)).toLowerCase())
    .map((s) => (s.includes('схем') ? 'схемы' : s.includes('протокол') ? 'протоколы' : 'материалы'))
    .join(', ');
  p.v.order = order.charAt(0).toUpperCase() + order.slice(1);
  const source = new Map<string, Entry[]>();
  function add(kind: Kind, id: string, v: Entry['v'], links: Entry['links'] = {}) {
    const r = entry(kind, v, links);
    p.rows.push(r);
    const k = kind + ':' + id;
    source.set(k, [...(source.get(k) || []), r]);
    return r;
  }
  function records(sn: string, first: number, callback: (get: (col: number) => string) => void) {
    sheet(sn).eachRow((row, n) => {
      if (n >= first) callback((c) => text(row.getCell(c)));
    });
  }
  const values = (get: (c: number) => string, keys: string[], first: number) =>
    Object.fromEntries(keys.map((k, i) => [k, get(first + i)]).filter(([k, v]) => k && v));
  records('Настройки', 34, (g) => {
    const name = g(2);
    if (!name) return;
    const known = p.rows.find((r) => r.kind === 'template' && r.v.name === name);
    if (known) known.v.description = g(3);
    else
      add('template', name, {
        name,
        description: g(3),
        form: name.includes('АООК') ? 'structure' : name.includes('АВК') ? 'incoming' : 'hidden',
        needsFile: 'да',
      });
  });
  records('Люди', 4, (g) => {
    if (g(3))
      add(
        'person',
        g(1),
        values(
          g,
          ['role', 'name', 'position', 'company', 'authority', 'nrs', 'start', 'end', 'includeDetails', 'details'],
          2,
        ),
      );
  });
  records('Материалы', 4, (g) => {
    if (g(3))
      add(
        'material',
        g(1),
        values(
          g,
          [
            'category',
            'name',
            'received',
            'quantity',
            'unit',
            'docType',
            'number',
            'date',
            'pages',
            'incoming',
            'issuer',
            'vehicle',
            'manufactured',
            'samplePlace',
            'sampleDate',
            'packaging',
            'drawing',
          ],
          2,
        ),
      );
  });
  for (const [sn, kind] of [
    ['Исп. схемы', 'scheme'],
    ['Протоколы', 'protocol'],
  ] as const)
    records(sn, 3, (g) => {
      if (!g(2) && !g(4)) return;
      add(kind, g(1), {
        ...values(
          g,
          [
            'docType',
            'number',
            'name',
            'date',
            ...(kind === 'scheme' ? ['pages', 'issuer'] : ['issuer', 'pages']),
          ],
          2,
        ),
        name: g(4) || g(2),
      });
    });
  records('СП', 5, (g) => {
    if (g(1)) add('standard', g(1), { name: g(1), description: g(2) });
  });
  const pack = (id: string, name?: string, num?: string) =>
    source.get('pack:' + id)?.[0] ??
    add('pack', id, { name: name || 'Комплект ' + id, number: num || id }, { phase: [phase] });
  records('ИД', 5, (g) => {
    if (g(1) && (g(2) || g(3))) pack(g(1), g(2), g(3));
  });
  function resolve(kind: Kind, raw: string) {
    const ids: string[] = [];
    for (const m of raw.matchAll(/\[([^\]]+)\][ _]*([^;\n]*)/g)) {
      const candidates = source.get(kind + ':' + m[1]) || [];
      const found =
        candidates.find((r) => r.v.name === m[2].trim()) ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (found) ids.push(found.id);
      else warnings.add('Проверьте ссылку ' + m[0]);
    }
    return [...new Set(ids)];
  }
  const parents: [Entry, string][] = [];
  records('Акты', 4, (g) => {
    if (!g(5)) return;
    let tpl = p.rows.find((r) => r.kind === 'template' && r.v.name === g(3));
    if (!tpl) {
      tpl = add('template', g(3), {
        name: g(3) || 'АОСР',
        form: g(3).includes('АООК') ? 'structure' : 'hidden',
        needsFile: 'да',
      });
    }
    if (tpl.v.needsFile === 'да') warnings.add('Загрузите DOCX для шаблона «' + tpl.v.name + '».');
    const v = {
      sourceId: g(1),
      ...values(
        g,
        [
          'number',
          '',
          'suffix',
          'name',
          'conditions',
          'quantity',
          'unit',
          'level1',
          'level2',
          'level3',
          'elevation',
          'axes',
        ],
        2,
      ),
      ...values(g, ['start', 'end', 'date'], 20),
      ...values(g, ['design', 'compliance', '', 'manual', 'copies', 'notes', 'use', 'load', 'loadTerms'], 33),
      next: g(16),
    };
    const matched = matchStandardText(g(34), p.rows);
    const links = {
      standards: matched.ids,
      phase: [phase],
      template: [tpl.id],
      pack: g(17)
        .split(/[,;\s]+/)
        .filter(Boolean)
        .map((id) => pack(id).id),
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['signer' + i, resolve('person', g(i + 23))])),
      materials: resolve('material', g(31)),
      schemes: resolve('scheme', g(32)),
      protocols: resolve('protocol', g(35)),
    };
    const work = add('work', g(1), { ...v, compliance: matched.remaining }, links);
    if (g(18)) parents.push([work, g(18)]);
  });
  for (const [parent, raw] of parents) {
    parent.links.children = [];
    for (const key of raw.split(/[,;\s]+/).filter(Boolean)) {
      const child = source.get('work:' + key)?.[0];
      if (child && p.rows.find((r) => r.id === child.links.template[0])?.v.form === 'hidden')
        parent.links.children.push(child.id);
      else warnings.add('Проверьте ссылку на скрытые работы ' + key + ' в АООК ' + parent.v.number);
    }
  }
  return { project: p, warnings: [...warnings] };
}
