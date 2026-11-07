import { createApp } from './app.js';

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3001);
const app = createApp({
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  model: process.env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash',
  password: process.env.APP_PASSWORD ?? '', sessionSecret: process.env.SESSION_SECRET ?? '',
  production, trustProxy: Number(process.env.TRUST_PROXY ?? 1), commit: process.env.SOURCE_COMMIT,
});
const server = app.listen(port, '0.0.0.0', () => console.log(`Documents Converter listening on port ${port}`));
server.requestTimeout = 180_000;
server.headersTimeout = 30_000;
const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
