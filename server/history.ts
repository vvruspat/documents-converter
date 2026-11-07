import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { access, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryEntry } from '../shared/history.js';

const validId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function safeFilename(value: string): string {
  if ([...value].every(char => char.charCodeAt(0) <= 255)) {
    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    if (!decoded.includes('\ufffd')) value = decoded;
  }
  return value.replace(/[\\/\x00-\x1f\x7f]/g, '_').trim().slice(0, 180) || 'Документ';
}
export type StoreOptions = { directory: string; connectionString: string; schema?: string };
type DbEntry = Omit<HistoryEntry, 'createdAt'> & { createdAt: string | Date };
const normalize = (row: DbEntry): HistoryEntry => ({ ...row, createdAt: new Date(row.createdAt).toISOString() });

export class ConversionStore {
  private pool: Pool;
  private files: string;
  private namespace: string;
  private initialized: Promise<void>;
  private columns = `id, original_name AS "originalName", result_name AS "resultName",
    original_mime AS "originalMime", created_at AS "createdAt", row_count AS "rowCount", warning_count AS "warningCount"`;
  constructor(private options: StoreOptions) {
    if (!options.connectionString) throw new Error('DATABASE_URL must be configured');
    const schema = options.schema ?? 'public';
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid database schema');
    this.namespace = `"${schema}"`;
    this.files = path.join(path.resolve(options.directory), 'files');
    mkdirSync(this.files, { recursive: true, mode: 0o700 });
    this.pool = new Pool({ connectionString: options.connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000 });
    this.pool.on('error', () => console.error('PostgreSQL idle connection error'));
    this.initialized = this.initialize();
    // Startup and database entry points await this promise; handle rejection until then.
    void this.initialized.catch(() => {});
  }
  ready(): Promise<void> { return this.initialized; }
  private async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`documents-converter-schema:${this.options.schema ?? 'public'}`]);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.namespace}.conversions (
        id UUID PRIMARY KEY, original_name TEXT NOT NULL, result_name TEXT NOT NULL,
        original_mime TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
        row_count INTEGER NOT NULL CHECK (row_count >= 0), warning_count INTEGER NOT NULL CHECK (warning_count >= 0)
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS conversion_dates ON ${this.namespace}.conversions(created_at DESC, id DESC)`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.namespace}.legacy_conversion_imports (id UUID PRIMARY KEY, imported_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.namespace}.pending_file_deletions (id UUID PRIMARY KEY)`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.namespace}.history_migrations (key TEXT PRIMARY KEY, completed_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      const finalized = await client.query(`SELECT key FROM ${this.namespace}.history_migrations WHERE key='sqlite-finalized'`);
      const legacy = finalized.rowCount ? [] : await this.readLegacy();
      let imported = 0;
      for (const entry of legacy) {
        if (!validId(entry.id)) throw new Error('Invalid legacy conversion identifier');
        const claimed = await client.query(`INSERT INTO ${this.namespace}.legacy_conversion_imports(id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id`, [entry.id]);
        if (!claimed.rowCount) continue;
        await access(this.filePath(entry.id, 'source'));
        await access(this.filePath(entry.id, 'result'));
        await client.query(`INSERT INTO ${this.namespace}.conversions VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, [entry.id, entry.originalName, entry.resultName, entry.originalMime, entry.createdAt, entry.rowCount, entry.warningCount]);
        imported++;
      }
      await client.query('COMMIT');
      if (imported) console.log(`Imported ${imported} legacy conversion records into PostgreSQL`);
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    await this.cleanDeletedFiles();
  }
  private async readLegacy(): Promise<HistoryEntry[]> {
    const filename = path.join(this.options.directory, 'conversions.sqlite');
    try { await access(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    // SQLite is opened read-only solely to import existing history. Live operations use PostgreSQL.
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(filename, { readOnly: true });
    try {
      return legacy.prepare(`SELECT id,original_name AS originalName,result_name AS resultName,original_mime AS originalMime,created_at AS createdAt,row_count AS rowCount,warning_count AS warningCount FROM conversions`).all() as unknown as HistoryEntry[];
    } finally { legacy.close(); }
  }
  async checkHealth(): Promise<void> { await this.ready(); await this.pool.query('SELECT 1'); }
  // Run once after the old SQLite writer has stopped. A fresh store first imports its last rows.
  async finalizeLegacyImport(): Promise<{ removed: number }> {
    await this.ready();
    const client = await this.pool.connect();
    let removed = 0;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`documents-converter-schema:${this.options.schema ?? 'public'}`]);
      const finalized = await client.query(`SELECT key FROM ${this.namespace}.history_migrations WHERE key='sqlite-finalized'`);
      if (finalized.rowCount) { await client.query('COMMIT'); return { removed: 0 }; }
      await access(path.join(this.options.directory, 'conversions.sqlite'));
      const legacy = await this.readLegacy();
      const result = await client.query(`DELETE FROM ${this.namespace}.conversions WHERE id IN (SELECT id FROM ${this.namespace}.legacy_conversion_imports) AND NOT (id=ANY($1::uuid[])) RETURNING id`, [legacy.map(entry => entry.id)]);
      removed = result.rowCount ?? 0;
      for (const row of result.rows) await client.query(`INSERT INTO ${this.namespace}.pending_file_deletions(id) VALUES ($1) ON CONFLICT DO NOTHING`, [row.id]);
      await client.query(`INSERT INTO ${this.namespace}.history_migrations(key) VALUES ('sqlite-finalized') ON CONFLICT DO NOTHING`);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    await this.cleanDeletedFiles();
    return { removed };
  }
  async list(offset: number, limit: number): Promise<{ items: HistoryEntry[]; total: number }> {
    await this.ready();
    const query = await this.pool.query(`WITH page AS (SELECT ${this.columns} FROM ${this.namespace}.conversions ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2)
      SELECT (SELECT count(*)::integer FROM ${this.namespace}.conversions) AS total, COALESCE((SELECT jsonb_agg(page ORDER BY "createdAt" DESC,id DESC) FROM page),'[]'::jsonb) AS items`, [limit, offset]);
    return { total: query.rows[0].total, items: query.rows[0].items.map(normalize) };
  }
  async get(id: string): Promise<HistoryEntry | undefined> {
    if (!validId(id)) return undefined;
    await this.ready();
    const result = await this.pool.query(`SELECT ${this.columns} FROM ${this.namespace}.conversions WHERE id=$1`, [id]);
    return result.rows[0] ? normalize(result.rows[0]) : undefined;
  }
  filePath(id: string, kind: 'source' | 'result'): string {
    if (!validId(id)) throw new Error('Invalid conversion identifier');
    return path.join(this.files, `${id}.${kind === 'source' ? 'source' : 'xlsx'}`);
  }
  async save(original: Buffer, result: Buffer, originalName: string, originalMime: string, rowCount: number, warningCount: number): Promise<HistoryEntry> {
    await this.ready();
    const id = randomUUID(); const name = safeFilename(originalName);
    const entry: HistoryEntry = { id, originalName: name, resultName: `${name.replace(/\.[^.]+$/, '') || 'Документ'}.xlsx`, originalMime, createdAt: new Date().toISOString(), rowCount, warningCount };
    const sourcePath = this.filePath(id, 'source'), resultPath = this.filePath(id, 'result');
    try {
      await writeFile(sourcePath, original, { flag: 'wx', mode: 0o600 });
      await writeFile(resultPath, result, { flag: 'wx', mode: 0o600 });
      await this.pool.query(`INSERT INTO ${this.namespace}.conversions VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, entry.originalName, entry.resultName, originalMime, entry.createdAt, rowCount, warningCount]);
      return entry;
    } catch (error) {
      // If the network failed after COMMIT, preserve files belonging to an inserted record.
      const existing = await this.get(id);
      if (existing) return existing;
      await Promise.allSettled([rm(sourcePath, { force: true }), rm(resultPath, { force: true })]);
      throw error;
    }
  }
  async delete(id: string): Promise<boolean> {
    if (!validId(id)) return false;
    await this.ready(); const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const removed = await client.query(`DELETE FROM ${this.namespace}.conversions WHERE id=$1 RETURNING id`, [id]);
      if (removed.rowCount) await client.query(`INSERT INTO ${this.namespace}.pending_file_deletions(id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
      await client.query('COMMIT');
      if (!removed.rowCount) return false;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    await this.cleanDeletedFiles(id);
    return true;
  }
  private async cleanDeletedFiles(onlyId?: string): Promise<void> {
    const pending = await this.pool.query(`SELECT id FROM ${this.namespace}.pending_file_deletions${onlyId ? ' WHERE id=$1' : ''}`, onlyId ? [onlyId] : []);
    for (const { id } of pending.rows) {
      await rm(this.filePath(id, 'source'), { force: true });
      await rm(this.filePath(id, 'result'), { force: true });
      await this.pool.query(`DELETE FROM ${this.namespace}.pending_file_deletions WHERE id=$1`, [id]);
    }
  }
  async close(): Promise<void> { await this.initialized.catch(() => {}); await this.pool.end(); }
}
