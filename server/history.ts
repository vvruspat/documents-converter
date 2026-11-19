import type { CatalogRow, DocumentSet, Requirement } from '../shared/catalog.js';
import type { IndexedFile } from './catalog.js';
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
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.namespace}.catalog_files (
        job uuid PRIMARY KEY, file text NOT NULL, project text NOT NULL, rows jsonb NOT NULL)`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.namespace}.document_sets (
        id uuid PRIMARY KEY, project text NOT NULL, name text NOT NULL, requirements jsonb NOT NULL, confirmations jsonb NOT NULL DEFAULT '{}'::jsonb)`);
      await client.query(`ALTER TABLE ${this.namespace}.catalog_files ADD COLUMN IF NOT EXISTS text_indexed boolean NOT NULL DEFAULT false`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.namespace}.catalog_pages (
        job uuid REFERENCES ${this.namespace}.catalog_files(job) ON DELETE CASCADE, page integer NOT NULL,
        body text NOT NULL, terms tsvector GENERATED ALWAYS AS (to_tsvector('russian',body)) STORED, PRIMARY KEY(job,page))`);
      await client.query(`CREATE INDEX IF NOT EXISTS catalog_page_terms ON ${this.namespace}.catalog_pages USING gin(terms)`);
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
  async indexedJobs(project: string): Promise<Set<string>> {
    await this.ready();
    const { rows } = await this.pool.query(`SELECT job FROM ${this.namespace}.catalog_files WHERE project=$1 AND text_indexed`, [project]);
    return new Set(rows.map(row => row.job));
  }
  async indexFile(job: string, project: string, file: string, rows: CatalogRow[], texts: string[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${this.namespace}.catalog_files (job,file,project,rows) VALUES ($1,$2,$3,$4) ON CONFLICT(job) DO NOTHING`, [job,file,project,JSON.stringify(rows)]);
      await client.query(`INSERT INTO ${this.namespace}.catalog_pages (job,page,body)
        SELECT $1,ordinality,body FROM unnest($2::text[]) WITH ORDINALITY AS p(body,ordinality)
        WHERE body <> '' ON CONFLICT DO NOTHING`, [job,texts]);
      await client.query(`UPDATE ${this.namespace}.catalog_files SET text_indexed=true WHERE job=$1`, [job]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
  async indexPageText(job: string, page: number, body: string) {
    await this.pool.query(`INSERT INTO ${this.namespace}.catalog_pages (job,page,body)
      SELECT job,$2,$3 FROM ${this.namespace}.catalog_files WHERE job=$1
      ON CONFLICT (job,page) DO UPDATE SET body=EXCLUDED.body`, [job,page,body]);
  }
  async findPassages(project: string, question: string): Promise<{ job: string; page: number; excerpt: string }[]> {
    const words = question.match(/[\p{L}\p{N}]+/gu)?.filter(word => word.length > 2 || /\d/.test(word)).slice(0,32);
    if (!words?.length) return [];
    const result = await this.pool.query(`SELECT p.job,p.page,
      ts_headline('russian',p.body,q,'MaxWords=80, MinWords=15, MaxFragments=3') AS excerpt
      FROM ${this.namespace}.catalog_pages p JOIN ${this.namespace}.catalog_files f ON p.job=f.job,
      websearch_to_tsquery('russian',$2) q WHERE f.project=$1 AND p.terms @@ q
      ORDER BY ts_rank(p.terms,q) DESC,p.job,p.page LIMIT 8`, [project,words.join(' OR ')]);
    return result.rows;
  }
  async catalogFiles(project: string, ids: string[]): Promise<IndexedFile[]> {
    const result = await this.pool.query(`SELECT job,file,rows FROM ${this.namespace}.catalog_files WHERE project=$1 AND job=ANY($2::uuid[]) ORDER BY job`, [project,ids]);
    return result.rows;
  }
  async forgetFile(job: string) {
    await this.pool.query(`DELETE FROM ${this.namespace}.catalog_files WHERE job=$1`, [job]);
  }
  async sets(project: string): Promise<DocumentSet[]> {
    await this.ready();
    return (await this.pool.query(`SELECT * FROM ${this.namespace}.document_sets WHERE project=$1 ORDER BY name,id`, [project])).rows;
  }
  async addSet(project: string, name: string, requirements: Requirement[]) {
    await this.ready();
    await this.pool.query(`INSERT INTO ${this.namespace}.document_sets (id,project,name,requirements) VALUES ($1,$2,$3,$4)`, [randomUUID(),project,name,JSON.stringify(requirements)]);
  }
  async confirm(project: string, id: string, position: number, card: string | null) {
    const result = await this.pool.query(`UPDATE ${this.namespace}.document_sets
      SET confirmations = CASE WHEN $4::text IS NULL THEN confirmations - $3::text
        ELSE jsonb_set(confirmations, ARRAY[$3::text], to_jsonb($4::text)) END
      WHERE project=$1 AND id=$2 AND jsonb_array_length(requirements)>$3::integer`, [project,id,String(position),card]);
    return result.rowCount === 1;
  }
  async close(): Promise<void> { await this.initialized.catch(() => {}); await this.pool.end(); }
}
