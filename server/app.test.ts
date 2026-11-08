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
import { MAX_PDF_PAGES, MAX_FILE_BYTES } from '../shared/upload.js';
import { ConversionStore, safeFilename, type StoreOptions } from './history.js';

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


async function pdfWithPages(count: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let i = 0; i < count; i++) document.addPage().drawText(`Table on page ${i + 1}`);
  return Buffer.from(await document.save({ addDefaultPage: false }));
}

test('PDF validation accepts all pages and rejects invalid, empty, encrypted and oversized documents', async () => {
  assert.equal(await validatePdf(await pdfWithPages(2)), 2);
  assert.equal(await validatePdf(await pdfWithPages(MAX_PDF_PAGES)), MAX_PDF_PAGES);
  await assert.rejects(validatePdf(Buffer.from('%PDF-1.7\nnot a PDF')), /прочитать PDF/);
  await assert.rejects(validatePdf(await pdfWithPages(0)), /не содержит страниц/);
  await assert.rejects(validatePdf(await pdfWithPages(MAX_PDF_PAGES + 1)), /20 страниц/);
  await assert.rejects(validatePdf(await readFile(new URL('./fixtures/password-protected.pdf', import.meta.url))), /защищён паролем/);
  await assert.rejects(validatePdf(Buffer.alloc(MAX_FILE_BYTES + 1)), /12 МБ/);
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
    [await pdfWithPages(MAX_PDF_PAGES + 1), '20 страниц'],
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

test('multipage documents can contain more than eight separate tables', async () => {
  const document = { ...fixture, tables: Array.from({ length: 20 }, (_, index) => ({ title: `Page ${index + 1}`, columns: ['Code'], rows: [[`000${index + 1}`]], uncertainCells: [] })) };
  assert.ok(documentSchema.safeParse(document).success);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await exportExcel({ documents: [{ name: 'twenty-pages.pdf', document }] }));
  assert.equal(book.worksheets.length, 20);
});
