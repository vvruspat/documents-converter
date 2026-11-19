export type ScanWord = { x: number; y: number; w: number; h: number; text: string; line: string };
export type ScanLayout = { width: number; height: number; rotation?: number; ocrStatus?: 'pending' | 'ready' | 'failed'; words: ScanWord[] };
export const fieldLabels = {
  name: 'Наименование',
  number: 'Номер',
  date: 'Дата',
  organization: 'Организация',
  material: 'Материал',
  batch: 'Партия',
  work: 'Работы',
  floor: 'Этаж',
  section: 'Секция',
};
export type Field = keyof typeof fieldLabels;

// A single exact sequence after removing OCR punctuation. Ambiguous repetitions
// and short isolated numbers cannot reliably identify a document field.
export function locate(words: ScanWord[], value: string, field?: Field): [number, number] | undefined {
  const months = [
    'января',
    'февраля',
    'марта',
    'апреля',
    'мая',
    'июня',
    'июля',
    'августа',
    'сентября',
    'октября',
    'ноября',
    'декабря',
  ];

  const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\d]/gu, '');
  const target = clean(value);
  if (target.length < 3) return;
  const targets = new Set([target]);
  const date = field === 'date' && /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  if (date && months[Number(date[2]) - 1]) {
    const suffix = months[Number(date[2]) - 1] + date[3];
    targets.add(date[1] + suffix);
    targets.add(Number(date[1]) + suffix);
  }
  const prefixes = [...targets];
  let match: [number, number] | undefined;
  for (let start = 0; start < words.length; start++) {
    let text = clean(words[start].text);
    if (!text || !prefixes.some((t) => t.startsWith(text))) continue;
    let end = start;
    while (!targets.has(text) && end + 1 < words.length && prefixes.some((t) => t.startsWith(text)))
      text += clean(words[++end].text);
    if (!targets.has(text)) continue;
    if (match) return;
    match = [start, end];
  }
  return match;
}

// Preserve the original line boxes when a catalog value spans several OCR lines.
export function fieldLines(words: ScanWord[], value: string) {
  const lines: ScanWord[][] = [];
  for (const word of words) {
    if (lines.at(-1)?.[0].line !== word.line) lines.push([]);
    lines[lines.length - 1].push(word);
  }
  const tokens = value.trim().split(/\s+/);
  let token = 0,
    seen = 0;
  return lines.flatMap((line) => {
    seen += line.length;
    const end = Math.max(token + 1, Math.round((tokens.length * seen) / words.length));
    const text = tokens.slice(token, end).join(' ');
    token = end;
    if (!text) return [];
    const x = Math.min(...line.map((w) => w.x)),
      y = Math.min(...line.map((w) => w.y));
    const w = Math.max(...line.map((word) => word.x + word.w)) - x;
    const h = Math.max(...line.map((word) => word.y + word.h)) - y;
    return [{ x, y, w, h, text }];
  });
}
