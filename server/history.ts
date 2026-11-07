import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryEntry } from '../shared/history.js';

export function safeFilename(value: string): string {
  if ([...value].every(char => char.charCodeAt(0) <= 255)) {
    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    if (!decoded.includes('\ufffd')) value = decoded;
  }
  return value.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 180) || 'Документ';
}

export class ConversionStore {
  private db: DatabaseSync;
  private files: string;
  constructor(directory: string) {
    this.files = path.join(path.resolve(directory), 'files');
    mkdirSync(this.files, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'conversions.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS conversions (
        id TEXT PRIMARY KEY, original_name TEXT NOT NULL, result_name TEXT NOT NULL,
        original_mime TEXT NOT NULL, created_at TEXT NOT NULL,
        row_count INTEGER NOT NULL, warning_count INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS conversion_dates ON conversions(created_at DESC, id DESC);`);
  }
  private select = `SELECT id, original_name AS originalName, result_name AS resultName,
    original_mime AS originalMime, created_at AS createdAt, row_count AS rowCount,
    warning_count AS warningCount FROM conversions`;
  list(offset: number, limit: number): { items: HistoryEntry[]; total: number } {
    const items = this.db.prepare(this.select + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(limit, offset) as unknown as HistoryEntry[];
    const count = this.db.prepare('SELECT COUNT(*) AS total FROM conversions').get() as { total: number };
    return { items, total: count.total };
  }
  get(id: string): HistoryEntry | undefined {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return undefined;
    return this.db.prepare(this.select + ' WHERE id=?').get(id) as unknown as HistoryEntry | undefined;
  }
  filePath(id: string, kind: 'source' | 'result'): string {
    if (!this.get(id)) throw new Error('Conversion not found');
    return path.join(this.files, `${id}.${kind === 'source' ? 'source' : 'xlsx'}`);
  }
  async save(original: Buffer, result: Buffer, originalName: string, originalMime: string, rowCount: number, warningCount: number): Promise<HistoryEntry> {
    const id = randomUUID();
    const name = safeFilename(originalName);
    const entry: HistoryEntry = { id, originalName: name, resultName: `${name.replace(/\.[^.]+$/, '') || 'Документ'}.xlsx`, originalMime, createdAt: new Date().toISOString(), rowCount, warningCount };
    const sourcePath = path.join(this.files, `${id}.source`);
    const resultPath = path.join(this.files, `${id}.xlsx`);
    try {
      await writeFile(sourcePath, original, { flag: 'wx', mode: 0o600 });
      await writeFile(resultPath, result, { flag: 'wx', mode: 0o600 });
      this.db.prepare('INSERT INTO conversions VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, entry.originalName, entry.resultName, originalMime, entry.createdAt, rowCount, warningCount);
      return entry;
    } catch (error) {
      await Promise.allSettled([rm(sourcePath, { force: true }), rm(resultPath, { force: true })]);
      throw error;
    }
  }
  async delete(id: string): Promise<boolean> {
    if (!this.get(id)) return false;
    await rm(path.join(this.files, `${id}.source`), { force: true });
    await rm(path.join(this.files, `${id}.xlsx`), { force: true });
    this.db.prepare('DELETE FROM conversions WHERE id=?').run(id);
    return true;
  }
  close() { this.db.close(); }
}
