import { createHash } from 'node:crypto';
import { normalized, type Card, type CatalogRow } from '../shared/catalog.js';

export type IndexedFile = { job: string; file: string; rows: CatalogRow[] };
export function catalogCards(files: IndexedFile[]): Card[] {
  const cards = new Map<string, Card>();
  for (const { job, file, rows } of files) {
    rows.forEach(({ first, last, ...fields }, index) => {
      // Only collapse complete, confident, identical descriptions inside one project.
      const signature = fields.uncertain || !fields.number || !fields.date || !fields.organization
        ? [job, index] : Object.entries(fields).filter(([key]) => key !== 'uncertain').sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalized(String(value))]);
      const id = createHash('sha256').update(JSON.stringify(signature)).digest('hex');
      const card = cards.get(id) ?? { ...fields, id, sources: [] };
      card.sources.push({ job, file, first, last });
      cards.set(id, card);
    });
  }
  return [...cards.values()];
}

export function retrieve(question: string, cards: Card[]) {
  const words = [...new Set(normalized(question).match(/[\p{L}\p{N}]+/gu) ?? [])].filter(word => word.length > 2 || /\d/.test(word));
  return cards.map(card => {
    const fields = [card.name, card.kind, card.number, card.organization, card.batch, card.material, card.section, card.floor, card.work, card.date];
    const tokens = normalized(fields.join(' ')).match(/[\p{L}\p{N}]+/gu) ?? [];
    const score = words.reduce((sum, word) => sum + (tokens.some(token => token === word || (word.length > 5 && token.startsWith(word.slice(0, -2)))) ? (/\d/.test(word) ? 5 : 1) : 0), 0);
    return { card, score };
  }).filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, 6).map(item => item.card);
}
