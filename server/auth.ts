import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function passwordMatches(value: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(value).digest(), createHash('sha256').update(expected).digest());
}
export function createSession(secret: string, password: string, now = Date.now()): string {
  const value = `${now + 24 * 60 * 60 * 1000}.${randomBytes(16).toString('hex')}`;
  return `${value}.${signature(value, secret, password)}`;
}
function signature(value: string, secret: string, password: string): string {
  return createHmac('sha256', secret).update(password).update('\0').update(value).digest('hex');
}
export function validSession(token: unknown, secret: string, password: string, now = Date.now()): boolean {
  if (typeof token !== 'string' || token.length > 200) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return false;
  const expires = Number(parts[0]);
  if (expires <= now || expires > now + 24 * 60 * 60 * 1000) return false;
  return timingSafeEqual(Buffer.from(parts[2], 'hex'), Buffer.from(signature(`${parts[0]}.${parts[1]}`, secret, password), 'hex'));
}
