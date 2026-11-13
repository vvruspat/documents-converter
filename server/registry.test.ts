import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import supertest from 'supertest';
import { createApp } from './app.js';
import type { ConversionStore } from './history.js';
import { RegistryQueue } from './registry.js';

test('creates a register from scanned PDF pages and persists the completed result', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'registry-test-'));
  const source = path.join(directory, 'upload.pdf');
  const fixture = path.resolve('server/fixtures/scanned-two-pages.pdf');
  await copyFile(fixture, source);
  let requests = 0;
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    requests++;
    const payload = JSON.parse(String(init?.body));
    const page = Number(payload.messages[1].content[0].text.match(/PDF page (\d+)/)[1]);
    const data = page === 1
      ? { blank: false, continuesPrevious: false, documents: [{ name: 'Акт освидетельствования', number: '01-01', date: '12.05.2026', organization: 'ООО Строй', uncertain: false }] }
      : { blank: false, continuesPrevious: true, documents: [] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }), { status: 200 });
  };
  try {
    const queue = new RegistryQueue({ directory, apiKey: 'test', model: 'test', fetcher: fetcher as typeof fetch });
    const created = await queue.create(source, 'Скан.pdf');
    assert.equal(created.pages, 2);
    let job = queue.get(created.id);
    for (let attempt = 0; attempt < 100 && job?.status !== 'done' && job?.status !== 'error'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      job = queue.get(created.id);
    }
    assert.equal(job?.status, 'done', job?.error);
    assert.equal(job.recordCount, 1);
    assert.equal(job.processedPages, 2);
    assert.equal(requests, 2);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await readFile(queue.resultPath(created.id)));
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell('A8').value, 1);
    assert.equal(sheet.getCell('B8').value, 'Акт освидетельствования');
    assert.equal(sheet.getCell('C8').value, '01-01');
    assert.ok(sheet.getCell('D8').value instanceof Date);
    assert.equal(sheet.getCell('D8').numFmt, 'dd.mm.yyyy');
    assert.equal(sheet.getCell('F8').value, 2);
    assert.equal(sheet.getCell('G8').value, 1);
    assert.equal(sheet.getCell('I8').value, 2);
    const restarted = new RegistryQueue({ directory, apiKey: 'test', model: 'test', fetcher: fetcher as typeof fetch });
    await restarted.ready;
    assert.equal(restarted.get(created.id)?.status, 'done');
    assert.equal(requests, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('retry keeps recognized pages and continues after an upstream error', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'registry-retry-test-'));
  const source = path.join(directory, 'upload.pdf');
  await copyFile(path.resolve('server/fixtures/scanned-two-pages.pdf'), source);
  const seen: number[] = [];
  let failSecondPage = true;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    const page = Number(payload.messages[1].content[0].text.match(/PDF page (\d+)/)[1]);
    seen.push(page);
    if (page === 2 && failSecondPage) return new Response('', { status: 402 });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ blank: page === 2, continuesPrevious: false,
      documents: page === 1 ? [{ name: 'Акт', number: '1', date: '', organization: '', uncertain: true }] : [] }) } }] });
  }) as typeof fetch;
  try {
    const queue = new RegistryQueue({ directory, apiKey: 'test', model: 'test', fetcher });
    const created = await queue.create(source, 'Скан.pdf');
    for (let attempt = 0; attempt < 100 && queue.get(created.id)?.status !== 'error'; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(queue.get(created.id)?.status, 'error');
    assert.equal(queue.get(created.id)?.processedPages, 1);
    failSecondPage = false;
    await queue.retry(created.id);
    for (let attempt = 0; attempt < 100 && queue.get(created.id)?.status !== 'done'; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(queue.get(created.id)?.status, 'done');
    assert.deepEqual(seen, [1, 2, 2]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('accepts a PDF larger than the ordinary converter limit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'registry-upload-test-'));
  try {
    const queue = new RegistryQueue({ directory, apiKey: 'test', model: 'test', fetcher: (async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ blank: true, continuesPrevious: false, documents: [] }) } }] }), { status: 200 })) as typeof fetch });
    const app = createApp({ apiKey: 'test', model: 'test', password: '', sessionSecret: '', production: false, historyStore: {} as ConversionStore, registryQueue: queue });
    const fixture = await readFile(path.resolve('server/fixtures/scanned-two-pages.pdf'));
    const source = path.join(directory, 'large.pdf');
    await writeFile(source, Buffer.concat([fixture, Buffer.alloc(13 * 1024 * 1024)]));
    const response = await supertest(app).post('/api/registry').attach('pdf', source);
    assert.equal(response.status, 202, response.text);
    assert.equal(response.body.job.pages, 2);
    let job = queue.get(response.body.job.id);
    for (let attempt = 0; attempt < 100 && job?.status !== 'done' && job?.status !== 'error'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      job = queue.get(response.body.job.id);
    }
    assert.equal(job?.status, 'done', job?.error);
    const result = await supertest(app).get(`/api/registry/${job.id}/result`);
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /spreadsheetml/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
