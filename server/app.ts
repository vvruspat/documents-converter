import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import path from 'node:path';
import { exportSchema } from '../shared/document.js';
import { createSession, passwordMatches, validSession } from './auth.js';
import { normalizeImage, recognizeImage, UserError } from './recognize.js';
import { exportExcel } from './excel.js';

export type AppConfig = { apiKey: string; model: string; password: string; sessionSecret: string; production: boolean; trustProxy?: number; commit?: string };

export function createApp(config: AppConfig, fetcher: typeof fetch = fetch) {
  const app = express();
  if (config.production && (config.password.length < 10 || config.sessionSecret.length < 32)) throw new Error('Production requires APP_PASSWORD (at least 10 characters) and SESSION_SECRET (at least 32 characters).');
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 1);
  app.use(helmet({ contentSecurityPolicy: config.production ? { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'blob:', 'data:'], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"] } } : false }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok', commit: config.commit ?? 'development' }); });
  app.use('/api', express.json({ limit: '4mb' }));
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== `${req.protocol}://${req.get('host')}`) { res.status(403).json({ error: 'Запрос с другого сайта запрещён.' }); return; }
    next();
  });
  const authenticated = (req: express.Request) => !config.password || validSession(req.cookies['dc_session'], config.sessionSecret, config.password);
  app.get('/api/session', (req, res) => { res.json({ authenticated: authenticated(req), passwordRequired: Boolean(config.password) }); });
  app.post('/api/login', rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, skipSuccessfulRequests: true, message: { error: 'Слишком много попыток входа. Попробуйте через 15 минут.' } }), (req, res) => {
    const input = z.object({ password: z.string().max(1000) }).safeParse(req.body);
    if (!input.success || !passwordMatches(input.data.password, config.password)) { res.status(401).json({ error: 'Неверный пароль.' }); return; }
    res.cookie('dc_session', createSession(config.sessionSecret, config.password), { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/', maxAge: 24 * 60 * 60_000 });
    res.json({ authenticated: true });
  });
  app.post('/api/logout', (_req, res) => { res.clearCookie('dc_session', { path: '/', httpOnly: true, secure: config.production, sameSite: 'strict' }); res.json({ ok: true }); });
  app.use('/api', (req, res, next) => { if (!authenticated(req)) { res.status(401).json({ error: 'Войдите в сервис, чтобы продолжить.' }); return; } next(); });
  app.get('/api/config', (_req, res) => { res.json({ configured: Boolean(config.apiKey), model: config.model, maxFileBytes: 12 * 1024 * 1024 }); });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  app.post('/api/recognize', rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Достигнут лимит: 20 распознаваний за 10 минут. Подождите немного.' } }), (req, _res, next) => {
    if (!config.apiKey) { next(new UserError('Добавьте OPENROUTER_API_KEY в настройках приложения Coolify.', 503)); return; } next();
  }, upload.single('image'), async (req, res) => {
    if (!req.file) throw new UserError('Выберите фотографию таблицы.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(req.file.mimetype)) throw new UserError('Поддерживаются только JPG, PNG и WebP.');
    const image = await normalizeImage(req.file.buffer);
    const document = await recognizeImage(image, config.apiKey, config.model, fetcher);
    res.json({ document });
  });
  app.post('/api/export', rateLimit({ windowMs: 60_000, limit: 20, message: { error: 'Слишком много скачиваний. Повторите через минуту.' } }), async (req, res) => {
    const input = exportSchema.safeParse(req.body);
    if (!input.success) throw new UserError('Таблица пуста, повреждена или превышает лимит 50 000 ячеек.');
    const buffer = await exportExcel(input.data);
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="document.xlsx"', 'Content-Length': String(buffer.length) });
    res.send(buffer);
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Страница API не найдена.' }); });
  const client = path.resolve(process.cwd(), 'dist/client');
  app.use(express.static(client, { maxAge: '1h', index: false }));
  app.get('/{*splat}', (_req, res) => { res.set('Cache-Control', 'no-cache').sendFile(path.join(client, 'index.html')); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof multer.MulterError) { res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Фото слишком большое. Максимальный размер — 12 МБ.' : 'Загрузите одно изображение без дополнительных полей.' }); return; }
    if (error instanceof UserError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof SyntaxError || (error instanceof Error && 'status' in error && error.status === 413)) { res.status(400).json({ error: 'Некорректный или слишком большой запрос.' }); return; }
    // Never log request bodies, model responses, images, credentials or upstream errors.
    console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError');
    res.status(500).json({ error: 'Не удалось обработать запрос. Попробуйте ещё раз.' });
  });
  return app;
}
