import { mkdtemp, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { baseForm } from './forms.js';
import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter, FileInterceptor, FilesInterceptor, FileFieldsInterceptor } from '@nestjs/platform-express';
import express from 'express';
import { z } from 'zod';
import { safeFilename } from '../history.js';
import { ProjectStore } from './store.js';
import { newProject, importBook } from './import.js';
import { templateFile } from './office.js';
import { certificate } from './certificates.js';
import { incomingReport, report } from './report.js';
import { acceptsOriginal, formTypes } from '../../shared/construction.js';

const fileUpload = FileInterceptor('file', {
  limits: { fileSize: 24 * 1024 * 1024, files: 1, fields: 4, fieldSize: 4 * 1024 * 1024 },
});
function fileRequired(f?: Express.Multer.File) {
  if (!f?.size) throw new BadRequestException('Выберите файл.');
  return f;
}
function download(res: express.Response, name: string, data: Buffer) {
  res.attachment(safeFilename(name)).send(data);
}
function revision(value: unknown) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new BadRequestException('Некорректная версия проекта.');
  return n;
}
function inputText(v: unknown, defaultValue = '') {
  return typeof v === 'string' ? v.trim().slice(0, 500) : defaultValue;
}
@Controller()
class ProjectsController {
  constructor(@Inject(ProjectStore) private readonly store: ProjectStore) {}
  @Get() list() {
    return this.store.list();
  }
  @Post() async create(@Body() body: Record<string, unknown>) {
    return this.store.create(await newProject(inputText(body.name), inputText(body.pack || body.phase) || 'Основной комплект'));
  }
  @Post('import')
  @UseInterceptors(
    FileFieldsInterceptor(
      ['file', ...Object.keys(formTypes)].map((name) => ({ name, maxCount: 1 })),
      { limits: { files: 4, fields: 2 } },
    ),
  )
  async import(@UploadedFiles() files: Record<string, Express.Multer.File[]>, @Body() body: Record<string, unknown>) {
    const { project, warnings } = await importBook(
      fileRequired(files?.file?.[0]).buffer,
      inputText(body.pack || body.phase) || 'Основной комплект',
      body.includeNotes === 'true',
    );
    const assets = [];
    for (const [form, name] of Object.entries(formTypes)) {
      const upload = files[form]?.[0];
      if (!upload) continue;
      await templateFile(upload.buffer);
      const row = project.rows.find((r) => r.kind === 'template' && r.v.name === name)!;
      row.file = safeFilename(upload.originalname);
      assets.push({ entry: row.id, name: row.file, data: upload.buffer });
    }
    return { project: await this.store.create(project, assets), warnings };
  }
  @Post('parse-certificate')
  @UseInterceptors(fileUpload)
  parse(@UploadedFile() f: Express.Multer.File) {
    return certificate(fileRequired(f).buffer);
  }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) {
    return this.store.get(id);
  }
  @Put(':id')
  @UseInterceptors(FilesInterceptor('file', 4, {
    limits: { fileSize: 24 * 1024 * 1024, files: 4, fields: 6, fieldSize: 4 * 1024 * 1024 },
  }))
  async put(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ) {
    let project = body.project;
    if (typeof project === 'string') {
      try {
        project = JSON.parse(project);
      } catch {
        throw new BadRequestException('Некорректные данные проекта.');
      }
    }
    const filesOnly = project === undefined && files.length > 0;
    const expected = revision(body.version);
    const current = filesOnly ? await this.store.get(id) : undefined;
    if (current && current.version !== expected) throw new ConflictException('Версия проекта изменилась.');
    const data = current ?? this.store.validate(project);
    const entries = body.entry === undefined ? [] : Array.isArray(body.entry) ? body.entry : [body.entry];
    if (entries.length !== files.length || new Set(entries).size !== entries.length)
      throw new BadRequestException('Каждый файл должен соответствовать отдельной записи.');
    const uploads = [];
    for (const [index, f] of files.entries()) {
      fileRequired(f);
      const row = data.rows.find((r) => r.id === entries[index]);
      if (!row || !acceptsOriginal(row.kind))
        throw new BadRequestException('Выберите запись для файла.');
      const name = safeFilename(f.originalname);
      if (row.kind === 'template') {
        await templateFile(f.buffer);
        if (!/\.docx$/i.test(name)) throw new BadRequestException('Шаблон должен быть в формате DOCX.');
        delete row.v.needsFile;
      }
      row.file = name;
      uploads.push({ entry: row.id, name, data: f.buffer });
    }
    const saved = await this.store.save(id, expected, data, uploads);
    return filesOnly ? { version: saved.version } : saved;
  }
  @Get(':id/file/:entry')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entry', ParseUUIDPipe) entry: string,
    @Res() res: express.Response,
  ) {
    const project = await this.store.get(id),
      row = project.rows.find((r) => r.id === entry);
    if (!row) throw new BadRequestException('Запись не найдена.');
    if (row.kind === 'template' && !row.file && Object.hasOwn(formTypes, row.v.form)) {
      return download(res, row.v.name + '.docx', await baseForm(row.v.form));
    }
    const a = await this.store.asset(id, entry, project.version);
    download(res, a.name, a.data);
  }
  @Get(':id/incoming/:template')
  async incoming(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('template', ParseUUIDPipe) template: string,
    @Res() res: express.Response,
  ) {
    const project = await this.store.get(id);
    const archive = await incomingReport(project, template, (entry) =>
      this.store.asset(id, entry, project.version),
    );
    download(res, archive.name, archive.data);
  }
  @Post(':id/report')
  async export(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Res() res: express.Response) {
    const params = z
      .object({
        pack: z.uuid(),
        selected: z.array(z.uuid()).max(5000).default([]),
      })
      .safeParse(body);
    if (!params.success) throw new BadRequestException('Выберите комплект и его состав.');
    const p = await this.store.get(id),
      { pack, selected } = params.data;
    const archive = await report(p, pack, selected, (entry) => this.store.asset(id, entry, p.version));
    const directory = await mkdtemp(path.join(tmpdir(), 'project-export-'));
    try {
      const file = path.join(directory, 'package.zip');
      await pipeline(archive.zip.generateNodeStream({ streamFiles: true, compression: 'DEFLATE' }), createWriteStream(file));
      await new Promise<void>((resolve, reject) => {
        res.download(file, safeFilename(archive.name), error => error ? reject(error) : resolve());
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
@Module({})
class ConstructionModule {}
export function projectApi(store: ProjectStore): express.RequestHandler {
  const child = express();
  let initialized: Promise<void> | undefined;
  async function start() {
    const app = await NestFactory.create(
      {
        module: ConstructionModule,
        controllers: [ProjectsController],
        providers: [{ provide: ProjectStore, useValue: store }],
      },
      new ExpressAdapter(child),
      { logger: false, bodyParser: false, abortOnError: false },
    );
    await app.init();
  }
  return (req, res, next) => {
    initialized ??= start().catch((e) => {
      initialized = undefined;
      throw e;
    });
    void initialized.then(() => child(req, res, next), next);
  };
}
