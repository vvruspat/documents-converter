import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import sharp from 'sharp';
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { PDFDocument } from 'pdf-lib';
import { createApp, type AppConfig } from './app.js';
import { createSession, passwordMatches, validSession } from './auth.js';
import { cellValue, exportExcel } from './excel.js';
import { parseDocument, recognizeImage, recognizePdf, validatePdf, normalizeImage } from './recognize.js';
import { documentSchema, exportSchema, type ExtractedDocument } from '../shared/document.js';
import { ConversionStore, safeFilename, type StoreOptions } from './history.js';

test.mock.method(globalThis, 'fetch', async (url: string) => {
  assert.equal(url, 'https://openrouter.ai/api/v1/models');
  const data = ['test/reader', 'test/detail', 'test/archive'].map(id => ({
    id, reasoning: { supported_efforts: ['low', 'none'], mandatory: false },
  }));
  return Response.json({ data });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a PostgreSQL test database before running tests.');
const database = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000 });
const schemas: string[] = [], directories: string[] = [];
const openStores = new Set<ConversionStore>();
async function options(): Promise<StoreOptions> {
  const schema = `dc_test_${randomUUID().replaceAll('-', '')}`;
  await database.query(`CREATE SCHEMA "${schema}"`); schemas.push(schema);
  const directory = path.join(mkdtempSync(path.join(tmpdir(), 'documents-converter-test-')), '.local', 'data');
  directories.push(path.resolve(directory, '../..'));
  return { directory, schema, connectionString: databaseUrl! };
}
async function openStore(value: StoreOptions): Promise<ConversionStore> {
  const store = new ConversionStore(value); openStores.add(store); await store.ready(); return store;
}
async function closeStore(store: ConversionStore): Promise<void> { if (openStores.delete(store)) await store.close(); }
after(async () => {
  await Promise.all([...openStores].map(closeStore));
  for (const schema of schemas) await database.query(`DROP SCHEMA "${schema}" CASCADE`);
  await database.end();
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
});
const sharedOptions = await options();
const sharedStore = await openStore(sharedOptions);
const config: AppConfig = { apiKey: 'server-only-test-key', model: 'test/vision', password: 'a-test-password', sessionSecret: 'a-test-session-secret-with-32-characters', production: false, dataDir: sharedOptions.directory, historyStore: sharedStore };
const fixture: ExtractedDocument = {
  title: 'Реестр', context: ['Приложение №1'], warnings: [],
  tables: [{ title: 'Материалы', columns: ['№', 'Материал', 'Документ', 'Дата', 'Листов'], rows: [['1', 'Бетон', '000007900', '08.10.2025', '1'], ['2', '=HYPERLINK("https://example.com")', '000007909', '31.02.2025', '2']], uncertainCells: [{ row: 1, column: 3, note: 'Проверьте дату' }] }],
};
const cookie = () => `dc_session=${createSession(config.sessionSecret, config.password)}`;
const image = () => sharp({ create: { width: 100, height: 120, channels: 3, background: '#fff' } }).jpeg().toBuffer();
const mock = ((async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(fixture) } }] })) as typeof fetch);

test('signed sessions reject forgery, expiration and password changes', () => {
  const now = Date.now(); const token = createSession(config.sessionSecret, config.password, now);
  assert.ok(validSession(token, config.sessionSecret, config.password, now + 100));
  assert.equal(validSession(token.slice(0, -1) + 'z', config.sessionSecret, config.password, now), false);
  assert.equal(validSession(token, config.sessionSecret, 'changed-password', now), false);
  assert.equal(validSession(token, config.sessionSecret, config.password, now + 86_400_001), false);
  assert.equal(validSession({}, config.sessionSecret, config.password), false);
  assert.ok(passwordMatches('abc', 'abc')); assert.equal(passwordMatches('abc', 'abcd'), false);
});
test('production requires authentication and permits a six-character password', async () => {
  assert.throws(() => createApp({ ...config, production: true, password: '' }), /APP_PASSWORD/);
  assert.throws(() => createApp({ ...config, production: true, password: 'abc12' }), /APP_PASSWORD/);
  assert.throws(() => createApp({ ...config, production: true, password: 'abc123', sessionSecret: '' }), /SESSION_SECRET/);
  assert.throws(() => createApp({ ...config, production: true, historyStore: undefined, databaseUrl: '' }), /DATABASE_URL/);
  const app = createApp({ ...config, production: true, password: 'abc123' });
  await request(app).post('/api/login').send({ password: 'abc123' }).expect(200);
});
test('recognition validates all rows and uncertainty coordinates', () => {
  assert.deepEqual(parseDocument(JSON.stringify(fixture)), fixture);
  assert.deepEqual(parseDocument('```json\n' + JSON.stringify(fixture) + '\n```'), fixture);
  assert.throws(() => parseDocument('{"tables":['), /неполную/);
  const incomplete = structuredClone(fixture); incomplete.tables[0].rows[0].pop();
  assert.equal(documentSchema.safeParse(incomplete).success, false);
  const wrongCoordinates = structuredClone(fixture); wrongCoordinates.tables[0].uncertainCells[0].row = 400;
  assert.equal(documentSchema.safeParse(wrongCoordinates).success, false);
});
test('images are decoded, normalized and unsupported formats rejected', async () => {
  const normalized = await normalizeImage(await image());
  assert.equal((await sharp(normalized).metadata()).format, 'jpeg');
  await assert.rejects(normalizeImage(Buffer.from('this is not a photo')), /прочитать изображение/);
  await assert.rejects(normalizeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')), /прочитать изображение/);
});
test('OpenRouter request uses vision, strict schema and treats document instructions as data', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer server-only-test-key');
    const body = JSON.parse(init!.body as string);
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    assert.match(body.messages[0].content, /untrusted source material/);
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.provider.require_parameters, true);
    assert.equal(body.model, 'test/vision');
    return mock(url, init);
  };
  assert.deepEqual(await recognizeImage(await image(), config.apiKey, config.model, fetcher), fixture);
  assert.equal(calls, 1);
});
test('failed or truncated upstream responses never become successful tables or expose provider bodies', async () => {
  await assert.rejects(recognizeImage(Buffer.from('x'), config.apiKey, config.model, async () => new Response('secret upstream details', { status: 402 })), /балансе/);
  await assert.rejects(recognizeImage(Buffer.from('x'), config.apiKey, config.model, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(fixture) } }] })), /обрезан/);
  await assert.rejects(recognizeImage(Buffer.from('x'), config.apiKey, config.model, async () => { throw new Error('secret-key'); }), error => error instanceof Error && !error.message.includes('secret-key'));
});
test('Excel retains identifiers and literal formulas while making valid dates and counts usable', async () => {
  const buffer = await exportExcel({ documents: [{ name: 'doc.jpg', document: fixture }] });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
  const sheet = book.worksheets[0];
  const header = [...Array(sheet.rowCount)].map((_, i) => i + 1).find(i => sheet.getCell(i, 1).value === '№')!;
  assert.equal(sheet.getCell(header + 1, 1).value, 1);
  assert.equal(sheet.getCell(header + 1, 3).value, '000007900');
  assert.ok(sheet.getCell(header + 1, 4).value instanceof Date);
  assert.equal(sheet.getCell(header + 1, 4).numFmt, 'dd.mm.yyyy');
  assert.equal(sheet.getCell(header + 2, 2).value, '=HYPERLINK("https://example.com")');
  assert.equal(sheet.getCell(header + 2, 2).type, ExcelJS.ValueType.String);
  assert.equal(sheet.getCell(header + 2, 4).value, '31.02.2025');
  assert.ok(sheet.getCell(header + 2, 4).note);
  assert.equal(cellValue('0009'), '0009'); assert.equal(cellValue('1234567890123456'), '1234567890123456');
  assert.equal(cellValue('12,50'), 12.5); assert.equal(cellValue('+cmd'), '+cmd'); assert.equal(cellValue('1e5'), '1e5');
});
test('sheet names are unique, valid and limited to 31 characters', async () => {
  const document = structuredClone(fixture); document.tables[0].title = 'A:/?*[]'.repeat(9);
  const buffer = await exportExcel({ documents: [{ name: '1', document }, { name: '2', document }] });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer);
  assert.equal(book.worksheets.length, 2);
  assert.notEqual(book.worksheets[0].name, book.worksheets[1].name);
  book.worksheets.forEach(s => { assert.ok(s.name.length <= 31); assert.doesNotMatch(s.name, /[\\/*?:\[\]]/); });
  assert.equal(exportSchema.safeParse({ documents: [{ name: 'a', document: { ...fixture, tables: [] } }] }).success, false);
});
test('API authorizes conversion and export before reading uploads', async () => {
  const app = createApp(config, mock);
  await request(app).post('/api/recognize').expect(401);
  await request(app).post('/api/export').send({ documents: [] }).expect(401);
  await request(app).get('/api/history').expect(401);
  await request(app).get('/api/history/00000000-0000-4000-8000-000000000000/source').expect(401);
  await request(app).delete('/api/history/00000000-0000-4000-8000-000000000000').expect(401);
  const session = await request(app).get('/api/session').expect(200); assert.equal(session.body.authenticated, false);
  const health = await request(app).get('/api/health').expect(200); assert.equal(health.body.status, 'ok');
});
test('login protects the key and uses an HttpOnly cookie', async () => {
  const app = createApp(config, mock); const agent = request.agent(app);
  await agent.post('/api/login').send({ password: 'wrong' }).expect(401);
  const login = await agent.post('/api/login').send({ password: config.password }).expect(200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /SameSite=Strict/);
  const result = await agent.get('/api/config').expect(200); assert.equal(result.body.configured, true);
  assert.ok(!JSON.stringify(result.body).includes(config.apiKey));
  await agent.post('/api/logout').expect(200); await agent.get('/api/config').expect(401);
});
test('same-origin browser requests are required and unsupported uploads rejected', async () => {
  const app = createApp(config, mock);
  await request(app).post('/api/export').set('Cookie', cookie()).set('Origin', 'https://attacker.example').send({ documents: [] }).expect(403);
  await request(app).delete('/api/history/00000000-0000-4000-8000-000000000000').set('Cookie', cookie()).set('Origin', 'http://127.0.0.1:5173').expect(404);
  const productionApp = createApp({ ...config, production: true }, mock);
  await request(productionApp).delete('/api/history/00000000-0000-4000-8000-000000000000').set('Origin', 'http://127.0.0.1:5173').set('Cookie', cookie()).expect(403);
  await request(app).post('/api/recognize').set('Cookie', cookie()).attach('image', Buffer.from('fake'), { filename: 'a.jpg', contentType: 'image/jpeg' }).expect(400);
  await request(app).post('/api/recognize').set('Cookie', cookie()).attach('image', Buffer.from('<svg/>'), { filename: 'a.svg', contentType: 'image/svg+xml' }).expect(400);
});
test('real API entry points recognize a photo through the adapter and export the edited result', async () => {
  const app = createApp(config, mock);
  const result = await request(app).post('/api/recognize').set('Cookie', cookie()).attach('image', await image(), { filename: 'a.jpg', contentType: 'image/jpeg' }).expect(200);
  assert.deepEqual(result.body.document, fixture);
  assert.equal(result.body.conversion.originalName, 'a.jpg');
  const id = result.body.conversion.id;
  const list = await request(app).get('/api/history').set('Cookie', cookie()).expect(200);
  assert.ok(list.body.items.some((entry: {id: string}) => entry.id === id));
  await request(app).get('/api/history/index').expect(401);
  const index = await request(app).get('/api/history/index').set('Cookie', cookie()).expect(200);
  assert.deepEqual(index.body.find((entry: {id: string}) => entry.id === id), result.body.conversion);
  await request(app).get(`/api/history/${id}/source`).set('Cookie', cookie()).expect(200);
  await request(app).get(`/api/history/${id}/result`).set('Cookie', cookie()).expect(200);
  await request(app).get('/api/history?limit=99999').set('Cookie', cookie()).expect(400);
  result.body.document.tables[0].rows[0][1] = 'Исправленное значение';
  const output = await request(app).post('/api/export').set('Cookie', cookie()).send({ documents: [{ name: 'a.jpg', document: result.body.document }] }).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
  assert.match(output.headers['content-type'], /spreadsheetml/);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(output.body);
  assert.ok(book.worksheets[0].getColumn(2).values.includes('Исправленное значение'));
  await request(app).delete(`/api/history/${id}`).set('Cookie', cookie()).expect(200);
  await request(app).get(`/api/history/${id}/source`).set('Cookie', cookie()).expect(404);
  await request(app).get(`/api/history/${id}/result`).set('Cookie', cookie()).expect(404);
  await request(app).delete(`/api/history/${id}`).set('Cookie', cookie()).expect(404);
});
test('history survives reopening storage and deleting a conversion removes both files', async () => {
  const storeOptions = await options();
  let store = await openStore(storeOptions);
  const source = await image();
  const entry = await store.save(source, Buffer.from('xlsx result'), 'Документ.jpg', 'image/jpeg', 18, 0);
  await closeStore(store); store = await openStore(storeOptions);
  assert.deepEqual(await store.get(entry.id), entry);
  assert.equal((await store.list(0, 25)).total, 1);
  assert.equal((await store.list(0, 25)).items[0].resultName, 'Документ.xlsx');
  assert.deepEqual(await readFile(store.filePath(entry.id, 'source')), source);
  assert.equal(await store.get('../../etc/passwd'), undefined);
  assert.throws(() => store.filePath('../../etc/passwd', 'source'));
  await store.delete(entry.id);
  assert.equal((await store.list(0, 25)).total, 0);
  assert.deepEqual(await readdir(path.join(storeOptions.directory, 'files')), []);
  await closeStore(store);
  const mojibake = Buffer.from('Документ.jpg', 'utf8').toString('latin1');
  assert.equal(safeFilename(mojibake), 'Документ.jpg');
});
test('legacy SQLite history imports once, includes late rows and never resurrects deleted conversions', async () => {
  const storeOptions = await options();
  await mkdir(path.join(storeOptions.directory, 'files'), { recursive: true });
  const filename = path.join(storeOptions.directory, 'conversions.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec('CREATE TABLE conversions (id TEXT PRIMARY KEY, original_name TEXT, result_name TEXT, original_mime TEXT, created_at TEXT, row_count INTEGER, warning_count INTEGER)');
  const first = randomUUID(), second = randomUUID();
  const add = async (id: string) => {
    await writeFile(path.join(storeOptions.directory, 'files', `${id}.source`), 'source');
    await writeFile(path.join(storeOptions.directory, 'files', `${id}.xlsx`), 'result');
    legacy.prepare('INSERT INTO conversions VALUES (?,?,?,?,?,?,?)').run(id, 'source.jpg', 'result.xlsx', 'image/jpeg', '2025-10-08T12:34:56.000Z', 18, 0);
  };
  await add(first);
  let store = await openStore(storeOptions);
  assert.equal((await store.list(0, 25)).total, 1);
  assert.equal((await store.get(first))!.createdAt, '2025-10-08T12:34:56.000Z');
  await closeStore(store);
  await add(second);
  store = await openStore(storeOptions);
  assert.equal((await store.list(0, 25)).total, 2);
  await store.delete(first); await closeStore(store);
  store = await openStore(storeOptions);
  assert.equal(await store.get(first), undefined);
  assert.equal((await store.list(0, 25)).total, 1);
  assert.ok(await store.get(second));
  assert.equal((legacy.prepare('SELECT count(*) AS n FROM conversions').get() as {n: number}).n, 2);
  const live = await store.save(Buffer.from('live source'), Buffer.from('live result'), 'live.jpg', 'image/jpeg', 1, 0);
  legacy.prepare('DELETE FROM conversions WHERE id=?').run(second);
  assert.deepEqual(await store.finalizeLegacyImport(), { removed: 1 });
  await closeStore(store);
  const afterCutover = randomUUID(); await add(afterCutover);
  store = await openStore(storeOptions);
  assert.equal(await store.get(first), undefined);
  assert.equal(await store.get(second), undefined);
  assert.equal(await store.get(afterCutover), undefined);
  assert.ok(await store.get(live.id));
  assert.equal((await store.list(0, 25)).total, 1);
  assert.deepEqual(await store.finalizeLegacyImport(), { removed: 0 });
  legacy.close(); await closeStore(store);
});
test('PostgreSQL stores remain isolated and failed inserts leave no visible history or files', async () => {
  const oneOptions = await options(), twoOptions = await options();
  const one = await openStore(oneOptions), two = await openStore(twoOptions);
  const entry = await one.save(Buffer.from('source'), Buffer.from('result'), 'a.jpg', 'image/jpeg', 1, 0);
  assert.equal(await two.get(entry.id), undefined);
  assert.equal((await two.list(0, 25)).total, 0);
  await assert.rejects(two.save(Buffer.from('source'), Buffer.from('result'), 'bad.jpg', 'image/jpeg', -1, 0));
  assert.deepEqual(await readdir(path.join(twoOptions.directory, 'files')), []);
  assert.equal((await two.list(0, 25)).total, 0);
  await closeStore(one); await closeStore(two);
});

// Old cached HTML can request a bundle that disappeared during a deployment.
test('missing JavaScript and CSS assets return an uncached 404 instead of SPA HTML', async () => {
  const app = createApp(config);
  for (const asset of ['stale-build.js', 'stale-build.css']) {
    const result = await request(app).get(`/assets/${asset}`).expect(404);
    assert.match(result.headers['content-type'], /^text\/plain/);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.doesNotMatch(result.text, /<!doctype|<html/i);
  }
});

test('browser diagnostics work without login or JavaScript and distinguish legacy Edge from Chromium', async () => {
  const app = createApp(config);
  const agents = [
    ['Mozilla/5.0 Chrome/42.0 Safari/537.36 Edge/18.19041', 'Microsoft Edge (старая версия)', '18.19041'],
    ['Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0.2849.46', 'Microsoft Edge', '130.0.2849.46'],
    ['Mozilla/5.0 Chrome/124.0 Safari/537.36 YaBrowser/24.6.0.0', 'Яндекс Браузер', '24.6.0.0'],
    ['Mozilla/5.0 Chrome/109.0.0.0 Safari/537.36', 'Chrome', '109.0.0.0'],
  ];
  for (const [agent, name, version] of agents) {
    const result = await request(app).get('/diagnostics').set('User-Agent', agent).expect(200);
    assert.match(result.headers['content-type'], /^text\/plain/);
    assert.equal(result.headers['cache-control'], 'no-store');
    assert.ok(result.text.includes(`Браузер: ${name}\n`));
    assert.ok(result.text.includes(`Версия: ${version}\n`));
    assert.ok(result.text.includes(`User-Agent: ${agent}`));
  }
  const unknown = await request(app).get('/diagnostics').set('User-Agent', '<script>untrusted</script>').expect(200);
  assert.match(unknown.headers['content-type'], /^text\/plain/);
  assert.ok(unknown.text.includes('Браузер: не определён'));
});

async function pdfWithPages(count: number, paddingBytes = 0): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let i = 0; i < count; i++) document.addPage().drawText(`Table on page ${i + 1}`);
  if (paddingBytes) {
    const padding = document.context.stream(Buffer.alloc(paddingBytes, 32));
    document.getPage(0).node.addContentStream(document.context.register(padding));
  }
  return Buffer.from(await document.save({ addDefaultPage: false }));
}

test('PDF validation accepts all pages and rejects invalid, empty and encrypted documents', async () => {
  assert.equal(await validatePdf(await pdfWithPages(2)), 2);
  await assert.rejects(validatePdf(Buffer.from('%PDF-1.7\nnot a PDF')), /прочитать PDF/);
  await assert.rejects(validatePdf(await pdfWithPages(0)), /не содержит страниц/);
  await assert.rejects(validatePdf(await readFile(new URL('./fixtures/password-protected.pdf', import.meta.url))), /защищён паролем/);
});

test('converts a 21-page PDF larger than 12 MiB and builds a register from the same source', async () => {
  const pdf = await pdfWithPages(21, 13 * 1024 * 1024);
  const settings = await options();
  const historyStore = await openStore(settings);
  const app = createApp({ ...config, dataDir: settings.directory, historyStore }, async (url, init) => {
    const body = JSON.parse(String(init?.body));
    const schema = body.response_format.json_schema.name;
    if (schema === 'document_tables') {
      assert.deepEqual(Buffer.from(body.messages[1].content[1].file.file_data.split(',')[1], 'base64'), pdf);
      return mock(url, init);
    }
    let data;
    if (schema === 'registry_transcript') {
      const { page } = JSON.parse(body.messages[1].content[0].text);
      data = { blank: false, object: '', section: '', continuation: '', regions: [],
        documents: [{ title: 'Certificate ' + page, text: 'Certificate number ' + page }] };
    } else {
      assert.equal(schema, 'registry_document_fields');
      const [part] = JSON.parse(body.messages[1].content);
      data = { kind: 'Сертификат', name: part.title, number: 'C-' + part.page, date: '', organization: '',
        material: '', batch: '', work: '', section: '', floor: '', reviewFields: [], evidence: [] };
    }
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] });
  });
  const client = request(app);
  const converted = await client.post('/api/recognize').set('Cookie', cookie()).attach('image', pdf, 'kit.pdf').expect(200);
  assert.deepEqual(converted.body.document, fixture);
  const created = await client.post('/api/registry').set('Cookie', cookie()).attach('pdf', pdf, 'kit.pdf').expect(202);
  const url = '/api/registry/' + created.body.job.id;
  let job = created.body.job;
  const deadline = Date.now() + 120_000;
  while (['working', 'queued'].includes(job.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
    job = (await client.get(url).set('Cookie', cookie()).expect(200)).body.job;
  }
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.processedPages, 21);
  assert.equal(job.recordCount, 21);
  const result = await client.get(url + '/result').set('Cookie', cookie()).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', chunk => chunks.push(Buffer.from(chunk)));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  }).expect(200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(result.body);
  for (let i = 1; i <= 21; i++) assert.equal(book.worksheets[0].getCell('C' + (7 + i)).value, 'C-' + i);
});

test('native OpenRouter PDF input preserves the complete file and all-page extraction instructions', async () => {
  const pdf = await pdfWithPages(2);
  let calls = 0;
  const result = await recognizePdf(pdf, 'two-pages.pdf', config.apiKey, config.model, async (url, init) => {
    calls++; const body = JSON.parse(init!.body as string);
    assert.deepEqual(body.plugins, [{ id: 'file-parser', pdf: { engine: 'native' } }]);
    assert.match(body.messages[0].content, /every page.*untrusted source material/);
    assert.match(body.messages[1].content[0].text, /ALL pages/);
    assert.equal(body.messages[1].content[1].type, 'file');
    assert.equal(body.messages[1].content[1].file.filename, 'two-pages.pdf');
    const data = body.messages[1].content[1].file.file_data;
    assert.match(data, /^data:application\/pdf;base64,/);
    assert.deepEqual(Buffer.from(data.split(',')[1], 'base64'), pdf);
    assert.equal(body.response_format.json_schema.strict, true);
    return mock(url, init);
  });
  assert.equal(calls, 1); assert.deepEqual(result, fixture);
});

test('invalid PDFs are rejected before any paid model request or history record', async () => {
  let calls = 0;
  const app = createApp(config, async (...args) => { calls++; return mock(...args); });
  const before = (await sharedStore.list(0, 25)).total;
  for (const [pdf, message] of [
    [Buffer.from('not a PDF'), 'прочитать PDF'],
    [await pdfWithPages(0), 'не содержит страниц'],
    [await readFile(new URL('./fixtures/password-protected.pdf', import.meta.url)), 'защищён паролем'],
  ] as const) {
    const result = await request(app).post('/api/recognize').set('Cookie', cookie()).attach('image', pdf, { filename: 'test.pdf', contentType: 'application/pdf' }).expect(400);
    assert.ok(result.body.error.includes(message));
  }
  assert.equal(calls, 0); assert.equal((await sharedStore.list(0, 25)).total, before);
});

test('scan-only multipage PDFs convert to Excel, retain the source, and can be downloaded and deleted', async () => {
  const pdf = await readFile(new URL('./fixtures/scanned-two-pages.pdf', import.meta.url));
  const document: ExtractedDocument = { title: 'Materials register', context: [], warnings: [], tables: [{ title: 'Materials', columns: ['Code', 'Material', 'Quantity'], rows: [['000101', 'Concrete', '12'], ['000105', 'Waterproofing', '8'], ['000107', 'Brick', '24'], ['000109', 'Sand', '16']], uncertainCells: [] }] };
  const app = createApp(config, async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    assert.deepEqual(Buffer.from(body.messages[1].content[1].file.file_data.split(',')[1], 'base64'), pdf);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(document) } }] });
  });
  // Browsers sometimes supply an empty type, which multipart sends as application/octet-stream.
  const result = await request(app).post('/api/recognize').set('Cookie', cookie()).attach('image', pdf, { filename: 'Scanned.PDF', contentType: 'application/octet-stream' }).expect(200);
  const entry = result.body.conversion;
  assert.equal(entry.originalMime, 'application/pdf'); assert.equal(entry.resultName, 'Scanned.xlsx'); assert.equal(entry.rowCount, 4);
  const source = await request(app).get(`/api/history/${entry.id}/source`).set('Cookie', cookie()).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
  assert.deepEqual(source.body, pdf);
  const output = await request(app).get(`/api/history/${entry.id}/result`).set('Cookie', cookie()).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('end', () => done(null, Buffer.concat(chunks))); }).expect(200);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(output.body);
  const values = book.worksheets[0].getSheetValues().flat();
  for (const code of ['000101', '000105', '000107', '000109']) assert.ok(values.includes(code));
  await request(app).delete(`/api/history/${entry.id}`).set('Cookie', cookie()).expect(200);
  await request(app).get(`/api/history/${entry.id}/source`).set('Cookie', cookie()).expect(404);
  await request(app).get(`/api/history/${entry.id}/result`).set('Cookie', cookie()).expect(404);
});

test('multipage documents can contain more than forty separate tables', async () => {
  const document = { ...fixture, tables: Array.from({ length: 41 }, (_, index) => ({ title: `Page ${index + 1}`, columns: ['Code'], rows: [[`000${index + 1}`]], uncertainCells: [] })) };
  assert.ok(documentSchema.safeParse(document).success);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await exportExcel({ documents: [{ name: 'many-tables.pdf', document }] }));
  assert.equal(book.worksheets.length, 41);
});

test('indexes old jobs, groups matching sources and resolves a kit when its document arrives', async () => {
  const settings = await options();
  const historyStore = await openStore(settings);
  const fixtureDir = path.join(settings.directory, 'registry-jobs');
  const project = 'Секция 2';
  const doc = { name: 'Паспорт панели', organization: 'ДСК', number: '373', date: '02.2026', uncertain: false };
  async function seed(name: string, contents: (typeof doc)[], workspace = project) {
    const id = randomUUID(), dir = path.join(fixtureDir, id);
    await mkdir(path.join(dir, 'pages'), { recursive: true });
    await writeFile(path.join(dir, 'job.json'), JSON.stringify({ id, originalName: name, project: workspace, createdAt: new Date().toISOString(), status: 'done', pages: contents.length }));
    await writeFile(path.join(dir, 'source.pdf'), await readFile('server/fixtures/scanned-two-pages.pdf'));
    for (const [i, record] of contents.entries()) await writeFile(path.join(dir, 'pages', (i+1)+'.json'), JSON.stringify({ documents: [record], blank: false, continuesPrevious: false }));
    return id;
  }
  const models = {recognition:'test/document-reader',chat:'test/archive-chat',regions:'test/region-reader:free'};
  const qa: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    if (body.model === models.recognition) return mock(url,init);
    assert.equal(body.model,models.chat);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ answers: [{ index: 0, text: 'Паспорт №373.' }] }) } }] });
  };
  const appForJobs = () => createApp({ ...config, historyStore, dataDir: settings.directory }, qa as typeof fetch);
  let app = appForJobs();
  await request(app).get('/api/settings/models').expect(401);
  await request(app).put('/api/settings/models').send(models).expect(401);
  await request(app).put('/api/settings/models').set('Cookie',cookie()).send({...models,chat:'invalid model'}).expect(400);
  await request(app).put('/api/settings/models').set('Cookie',cookie()).send(models).expect(200);
  app = appForJobs();
  assert.deepEqual((await request(app).get('/api/settings/models').set('Cookie',cookie()).expect(200)).body,models);
  assert.equal((await request(app).get('/api/config').set('Cookie',cookie()).expect(200)).body.model, models.recognition);
  await request(app).post('/api/recognize').set('Cookie',cookie()).attach('image',await image(),'doc.jpg').expect(200);
  await request(app).post('/api/recognize').set('Cookie',cookie()).attach('image',await pdfWithPages(1),'doc.pdf').expect(200);
  const params = { project }, req = { kind: 'Паспорт', number: '373', batch: '', organization: 'ДСК' };
  await request(app).post('/api/catalog/sets').query(params).set('Cookie', cookie()).send({ name: 'Панели', requirements: [req] }).expect(201);
  const empty = await request(app).get('/api/catalog').query(params).set('Cookie', cookie()).expect(200);
  assert.equal(empty.body.items.length, 0);
  const volume = await seed('Том.pdf', [{ ...doc, name: 'Акт работ', number: 'А1' }, doc]);
  await seed('Паспорт.pdf', [doc]);
  await seed('Другой проект.pdf', [doc], 'Другой');
  app = appForJobs();
  const res = await request(app).get('/api/catalog').query(params).set('Cookie', cookie()).expect(200);
  assert.equal(res.body.items.length, 2);
  const card = res.body.items.find((c: { number: string }) => c.number === '373');
  assert.equal(card.sources.length, 2);
  assert.equal(card.sources.find((s: { job: string }) => s.job === volume).first, 2);
  const occurrence = card.sources.find((s: { job: string }) => s.job === volume);
  assert.equal(occurrence.index, 1);
  const base = '/api/registry/' + volume + '/documents/' + occurrence.index;
  await request(app).get(base + '/pdf').expect(401);
  await request(app).get(base + '/layout?page=1').set('Cookie', cookie()).expect(404);
  const opening = await request(app).get(base + '/layout?page=2&poll=1').set('Cookie', cookie()).expect(202);
  assert.equal(opening.body.ocrStatus, 'pending');
  assert.ok(opening.body.width > 0);
  const layout = await request(app).get(base + '/layout?page=2').set('Cookie', cookie()).expect(200);
  assert.ok(layout.body.words.length);
  assert.deepEqual(layout.body.evidence, []);
  assert.equal(layout.body.ocrStatus, 'ready');
  const cached = await request(app).get(base + '/layout?page=2&poll=1').set('Cookie', cookie()).expect(200);
  assert.deepEqual(cached.body.words, layout.body.words);
  const hits = await historyStore.findPassages(project, layout.body.words.map((w: {text: string}) => w.text).join(' '));
  assert.ok(hits.some(hit => hit.job === occurrence.job && hit.page === 2));
  await request(app).get(base + '/image?page=2').set('Cookie', cookie()).expect('Content-Type', /jpeg/).expect(200);
  const file = await request(app).get(base + '/pdf').set('Cookie', cookie()).expect('Content-Disposition', /attachment/).expect(200);
  assert.equal((await PDFDocument.load(file.body)).getPageCount(), 1);
  const set = res.body.sets[0];
  await request(app).post('/api/catalog/confirm').query(params).set('Cookie', cookie()).send({ id: set.id, position: 0, card: card.id }).expect(200);
  const saved = await request(app).get('/api/catalog').query(params).set('Cookie', cookie()).expect(200);
  assert.equal(saved.body.sets[0].confirmations['0'],card.id);
  const answer = await request(app).post('/api/catalog/ask').query(params).set('Cookie', cookie()).send({ question: 'Паспорт 373' }).expect(200);
  assert.equal(answer.body.answers[0].source.job, card.sources[0].job);
  await request(app).get('/api/registry/'+volume+'/source').expect(401);
  await request(app).get('/api/registry/'+volume+'/source').set('Cookie',cookie()).expect('Content-Type',/pdf/).expect(200);
});

test('archives complete owned transcriptions before chat extraction and resumes a failed register from PostgreSQL', async () => {
  const settings = await options(), store = await openStore(settings);
  const models = { recognition: 'test/reader', regions: 'test/detail', chat: 'test/archive' };
  const order: string[] = [];
  let failSecond = true, failCrop = true;
  let jobId = '', sealCalls = 0;
  const answer = (result: unknown) => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    order.push(body.model);
    assert.equal(body.reasoning.effort, body.model === models.chat ? 'low' : 'none');
    if (body.model === models.recognition && body.response_format.json_schema.name === 'region_transcription') return answer({text:'КОПИЯ ВЕРНА',status:'read'});
    if (body.model === models.recognition) {
      const {page} = JSON.parse(body.messages[1].content[0].text);
      const page1 = page === 1;
      return answer({
        blank: false, object: 'Project', section: 'Roof', continuation: page1 ? '' : 'Signed appendix on the next sheet.',
        documents: [{title:page1 ? 'Act' : 'Certificate', text:page1 ? 'Performer: Builder. Act number handwritten.' : 'Certificate C-15 issued by Lab.'}],
        regions: page1 ? [
          {document:0,kind:'handwriting',left:100,top:100,right:300,bottom:250,reading:{text:'[неразборчиво]',confidence:'high'}},
          {document:0,kind:'seal',left:400,top:100,right:600,bottom:250,reading:{text:'Build',confidence:'medium'}},
          {document:0,kind:'stamp',left:400,top:300,right:600,bottom:400,reading:{text:'КОПИЯ ВЕРНА',confidence:'high'}},
        ] : [],
      });
    }
    if (body.model === models.regions) {
      if (body.messages[0].content.includes('organization seal')) {
        sealCalls++;
        return answer({text:'Builder',status:'read'});
      }
      return failCrop ? new Response('', {status:503}) : answer({text:'Act No. 000017',status:'read'});
    }
    assert.equal(body.model, models.chat);
    const saved = await store.transcripts(jobId);
    assert.equal(saved.length, 2);
    assert.ok(saved.every(p => p.readings !== null));
    const input = body.messages[1].content;
    const parts = JSON.parse(input);
    const first = parts[0].title === 'Act';
    if (first) {
      assert.match(input,/Signed appendix/);
      assert.match(input,/КОПИЯ ВЕРНА/);
      assert.match(input,/Act No. 000017/);
      assert.doesNotMatch(input,/C-15/);
    } else {
      assert.doesNotMatch(input,/000017|Signed appendix/);
      if (failSecond) return new Response('', {status:402});
    }
    return answer({kind:first?'Акт':'Сертификат',name:first?'Act':'Certificate',number:first?'000017':'C-15',
      date:'',organization:first?'Builder':'Lab',material:'',batch:'',work:'',floor:'',section:'',
      reviewFields:[],evidence:[{field:'number',page:first?1:2,quote:first?'Act No. 000017':'C-15'}]});
  };
  const makeApp = () => createApp({...config, password:'', production:false, dataDir:settings.directory,historyStore:store}, fetcher);
  let app = makeApp();
  await request(app).put('/api/settings/models').send(models).expect(200);
  const created = await request(app).post('/api/registry').query({project:'Archive'}).attach('pdf','server/fixtures/scanned-two-pages.pdf').expect(202);
  jobId = created.body.job.id;
  async function wait(status: string) {
    const end = Date.now()+30_000;
    do {
      const j = (await request(app).get('/api/registry/'+jobId)).body.job;
      if (j.status===status) return j;
      if (j.status==='error') assert.fail(j.error);
      await new Promise(r=>setTimeout(r,50));
    } while (Date.now()<end);
    assert.fail('Timed out waiting for '+status);
  }
  assert.match((await wait('error')).error, /фрагмент страницы 1/);
  assert.equal((await store.transcripts(jobId))[0].readings,null);
  failCrop = false;
  await request(app).post('/api/registry/'+jobId+'/retry').expect(200);
  assert.equal((await wait('error')).recordCount,1);
  assert.equal(sealCalls,1);
  assert.deepEqual((await store.transcripts(jobId))[0].readings?.map(r => r.kind), ['handwriting','seal','stamp']);
  const stamp = (await store.transcripts(jobId))[0].readings!.at(-1)!;
  assert.deepEqual([stamp.text,stamp.method,stamp.model], ['КОПИЯ ВЕРНА','page',models.recognition]);
  const failedCalls = [...order];
  app = makeApp();
  failSecond = false;
  await request(app).post('/api/registry/'+jobId+'/retry').expect(200);
  assert.equal((await wait('done')).recordCount,2);
  assert.deepEqual(order, [...failedCalls,models.chat]);
  assert.deepEqual(failedCalls,[models.recognition,models.regions,models.regions,models.regions,models.recognition,models.chat,models.chat]);
  const entries = await store.documentFields(jobId);
  assert.deepEqual([...entries.values()].map(e=>[e.row.number,e.row.first,e.row.last]),[['000017',1,2],['C-15',2,2]]);
  const catalog = (await request(app).get('/api/catalog').query({project:'Archive'})).body;
  assert.ok(catalog.items.some((item: {number:string})=>item.number==='000017'));
  await rm(app.locals.registryQueue.resultPath(created.body.job.id));
  const xlsx = await app.locals.registryQueue.downloadPath(app.locals.registryQueue.get(jobId));
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(xlsx);
  assert.equal(book.worksheets[0].getCell('C8').value, '000017');
  assert.equal(book.worksheets[0].getCell('C9').value, 'C-15');
  assert.equal(order.length,8);
  const preview = await request(app).get('/api/registry/'+jobId+'/documents/0/image?page=1&region='+stamp.id).expect(200);
  assert.match(preview.headers['content-type'],/image\/png/);
  await request(app).put('/api/settings/models').send({...models,regions:models.recognition}).expect(200);
  const verified = await request(app).post('/api/registry/'+jobId+'/documents/0/regions?page=1').send(stamp).expect(200);
  assert.equal(verified.body.region.method,'crop');
  assert.equal(verified.body.region.previous[0].method,'page');
  assert.equal(order.length,9);
  await request(app).delete('/api/registry/'+jobId).expect(200);
  assert.equal((await store.transcripts(jobId)).length,0);
  assert.equal((await store.documentFields(jobId)).size,0);
});

test('construction packages persist originals atomically, isolate packages and include dependent hidden works', async () => {
  const { entry } = await import('../shared/construction.js');
  const JSZip = (await import('jszip')).default;
  const app = createApp(config);
  const api = request.agent(app);
  await api.get('/api/construction').expect(401);
  api.set('Cookie', cookie());
  const created = await api.post('/api/construction').send({ name: 'Тестовый объект', pack: 'Фундамент' }).expect(201);
  const project = created.body as import('../shared/construction.js').SavedProject;
  const pack = project.rows.find(r => r.kind === 'pack')!;
  const template = (form: string) => project.rows.find(r => r.kind === 'template' && r.v.form === form)!;
  const otherPack = entry('pack', { name: 'Кровля' });
  const materials = Array.from({ length: 6 }, (_, i) => entry('material', { name: 'Материал ' + i, incoming: 'ВК-1', number: 'С-' + i }));
  const hidden = entry('work', { name: 'Подготовка основания', number: '01', date: '2026-01-03' }, {
    pack: [pack.id], template: [template('hidden').id], materials: materials.map(m => m.id),
  });
  const structure = entry('work', { name: 'Приёмка плиты', number: '02', date: '2026-01-05' }, {
    pack: [pack.id], template: [template('structure').id], children: [hidden.id],
  });
  project.rows.push(otherPack, ...materials, hidden, structure,
    entry('work', { name: 'Кровельные работы', number: '03', date: '2026-01-07' }, { pack: [otherPack.id], template: [template('hidden').id] }));
  const original = await image();
  const route = '/api/construction/' + project.id;
  const saved = await api.put(route).field('project', JSON.stringify(project)).field('version', '1')
    .field('entry', materials[0].id).attach('file', original, 'quality.jpg').expect(200);
  assert.equal(saved.body.version, 2);
  await api.put(route).send({ project, version: 1 }).expect(409);
  const withoutMaterial = { ...saved.body, rows: saved.body.rows.filter((r: {id:string}) => r.id !== materials[0].id) };
  await api.put(route).send({ project: withoutMaterial, version: 2 }).expect(400);
  assert.equal((await api.get(route).expect(200)).body.version, 2);
  const readBinary = (res: NodeJS.ReadableStream, done: (err: null, result: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', chunk => chunks.push(Buffer.from(chunk))).on('end', () => done(null, Buffer.concat(chunks)));
  };
  const response = await api.post(route + '/report').send({ pack: pack.id, selected: [structure.id] })
    .buffer(true).parse(readBinary).expect(201);
  const zip = await JSZip.loadAsync(response.body);
  const paths = Object.keys(zip.files);
  assert.equal(paths.filter(p => p.endsWith('.docx')).length, 2);
  assert.equal(paths.filter(p => p.endsWith('.jpg')).length, 1);
  assert.deepEqual(await zip.file(paths.find(p => p.endsWith('.jpg'))!)!.async('nodebuffer'), original);
  assert.equal(paths.filter(p => p.includes('Приложение №') && p.endsWith('.xlsx')).length, 2);
  const doc = await JSZip.loadAsync(await zip.file(paths.find(p => p.includes('АООК') && p.endsWith('.docx'))!)!.async('nodebuffer'));
  const xml = await doc.file('word/document.xml')!.async('string');
  assert.match(xml, /Подготовка основания/);
  assert.doesNotMatch(xml, /Кровельные работы|Акты_ОСР/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await zip.file(paths.find(p => p.startsWith('Реестр ') && p.endsWith('.xlsx'))!)!.async('arraybuffer'));
  assert.equal(book.getWorksheet('ЖВЗП')!.rowCount, 7);
  assert.ok(book.getWorksheet('По типам')!.rowCount < book.getWorksheet('По актам')!.rowCount);
  await api.post(route + '/report').send({ pack: otherPack.id, selected: [structure.id] }).expect(400);
  const incoming = await api.get(route + '/incoming/' + template('incoming').id).buffer(true).parse(readBinary).expect(200);
  const avk = await JSZip.loadAsync(incoming.body);
  const avkDoc = await JSZip.loadAsync(await avk.file(Object.keys(avk.files).find(p => p.endsWith('.docx'))!)!.async('nodebuffer'));
  assert.match(await avkDoc.file('word/document.xml')!.async('string'), /Материал 5/);
  const batch = () => api.put(route).field('project', JSON.stringify(saved.body)).field('version', '2');
  await batch().field('entry', materials[1].id).attach('file', Buffer.from('first'), 'one.pdf')
    .field('entry', hidden.id).attach('file', Buffer.from('second'), 'two.pdf').expect(400);
  assert.equal((await api.get(route).expect(200)).body.version, 2);
  await batch().field('entry', materials[1].id).attach('file', Buffer.from('first'), 'one.pdf')
    .field('entry', materials[2].id).attach('file', Buffer.from('second'), 'two.pdf').expect(200);
  for (const [row, value] of [[materials[1], 'first'], [materials[2], 'second']] as const) {
    const file = await api.get(route + '/file/' + row.id).buffer(true).parse(readBinary).expect(200);
    assert.equal(file.body.toString(), value);
  }
});

test('imports workbook references by role and name, including multiple hidden acts on the structure row', async () => {
  const { importBook } = await import('./construction/import.js');
  const { validateProject } = await import('../shared/construction.js');
  const book = new ExcelJS.Workbook();
  for (const name of ['Люди','Настройки','Реквизиты','Акты','Материалы','Исп. схемы','Протоколы','ИД','СП']) book.addWorksheet(name);
  book.getWorksheet('Реквизиты')!.getCell('B4').value = 'Объект';
  const people = book.getWorksheet('Люди')!;
  people.getRow(4).values = [7,'Авторский надзор','Первый А. А.'];
  people.getRow(5).values = [7,'Авторский надзор','Второй Б. Б.'];
  const works = book.getWorksheet('Акты')!;
  for (let i = 1; i <= 3; i++) works.getRow(i+3).values = [i,'А-'+i,i===3?'АООК':'АОСР','','Работа '+i];
  works.getCell('AA4').value = '[7]_Второй Б. Б.';
  works.getCell('R6').value = '1, 2';
  works.getCell('B7').value = 'План-4'; // Reserved number, work and form still unknown.
  works.getCell('P9').value = 'Последующие работы';
  works.getCell('A8').value = 5;
  works.getCell('C8').value = 'АОСР';
  works.getCell('V8').value = {formula:'1+1', result:2}; // Pre-filled template row.
  const buffer=Buffer.from(await book.xlsx.writeBuffer());
  const { project, warnings } = await importBook(buffer, 'Участок');
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/только с дополнительными сведениями: 1/);
  const inclusive=await importBook(buffer, 'Участок',true);
  assert.equal(inclusive.project.rows.filter(r=>r.kind==='work').length,5);
  assert.equal(inclusive.project.rows.at(-1)?.v.next,'Последующие работы');
  assert.equal(validateProject(project), undefined);
  const acts = project.rows.filter(r=>r.kind==='work');
  assert.equal(acts.length,4);
  assert.equal(acts[3].v.number,'План-4');
  assert.deepEqual(acts[3].links.template,[]);
  assert.deepEqual(acts[2].links.children, acts.slice(0,2).map(r=>r.id));
  assert.equal(acts[0].links.signer4[0],project.rows.find(r=>r.v.name==='Второй Б. Б.')?.id);
});

test('workbook import keeps cell values and cached formula results without expanding named ranges', async () => {
  const { readImportWorkbook } = await import('./construction/import.js');
  const source = new ExcelJS.Workbook();
  const sheet = source.addWorksheet('Материалы');
  sheet.getCell('A1').value = 'Бетон';
  sheet.getCell('B1').value = { formula: 'INDEX(Materials, 1)', result: 'Бетон' };
  source.definedNames.add('Материалы!$A$1:$A$10', 'Materials');
  const data = Buffer.from(await source.xlsx.writeBuffer());
  const imported = await readImportWorkbook(data);
  assert.deepEqual(imported.definedNames.model, []);
  assert.equal(imported.getWorksheet('Материалы')!.getCell('A1').value, 'Бетон');
  assert.equal(imported.getWorksheet('Материалы')!.getCell('B1').result, 'Бетон');
  assert.equal(source.definedNames.getRanges('Materials').ranges.length, 1);
});
