import { entry, formTypes, roles, type Entry, type Project } from '../../shared/construction.js';
import type { PackageDocument } from '../document-register.js';

export type PackageSource = {
  job: string; root: string; digest: string; filename: string; object: string; section: string;
  reviews: { page: number; reason: string }[];
};
export type PackageRoute = { projectId: string | null; projectName: string; packageName: string };

function documentType(row: PackageDocument) {
  const title = row.name.toLowerCase();
  if (row.kind === 'Акт' || /^акт\s|^аоср|^аоок|^авк/i.test(title)) {
    if (/скрыт.{1,8} работ|аоср/.test(title)) return 'hidden';
    if (/ответственн.{1,8} конструкц|аоок/.test(title)) return 'structure';
    if (/входно.{1,4} контрол|^авк/.test(title)) return 'incoming';
    return 'protocol';
  }
  if (row.kind === 'Реестр' || /^реестр/.test(title)) return 'attachment';
  if (['Паспорт', 'Сертификат'].includes(row.kind) || /^(декларация|свидетельство о качестве|удостоверение качества)/.test(title)) return 'material';
  if (row.kind === 'Исполнительная схема') return 'scheme';
  if (row.kind === 'Протокол') return 'protocol';
  return 'attachment';
}

export function fillPackage(project: Project, pack: Entry, source: PackageSource, rows: PackageDocument[]) {
  Object.assign(pack.v, { sourceJob: source.job, sourceDigest: source.digest, sourcePages: source.filename,
    sourceSection: source.section, sourceObject: source.object });
  // Keep review notes within the per-field limit even for very large volumes.
  for (let start = 0; start < source.reviews.length; start += 30)
    pack.v['sourceReviews' + start] = JSON.stringify(source.reviews.slice(start, start + 30)
      .map(({page, reason}) => ({page, reason: reason.slice(0, 500)})));
  let work: Entry | undefined;
  return rows.map((row, index) => {
    const type = row.act?.form ?? documentType(row);
    const title = row.name || row.kind;
    const v = { name: title, number: row.number, date: row.date, issuer: row.organization,
      docType: row.kind, material: row.material, batch: row.batch, work: row.work, level2: row.section, level3: row.floor,
      pages: String(row.last - row.first + 1), sourceFirst: String(row.first), sourceLast: String(row.last),
      sourceJob: source.job, sourceIndex: String(index), sourceTitle: title, reviewFields: (row.reviewFields || []).join(','),
      sourcePages: source.filename + ', стр. ' + row.first + (row.first === row.last ? '' : '–' + row.last) };
    let doc: Entry;
    if (type === 'hidden' || type === 'structure' || type === 'incoming') {
      let template = project.rows.find(r => r.kind === 'template' && r.v.form === type);
      if (!template) {
        template = entry('template', { form: type, name: formTypes[type] });
        project.rows.push(template);
      }
      doc = entry('work', { ...v, name: row.work || title,
        date: row.date.replace(/^(\d\d)\.(\d\d)\.(\d{4})$/, '$3-$2-$1') }, { pack: [pack.id], template: [template.id] });
      if (row.act) {
        const { start, end, design, next, axes, elevation, compliance, signers } = row.act;
        Object.assign(doc.v, { design, next, axes, elevation, compliance });
        if (/^\d{4}-\d{2}-\d{2}$/.test(start)) doc.v.start = start;
        if (/^\d{4}-\d{2}-\d{2}$/.test(end) && (!doc.v.start || end >= doc.v.start)) doc.v.end = end;
        for (const signer of signers) {
          const slot = 'signer' + roles.indexOf(signer.role);
          if (!signer.name.trim() || doc.links[slot]) continue;
          const same = project.rows.find(r => r.kind === 'person' && Object.entries(signer).every(([k, v]) =>
            (r.v[k] || '').trim().toLowerCase() === v.trim().toLowerCase()));
          const person = same || entry('person', { ...signer });
          if (!same) project.rows.push(person);
          doc.links[slot] = [person.id];
        }
      }
      work = doc;
    } else {
      doc = entry(type, v);
      const key = { material: 'materials', scheme: 'schemes', protocol: 'protocols', attachment: 'attachments' }[type];
      (pack.links[key] ??= []).push(doc.id);
      if (work) (work.links[key] ??= []).push(doc.id);
    }
    doc.file = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 170) + '.pdf';
    project.rows.push(doc);
    return doc;
  });
}
