import { readProject } from './legacy.js';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { newProject } from './import.js';
import { fillPackage, type PackageSource, type PackageRoute } from './registry-package.js';
import type { PackageDocument } from '../document-register.js';
import type { Pool, PoolClient } from 'pg';
import {
  entry, projectSchema,
  validateProject,
  type Project,
  type ProjectSummary,
  type SavedProject,
} from '../../shared/construction.js';

export type Asset = { name: string; data: Buffer };
export class ProjectStore {
  constructor(
    private pool: Pool,
    private ns: string,
    private ready: () => Promise<void>,
  ) {}
  static ddl(ns: string) {
    return `
    CREATE TABLE IF NOT EXISTS ${ns}.construction_projects (
      id uuid PRIMARY KEY, version integer NOT NULL DEFAULT 1, data jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS ${ns}.construction_assets (
      project uuid REFERENCES ${ns}.construction_projects(id) ON DELETE CASCADE,
      entry uuid NOT NULL, name text NOT NULL, data bytea NOT NULL, PRIMARY KEY(project,entry));`;
  }
  async list(): Promise<ProjectSummary[]> {
    await this.ready();
    return (
      await this.pool.query(`SELECT id,data->'v'->>'name' name,
      (SELECT count(*)::int FROM jsonb_array_elements(data->'rows') r WHERE r->>'kind'='pack'
        OR (r->>'kind'='phase' AND (
          NOT EXISTS (SELECT 1 FROM jsonb_array_elements(data->'rows') p WHERE p->>'kind'='pack' AND p->'links'->'phase'->>0=r->>'id')
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(data->'rows') w WHERE w->>'kind'='work' AND w->'links'->'phase'->>0=r->>'id' AND coalesce(jsonb_array_length(w->'links'->'pack'),0)=0)
        ))) packs,
      jsonb_array_length(jsonb_path_query_array(data,'$.rows[*] ? (@.kind == "work")')) works
      FROM ${this.ns}.construction_projects ORDER BY name,id`)
    ).rows;
  }
  async get(id: string): Promise<SavedProject> {
    await this.ready();
    const {
      rows: [row],
    } = await this.pool.query(`SELECT version,data FROM ${this.ns}.construction_projects WHERE id=$1`, [id]);
    if (!row) throw new NotFoundException('Проект не найден.');
    return { ...readProject(row.data), id, version: row.version };
  }
  validate(input: unknown): Project {
    const parsed = projectSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Некорректные данные проекта.');
    const error = validateProject(parsed.data);
    if (error) throw new BadRequestException(error);
    return parsed.data;
  }
  async create(
    input: Project,
    assets: { entry: string; name: string; data: Buffer }[] = [],
  ): Promise<SavedProject> {
    const data = this.validate(input),
      id = randomUUID();
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ${this.ns}.construction_projects(id,data) VALUES ($1,$2)`, [id, data]);
      for (const asset of assets)
        await client.query(`INSERT INTO ${this.ns}.construction_assets VALUES ($1,$2,$3,$4)`, [
          id,
          asset.entry,
          asset.name,
          asset.data,
        ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return { ...data, id, version: 1 };
  }
  async save(
    id: string,
    version: number,
    input: unknown,
    uploads: (Asset & { entry: string })[] = [],
  ): Promise<SavedProject> {
    const data = this.validate(input);
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE ${this.ns}.construction_projects SET data=$3,version=version+1
        WHERE id=$1 AND version=$2 RETURNING version`,
        [id, version, data],
      );
      if (!result.rowCount) throw new ConflictException('Проект изменился. Обновите страницу и повторите правку.');
      for (const upload of uploads)
        await client.query(
          `INSERT INTO ${this.ns}.construction_assets VALUES ($1,$2,$3,$4)
        ON CONFLICT(project,entry) DO UPDATE SET name=excluded.name,data=excluded.data`,
          [id, upload.entry, upload.name, upload.data],
        );
      const files = data.rows.filter((r) => r.file);
      await client.query(
        `DELETE FROM ${this.ns}.construction_assets WHERE project=$1 AND NOT(entry=ANY($2::uuid[]))`,
        [id, files.map((r) => r.id)],
      );
      const assets = await client.query(`SELECT entry,name FROM ${this.ns}.construction_assets WHERE project=$1`, [
        id,
      ]);
      const names = new Map(assets.rows.map((a) => [a.entry, a.name]));
      if (files.some((r) => names.get(r.id) !== r.file))
        throw new BadRequestException('Не найден оригинал приложенного файла.');
      await client.query('COMMIT');
      return { ...data, id, version: result.rows[0].version };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async registryPackage(source: PackageSource, client: Pool | PoolClient = this.pool) {
    await this.ready();
    const { rows } = await client.query<{ project: string; pack: string; name: string }>(
      `SELECT id project, r->>'id' pack, r->'v'->>'name' name FROM ${this.ns}.construction_projects
       CROSS JOIN LATERAL jsonb_array_elements(data->'rows') r
       WHERE r->>'kind'='pack' AND (r->'v'->>'sourceDigest'=$1 OR r->'v'->>'sourceJob'=ANY($2::text[])) LIMIT 1`,
      [source.digest, [source.job, source.root]]);
    return rows[0];
  }

  async legacyPackageSources() {
    await this.ready();
    const { rows } = await this.pool.query<{ job: string; project: string; pack: string; name: string }>(
      `SELECT r->'v'->>'sourceJob' job, id project, r->>'id' pack, r->'v'->>'name' name
       FROM ${this.ns}.construction_projects CROSS JOIN LATERAL jsonb_array_elements(data->'rows') r
       WHERE r->>'kind'='pack' AND r->'v' ? 'sourceJob' AND NOT (r->'v' ? 'sourceDigest')`);
    return rows;
  }

  async importRegistry(source: PackageSource, route: PackageRoute, rows: PackageDocument[], scan: (index: number) => Promise<Buffer>) {
    await this.ready();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [this.ns + ':registry-package']);
      const duplicate = await this.registryPackage(source, client);
      if (duplicate) {
        await client.query('COMMIT');
        return duplicate;
      }
      const result = route.projectId
        ? await client.query(`SELECT id,data FROM ${this.ns}.construction_projects WHERE id=$1 FOR UPDATE`, [route.projectId])
        : await client.query(`SELECT id,data FROM ${this.ns}.construction_projects
          WHERE lower(trim(data->'v'->>'name'))=lower(trim($1)) ORDER BY id LIMIT 1 FOR UPDATE`, [route.projectName]);
      const existing = result.rows[0];
      if (route.projectId && !existing) throw new ConflictException('Выбранный проект больше недоступен.');
      const id: string = existing?.id ?? randomUUID();
      const project = existing ? readProject(existing.data) : await newProject(route.projectName, route.packageName);
      const pack = existing ? entry('pack', { name: route.packageName }) : project.rows[0];
      if (existing) project.rows.push(pack);
      else project.v.object = source.object;
      const documents = fillPackage(project, pack, source, rows);
      this.validate(project);
      if (existing)
        await client.query(`UPDATE ${this.ns}.construction_projects SET data=$2,version=version+1 WHERE id=$1`, [id, project]);
      else
        await client.query(`INSERT INTO ${this.ns}.construction_projects(id,data) VALUES ($1,$2)`, [id, project]);
      for (const [index, doc] of documents.entries())
        await client.query(`INSERT INTO ${this.ns}.construction_assets(project,entry,name,data) VALUES ($1,$2,$3,$4)`,
          [id, doc.id, doc.file, await scan(index)]);
      await client.query('COMMIT');
      return { project: id, pack: pack.id, name: pack.v.name };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async asset(id: string, entry: string, version: number): Promise<Asset> {
    await this.ready();
    const {
      rows: [row],
    } = await this.pool.query(
      `SELECT a.name,a.data FROM ${this.ns}.construction_assets a JOIN ${this.ns}.construction_projects p ON p.id=a.project
      WHERE project=$1 AND entry=$2 AND p.version=$3`,
      [id, entry, version],
    );
    if (!row) throw new ConflictException('Версия файла изменилась. Обновите проект.');
    return row;
  }
}
