import { BadRequestException } from '@nestjs/common';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer, type Element, type Node } from '@xmldom/xmldom';

export async function openOfficeZip(buffer: Buffer, part: string) {
  try {
    const zip = await JSZip.loadAsync(buffer),
      files = Object.values(zip.files);
    // Enforce the expanded size before asking the Office readers to inflate the archive.
    const size = files.reduce(
      (n, f) => n + ((f as unknown as { _data?: { uncompressedSize: number } })._data?.uncompressedSize || 0),
      0,
    );
    if (files.length > 5000 || size > 96 * 1024 * 1024 || !zip.file(part)) throw Error();
    return zip;
  } catch {
    throw new BadRequestException('Повреждённый, слишком большой или неподдерживаемый файл Office.');
  }
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const ancestor = (n: Node | null, local: string): Element | undefined => {
  while (n) {
    if (n.nodeType === 1 && (n as Element).localName === local) return n as Element;
    n = n.parentNode;
  }
};
const optionalSections = new Set([
  'по_назначению',
  'нагрузка',
  'условия',
  'Должность_Пр',
  'ФИО_Пр',
  'Должность_И1',
  'ФИО_И1',
  'Должность_И2',
  'ФИО_И2',
  'Должность_И3',
  'ФИО_И3',
  'Должность_Пд',
  'ФИО_Пд',
]);
export async function templateFile(data: Buffer) {
  const zip = await openOfficeZip(data, 'word/document.xml');
  const xml = await zip.file('word/document.xml')!.async('string');
  if (xml.includes('<!DOCTYPE') || Object.keys(zip.files).some((n) => /vbaProject|word\/embeddings\//i.test(n)))
    throw new BadRequestException('Используйте шаблон DOCX без макросов и вложенных объектов.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const marks = Array.from(doc.getElementsByTagNameNS(W, 'bookmarkStart')).filter(
    (m) => !m.getAttributeNS(W, 'name')?.startsWith('_'),
  );
  if (!marks.length)
    throw new BadRequestException(
      'В шаблоне нет именованных закладок Word. Скачайте исходную форму и сохраните её закладки.',
    );
  return { zip, doc, marks };
}
function followsNumberSign(mark: Element) {
  const scope = ancestor(mark, 'tr') || ancestor(mark, 'p');
  let node: Node | null = mark;
  while (node && node !== scope) {
    if (!node.previousSibling) {
      node = node.parentNode;
      continue;
    }
    node = node.previousSibling;
    const text = node.textContent?.trim();
    if (text) return text.endsWith('№');
  }
  return false;
}
export async function renderForm(
  data: Buffer,
  values: Record<string, string>,
  materialRows: string[][] = [],
  structure = false,
) {
  const { zip, doc, marks } = await templateFile(data);
  const ends = new Map(
    Array.from(doc.getElementsByTagNameNS(W, 'bookmarkEnd')).map((e) => [e.getAttributeNS(W, 'id'), e]),
  );
  for (const mark of marks) {
    const name = mark.getAttributeNS(W, 'name')!,
      end = ends.get(mark.getAttributeNS(W, 'id'));
    if (!Object.hasOwn(values, name)) throw new BadRequestException('Неизвестная закладка в шаблоне: ' + name);
    if (!end || mark.parentNode !== end.parentNode)
      throw new BadRequestException('Закладка должна находиться в одном абзаце: ' + name);
    const content = values[name];
    const value =
        name.toLowerCase() === 'номер_акта' && content.startsWith('№') && followsNumberSign(mark)
          ? content.replace(/^№\s*/, '')
          : content,
      parent = mark.parentNode!;
    if (!value && (optionalSections.has(name) || (structure && name === 'Наименование_последующих_работ'))) {
      const table = ancestor(parent, 'tbl');
      if (table) {
        table.parentNode?.removeChild(table);
        continue;
      }
    }
    if (name === 'таблица') {
      let table = parent.previousSibling;
      while (table && table.nodeType !== 1) table = table.previousSibling;
      if ((table as Element | null)?.localName === 'tbl') {
        const tbl = table as Element,
          header = tbl.getElementsByTagNameNS(W, 'tr')[0];
        for (const cells of materialRows) {
          const tr = header.cloneNode(true) as Element;
          for (const [i, td] of Array.from(tr.getElementsByTagNameNS(W, 'tc')).entries()) {
            for (const child of Array.from(td.childNodes))
              if ((child as Element).localName !== 'tcPr') td.removeChild(child);
            const p = doc.createElementNS(W, 'w:p'),
              r = doc.createElementNS(W, 'w:r'),
              t = doc.createElementNS(W, 'w:t');
            t.appendChild(doc.createTextNode(cells[i] || ''));
            r.appendChild(t);
            p.appendChild(r);
            td.appendChild(p);
          }
          tbl.appendChild(tr);
        }
        parent.parentNode?.removeChild(parent);
        continue;
      }
    }
    const run = doc.createElementNS(W, 'w:r');
    for (let n = mark.nextSibling; n && n !== end;) {
      const next = n.nextSibling;
      if (!run.firstChild && (n as Element).localName === 'r') {
        const style = (n as Element).getElementsByTagNameNS(W, 'rPr')[0];
        if (style) run.appendChild(style.cloneNode(true));
      }
      parent.removeChild(n);
      n = next;
    }
    for (const [i, line] of value.split(/\r?\n/).entries()) {
      if (i) run.appendChild(doc.createElementNS(W, 'w:br'));
      const t = doc.createElementNS(W, 'w:t');
      t.setAttribute('xml:space', 'preserve');
      t.appendChild(doc.createTextNode(line));
      run.appendChild(t);
    }
    parent.insertBefore(run, end);
    parent.removeChild(mark);
    parent.removeChild(end);
  }
  zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
