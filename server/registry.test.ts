import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { comparisonLayout, preparePageImage } from './scan.js';
import { locate, fieldLines } from '../shared/scan.js';
import supertest from 'supertest';
import { createApp } from './app.js';
import type { ConversionStore } from './history.js';
import { RegistryQueue, excelDate, registryRows } from './registry.js';

test.mock.method(globalThis, 'fetch', async (url: string) => {
  assert.equal(url, 'https://openrouter.ai/api/v1/models');
  const data = ['test/pages', 'test/crop'].map(id => ({
    id, reasoning: { supported_efforts: ['low', 'none'], mandatory: false },
  }));
  return Response.json({ data });
});

async function waitForJob(queue: RegistryQueue, id: string) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const job = queue.get(id);
    assert.ok(job);
    if (job.status === 'done' || job.status === 'error') return job;
    await delay(100);
  }
  assert.fail('Timed out waiting for registry job ' + id + ': ' + queue.get(id)?.status);
}

test('straightens a sideways scan before OCR and model input', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'registry-orientation-test-'));
  try {
    const prefix = path.join(directory, 'original');
    execFileSync('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-scale-to', '2200', '-jpeg', path.resolve('server/fixtures/scanned-two-pages.pdf'), prefix]);
    const sideways = path.join(directory, 'sideways.jpg');
    await sharp(`${prefix}.jpg`).rotate(90).jpeg().toFile(sideways);
    const prepared = await preparePageImage(sideways);
    const metadata = await sharp(sideways).metadata();
    assert.ok(metadata.height! > metadata.width!);
    assert.equal(prepared.ocrStatus, 'pending');
    assert.deepEqual(prepared.words, []);
    assert.deepEqual([prepared.width, prepared.height], [metadata.width, metadata.height]);
    const scan = { image: sideways, layout: path.join(directory, 'layout.json') };
    await writeFile(scan.layout, JSON.stringify(prepared));
    let saves = 0;
    const save = async (text: string) => { saves++; assert.match(text, /Materials register/); };
    const first = await comparisonLayout(scan, { poll: true }, save);
    assert.equal(first.ocrStatus, 'pending');
    const { words } = await comparisonLayout(scan, {}, save);
    await rm(sideways); // Subsequent opens must use the persisted words.
    assert.deepEqual((await comparisonLayout(scan, {}, save)).words, words);
    assert.equal(saves, 1);
    assert.ok(words.every(w => w.x >= 0 && w.y >= 0 && w.x + w.w <= metadata.width && w.y + w.h <= metadata.height));
    const range = locate(words, 'Materials register');
    assert.ok(range);
    const title = words.slice(range[0], range[1] + 1);
    assert.equal(fieldLines(title, 'Реестр материалов')[0].text, 'Реестр материалов');
    assert.equal(locate([...title, ...title], 'Materials register'), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reuses legacy coordinates and retries failed comparison OCR only on request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'registry-layout-test-'));
  const scan = { image: path.join(dir, 'page.jpg'), layout: path.join(dir, 'layout.json') };
  const save = async () => { assert.fail('No text expected from an empty page'); };
  try {
    const geometry = { width: 100, height: 100, rotation: 0 };
    const old = { ...geometry, words: [{ x: 0, y: 0, w: 10, h: 10, line: '1', text: 'Page' }] };
    await writeFile(scan.layout, JSON.stringify(old));
    assert.deepEqual(await comparisonLayout(scan, {}, save), old);
    await writeFile(scan.layout, JSON.stringify({ ...geometry, words: [] }));
    assert.equal((await comparisonLayout(scan, {}, save)).ocrStatus, 'failed');
    await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).jpeg().toFile(scan.image);
    assert.equal((await comparisonLayout(scan, {}, save)).ocrStatus, 'failed');
    const blank = await comparisonLayout(scan, { retry: true }, save);
    assert.equal(blank.ocrStatus, 'ready');
    assert.deepEqual(blank.words, []);
    await rm(scan.image);
    assert.deepEqual(await comparisonLayout(scan, {}, save), blank);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('separates an act from its appendix and fills appendix metadata from the act', () => {
  const rows = registryRows([
    { blank: false, continuesPrevious: false, documents: [{ name: 'Акт. Устройство крепления наружных стен', number: '№ 1.1/АР3/С1/24', date: '09.02.2026', organization: 'ООО «ЗЕТТА»', uncertain: false }] },
    { blank: false, continuesPrevious: true, documents: [] },
    { blank: false, continuesPrevious: true, documents: [{ name: 'Реестр документов', number: 'Приложение № 1', date: '', organization: '', uncertain: true, attachmentOfPrevious: true }] },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].first, rows[0].last], [1, 2]);
  assert.deepEqual([rows[1].first, rows[1].last], [3, 3]);
  assert.equal(rows[1].number, 'Приложение № 1');
  assert.equal(rows[1].date, '09.02.2026');
  assert.equal(rows[1].organization, 'ООО «ЗЕТТА»');
});

test('review follows unreadable fields across pages and ignores blanks and legacy blanket flags', () => {
  const doc = { name: 'Акт', number: '', date: '', organization: '', uncertain: true };
  const start = { blank: false, continuesPrevious: false, documents: [doc] };
  assert.deepEqual(registryRows([start])[0].reviewFields, []);
  const first = { ...start, documents: [{ ...doc, reviewFields: ['number', 'organization'] as ('number' | 'organization')[] }] };
  const tail = { blank: false, continuesPrevious: true, documents: [], continuation: { number: '11', date: '12.11.2026', organization: '' } };
  const [row] = registryRows([first, tail]);
  assert.deepEqual(row.reviewFields, ['organization']);
  assert.equal(row.uncertain, true);
  assert.equal(registryRows([first, { ...tail, continuation: { ...tail.continuation, organization: 'ООО Строй' } }])[0].uncertain, false);
  assert.deepEqual(registryRows([{ ...start, documents: [{ ...doc, name: 'Паспорт — [неразборчиво]' }] }])[0].reviewFields, ['name']);
  assert.deepEqual(registryRows([{ ...start, documents: [] }])[0].reviewFields, ['name']);
  const [confident] = registryRows([{...start, documents: [{...doc, number:'25'}]}, {...tail, continuation: {...tail.continuation, number:'2?', reviewFields:['number']}}]);
  assert.equal(confident.number, '25');
  assert.deepEqual(confident.reviewFields, []);
});

test('normalizes clear document dates without changing date ranges', () => {
  for (const value of ['09.02.2026', '2026-02-09', '09 февраля 2026 г.']) {
    assert.equal((excelDate(value) as Date).toISOString().slice(0, 10), '2026-02-09');
  }
  assert.equal(excelDate('с 23.07.2025 по 22.07.2028'), 'с 23.07.2025 по 22.07.2028');
});

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
      ? { blank: false, continuesPrevious: false, continuation: { number: '', date: '', organization: '' }, documents: [{ name: 'Паспорт изделия', number: 'ЕАЭС RU C-RU.001', date: '', organization: 'ООО Строй', reviewFields: ['organization'] }] }
      : { blank: false, continuesPrevious: true, continuation: { number: '059880', date: '26.03.2026', organization: 'ООО Гладиум', reviewFields: ['organization'] }, documents: [] };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }), { status: 200 });
  };
  try {
    const queue = new RegistryQueue({ directory, apiKey: 'test', model: 'test', fetcher: fetcher as typeof fetch });
    const created = await queue.create(source, 'Скан.pdf');
    assert.equal(created.pages, 2);
    const job = await waitForJob(queue, created.id);
    assert.equal(job?.status, 'done', job?.error);
    assert.equal(job.recordCount, 1);
    assert.equal(job.processedPages, 2);
    assert.equal(requests, 2);
    const dir = path.dirname(queue.sourcePath(created.id));
    const pdf = await PDFDocument.load(await readFile(path.join(dir, 'documents/0.pdf')));
    const geometry = JSON.parse(await readFile(path.join(dir, 'scans/1.json'),'utf8'));
    assert.equal(geometry.ocrStatus, 'pending');
    assert.deepEqual(geometry.words, []);
    const original = await PDFDocument.load(await readFile(fixture));
    assert.equal(pdf.getPageCount(), original.getPageCount());
    for (const [index, page] of pdf.getPages().entries()) {
      assert.ok(Math.abs(page.getWidth() - original.getPage(index).getWidth()) < 0.001);
      assert.ok(Math.abs(page.getHeight() - original.getPage(index).getHeight()) < 0.001);
    }
    assert.equal(pdf.getTitle(), 'Паспорт изделия');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await readFile(queue.resultPath(created.id)));
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell('A8').value, 1);
    assert.equal(sheet.getCell('B8').value, 'Паспорт изделия');
    assert.equal(sheet.getCell('C8').value, '059880');
    assert.ok(sheet.getCell('D8').value instanceof Date);
    assert.equal(sheet.getCell('D8').numFmt, 'dd.mm.yyyy');
    assert.equal(sheet.getCell('E8').value, 'ООО Гладиум');
    assert.equal((sheet.getCell('E8').fill as ExcelJS.FillPattern).fgColor?.argb, 'FFFFF0C2');
    for (const col of ['B', 'C', 'D']) assert.notEqual((sheet.getCell(col+'8').fill as ExcelJS.FillPattern)?.fgColor?.argb, 'FFFFF0C2');
    assert.equal(sheet.getCell('F8').value, 2);
    assert.equal(sheet.getCell('G8').value, 1);
    assert.equal(sheet.getCell('I8').value, 2);
    assert.equal(sheet.getCell('B3').font.color?.argb, 'FFFF0000');
    assert.equal(sheet.getCell('B8').font.name, 'Aptos Narrow');
    assert.equal(sheet.getCell('B8').font.size, 12);
    assert.equal(sheet.getCell('A7').fill.type, 'pattern');
    assert.equal(sheet.getRow(1).height, 98.25);
    assert.ok(Math.abs(sheet.getColumn(2).width! - 71.14) < 0.02);
    assert.equal(sheet.getCell('H8').value, '-');
    const restarted = new RegistryQueue({ directory, apiKey: 'test', model: 'test', fetcher: fetcher as typeof fetch });
    await restarted.ready;
    assert.equal(restarted.get(created.id)?.status, 'done');
    assert.equal(requests, 2);
    const recreated = await restarted.reprocess(created.id);
    assert.notEqual(recreated.id, created.id);
    await waitForJob(restarted, recreated.id);
    assert.equal(restarted.get(recreated.id)?.status, 'done');
    assert.equal(requests, 4);
    assert.equal(restarted.get(created.id)?.status, 'done');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('restores four PDFs at a time and refills the free slot after errors and successes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'registry-concurrency-'));
  const names = ['slow-a', 'slow-b', 'slow-c', 'failed', 'fifth', 'sixth'];
  const ids = names.map(() => randomUUID());
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = await pdf.save();
  const slow = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  const calls: string[] = [];
  let limited = false;
  const fetcher: typeof fetch = async (_url, init) => {
    const { model } = JSON.parse(String(init?.body));
    calls.push(model);
    if (model.startsWith('slow-')) await slow.promise;
    if (model === 'failed') {
      await failed.promise;
      return new Response(null, { status: 402 });
    }
    if (model === 'fifth' && !limited) {
      limited = true;
      return new Response(null, { status: 429 });
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content:
      JSON.stringify({ blank: true, continuesPrevious: false, documents: [] }) } }] });
  };

  let queue: RegistryQueue | undefined;
  try {
    for (const [i, id] of ids.entries()) {
      const dir = path.join(directory, 'registry-jobs', id);
      await mkdir(path.join(dir, 'pages'), { recursive: true });
      await writeFile(path.join(dir, 'source.pdf'), bytes);
      await writeFile(path.join(dir, 'job.json'), JSON.stringify({
        id, originalName: names[i] + '.pdf', resultName: names[i] + '.xlsx',
        models: { recognition: names[i], regions: names[i] }, pages: 1, processedPages: 0, recordCount: 0,
        createdAt: new Date(1000 * i).toISOString(), status: i === 0 ? 'working' : 'queued',
      }));
    }
    const restored = queue = new RegistryQueue({ directory, apiKey: 'test', model: 'test', fetcher });
    await restored.ready;
    await t.waitFor(() => assert.ok(calls.length >= 4), { timeout: 30_000 });
    assert.deepEqual([...calls].sort(), ['failed', 'slow-a', 'slow-b', 'slow-c']);
    assert.deepEqual(ids.map(id => restored.get(id)?.status), ['working', 'working', 'working', 'working', 'queued', 'queued']);
    failed.resolve();
    assert.equal((await waitForJob(restored, ids[5])).status, 'done');
    assert.deepEqual(ids.map(id => restored.get(id)?.status), ['working', 'working', 'working', 'error', 'done', 'done']);
    assert.deepEqual(calls.slice(4), ['fifth', 'fifth', 'sixth']);
    slow.resolve();
    for (const id of ids.slice(0, 3)) assert.equal((await waitForJob(restored, id)).status, 'done');
    assert.equal(restored.stats().modelRequests, 7);
    assert.equal(restored.stats().rateLimitedRequests, 1);
  } finally {
    slow.resolve();
    failed.resolve();
    if (queue) await Promise.all(ids.map(id => waitForJob(queue!, id)));
    await rm(directory, { recursive: true, force: true });
  }
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
    assert.equal(Object.hasOwn(payload, 'max_tokens'), false);
    if (page === 2 && failSecondPage) return new Response('', { status: 402 });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ blank: page === 2, continuesPrevious: false,
      documents: page === 1 ? [{ name: 'Акт', number: '1', date: '', organization: '', uncertain: true }] : [] }) } }] });
  }) as typeof fetch;
  try {
    const queue = new RegistryQueue({ directory, apiKey: 'test', model: 'test', fetcher });
    const created = await queue.create(source, 'Скан.pdf');
    await waitForJob(queue, created.id);
    assert.equal(queue.get(created.id)?.status, 'error');
    assert.equal(queue.get(created.id)?.processedPages, 1);
    failSecondPage = false;
    await queue.retry(created.id);
    await waitForJob(queue, created.id);
    assert.equal(queue.get(created.id)?.status, 'done');
    assert.deepEqual(seen, [1, 2, 2]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('accepts a large scanned PDF and serves the resulting workbook', async () => {
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
    const job = await waitForJob(queue, response.body.job.id);
    assert.equal(job?.status, 'done', job?.error);
    const result = await supertest(app).get(`/api/registry/${job.id}/result`);
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /spreadsheetml/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reads individual cropped regions, isolates documents sharing a page and retries failed crops independently', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'registry-regions-'));
  const source = path.join(directory, 'input.pdf');
  const doc = {name:'Сертификат', number:'42', date:'', organization:'', reviewFields:[]};
  const seal = {kind:'seal',left:100,top:300,right:300,bottom:450};
  const secondSeal = {...seal,left:600,right:800};
  const stamp = {...seal,kind:'stamp',top:460,bottom:520};
  const detected = [{...seal,document:0},{...secondSeal,document:0},{...stamp,document:1}];
  let pageCalls = 0, cropCalls = 0, failStamp = true;
  const firstPair = Promise.withResolvers<void>();
  let activeReads = 0, peakReads = 0;
  const inputs: string[] = [];
  const initial = {recognition:'test/pages',chat:'test/chat',regions:'test/crop'};
  const alternate = {recognition:'test/pages-next',chat:'test/chat-next',regions:'test/crop-next:free'};
  let queue: RegistryQueue;
  const fetcher: typeof fetch = async (_url,init) => {
    const body = JSON.parse(String(init?.body));
    let data;
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    if (body.response_format.json_schema.name === 'registry_page') {
      pageCalls++;
      assert.equal(body.model,initial.recognition);
      if (pageCalls === 1) await queue.models.save(alternate);
      data = {blank:pageCalls===2,continuesPrevious:false,documents:pageCalls===1?[doc,doc]:[],
        regions:pageCalls===1?[...detected,detected[0],{...seal,document:999},{...seal,document:0,right:-5}]:[]};
    } else {
      cropCalls++;
      assert.equal(body.model,cropCalls === 6 ? alternate.regions : initial.regions);
      assert.equal(body.reasoning?.effort, body.model === initial.regions ? 'none' : undefined);
      activeReads++;
      peakReads = Math.max(peakReads, activeReads);
      if (activeReads === 2) firstPair.resolve();
      await firstPair.promise;
      const content = body.messages[1].content;
      assert.equal(content.length,1);
      inputs.push(content[0].image_url.url);
      const bytes = Buffer.from(content[0].image_url.url.split(',')[1],'base64');
      const meta = await sharp(bytes).metadata();
      assert.equal(meta.format,'png');
      activeReads--;
      if (failStamp && body.messages[0].content.includes('stamp imprint')) return Response.json({error:{metadata:{limit_source:'openrouter_key_limit'}}},{status:402});
      data = {status:'partial',text:'ООО [неразборчиво]'};
    }
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}]});
  };
  try {
    await copyFile(path.resolve('server/fixtures/scanned-two-pages.pdf'),source);
    queue = new RegistryQueue({directory,model:'page-model',regionModel:'crop-model',apiKey:'test',fetcher});
    await queue.models.save(initial);
    const job = await queue.create(source,'Том.pdf');
    await waitForJob(queue, job.id);
    assert.equal(queue.get(job.id)?.status,'done',queue.get(job.id)?.error);
    assert.equal(pageCalls,2);
    assert.equal(cropCalls,3);
    assert.equal(peakReads,2);
    const app = createApp({historyStore:{catalogFiles:async()=>[],indexFile:async()=>{},indexPageText:async()=>{}} as unknown as ConversionStore,registryQueue:queue,model:'page-model',regionModel:'crop-model',apiKey:'test',production:false,password:'',sessionSecret:''},fetcher);
    const base='/api/registry/'+job.id+'/documents/';
    const {body:layout}=await supertest(app).get(base+'0/layout?page=1').expect(200);
    assert.equal(layout.regions.length,2);
    assert.notEqual(layout.regions[0].id,layout.regions[1].id);
    assert.equal(layout.regions[0].text,'ООО [неразборчиво]');
    const png = await supertest(app).get(base+'0/image?page=1&region='+layout.regions[0].id).expect(200);
    const meta = await sharp(png.body).metadata();
    assert.ok(inputs.includes('data:image/png;base64,' + png.body.toString('base64')));
    assert.deepEqual([meta.width,meta.height],[Math.ceil(layout.width*2*.33)-Math.floor(layout.width*2*.07),Math.ceil(layout.height*2*.473)-Math.floor(layout.height*2*.277)]);
    const failedRegion = (await supertest(app).get(base+'1/layout?page=1')).body.regions[0];
    assert.equal(failedRegion.status,'error');
    assert.match(failedRegion.errorReason, /лимиту API-ключа/);
    await supertest(app).post(base+'0/regions?page=2').send(seal).expect(404);
    await supertest(app).post(base+'0/regions?page=1').send({...seal,right:50}).expect(400);
    await queue.models.save(initial);
    failStamp=false;
    const retry=await supertest(app).post(base+'1/regions?page=1').send(stamp).expect(200);
    assert.equal(retry.body.region.status,'partial');
    assert.equal(retry.body.region.source,'auto');
    const manual={...stamp,kind:'handwriting'};
    const [a,b]=await Promise.all([1,2].map(()=>supertest(app).post(base+'1/regions?page=1').send(manual).expect(200)));
    assert.equal(a.body.region.id,b.body.region.id);
    assert.equal(a.body.region.source,'manual');
    assert.equal(cropCalls,5);
    assert.equal((await supertest(app).get(base+'1/layout?page=1')).body.regions.length,2);
    await supertest(app).post(base+'1/regions?page=1').send(manual).expect(200);
    assert.equal(cropCalls,5);
    await supertest(app).put('/api/settings/models').send(alternate).expect(200);
    const switched = await supertest(app).post(base+'1/regions?page=1').send(manual).expect(200);
    assert.equal(switched.body.region.model,alternate.regions);
    assert.equal(switched.body.region.previous[0].model,initial.regions);
    assert.equal(inputs[4],inputs[5]);
    await supertest(app).put('/api/settings/models').send(initial).expect(200);
    const cached = await supertest(app).post(base+'1/regions?page=1').send(manual).expect(200);
    assert.equal(cached.body.region.model,initial.regions);
    assert.equal(cached.body.region.previous[0].model,alternate.regions);
    assert.equal(cropCalls,6);

    // A pre-padding archive can be viewed as-is and upgraded by retrying the same box and model.
    const old = layout.regions[0];
    const prefix = path.join(directory, 'registry-jobs', job.id, 'regions', '1', '0', old.id);
    delete old.cropVersion;
    await writeFile(prefix + '.json', JSON.stringify(old));
    const oldPng = await sharp(png.body).resize(20, 20).png().toBuffer();
    await writeFile(prefix + '.png', oldPng);
    await rm(prefix + '.padded.png');
    const preview = () => supertest(app).get(base+'0/image?page=1&region='+old.id).expect(200);
    assert.deepEqual((await preview()).body, oldPng);
    const refreshed = await supertest(app).post(base+'0/regions?page=1').send(seal).expect(200);
    assert.equal(refreshed.body.region.id, old.id);
    assert.equal(refreshed.body.region.cropVersion, 2);
    assert.deepEqual((await preview()).body, png.body);
    const edge = {...seal,left:0,top:0,right:100,bottom:100};
    const clipped = await supertest(app).post(base+'0/regions?page=1').send(edge).expect(200);
    assert.equal(clipped.body.region.status,'partial');
    const edgeMeta = await sharp(Buffer.from(inputs.at(-1)!.split(',')[1],'base64')).metadata();
    assert.deepEqual([edgeMeta.width,edgeMeta.height],[Math.ceil(layout.width*2*.115),Math.ceil(layout.height*2*.115)]);
    assert.equal(cropCalls,8);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
