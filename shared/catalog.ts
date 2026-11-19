export type CatalogFields = {
  kind: string; material: string; batch: string; work: string; floor: string; section: string;
};
export type CatalogRow = CatalogFields & {
  name: string; number: string; date: string; organization: string;
  first: number; last: number; uncertain: boolean;
};
export type Source = { index: number; job: string; file: string; first: number; last: number };
export type Card = Omit<CatalogRow, 'first' | 'last'> & { id: string; sources: Source[] };
export type Requirement = { section?: string; floor?: string; work?: string; kind: string; number: string; batch: string; organization: string };
export type DocumentSet = { id: string; project: string; name: string; confirmations: Record<string,string>; requirements: Requirement[] };
export const kinds = ['Акт', 'Паспорт', 'Сертификат', 'Протокол', 'Исполнительная схема', 'Реестр', 'Другой документ'] as const;
export function normalized(value: string) { return value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' '); }
export function assess(required: Requirement, cards: Card[], confirmed?: string) {
  const matches = cards.filter(card => card.kind === required.kind &&
    (['section', 'floor', 'work'] as const).every(key => !required[key] || !card[key] || normalized(card[key]) === normalized(required[key])) &&
    (['number', 'batch', 'organization'] as const).every(key => !required[key] || normalized(card[key]) === normalized(required[key])));
  const accepted = confirmed && matches.find(card => card.id === confirmed);
  if (accepted) return { status: 'Подтверждён', matches: [accepted] };
  if (!matches.length) return { status: 'Отсутствует', matches };
  const unique = matches.length === 1 && (['section', 'floor', 'work'] as const).every(key => !required[key] || matches[0][key]) && !matches[0].uncertain && !!required.organization && !!(required.batch || required.number);
  return { status: unique ? 'Найден' : 'На проверку', matches };
}
