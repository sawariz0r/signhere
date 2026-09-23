import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sha256 } from './pdf.js';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export const token = () => randomBytes(32).toString('base64url');
export const equalSecret = (provided: string, expectedHash: string) => timingSafeEqual(Buffer.from(sha256(provided), 'hex'), Buffer.from(expectedHash, 'hex'));
const scrypt = promisify(scryptCallback);
let hashing = false;
const waiting: Array<() => void> = [];
async function memorySlot<T>(work: () => Promise<T>): Promise<T> {
  if (hashing) {
    if (waiting.length >= 8) throw new ApiError(503, 'För många inloggningsförsök. Försök igen om en stund.');
    await new Promise<void>(resolve => waiting.push(resolve));
  } else hashing = true;
  try { return await work(); }
  finally { const next = waiting.shift(); if (next) next(); else hashing = false; }
}
async function derive(password: string, salt: string) {
  return memorySlot(async () => {
    const result = await (scrypt as unknown as (password: string, salt: string, keylen: number, options: Record<string, number>) => Promise<Buffer>)(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    return result;
  });
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('base64url');
  return 'scrypt-v1$' + salt + '$' + (await derive(password, salt)).toString('base64url');
}
export async function verifyPassword(password: string, encoded?: string) {
  const [, salt = 'signhere-dummy-salt', expected = ''] = (encoded ?? '').split('$');
  const actual = await derive(password, salt);
  const target = expected ? Buffer.from(expected, 'base64url') : Buffer.alloc(64);
  return target.length === actual.length && timingSafeEqual(target, actual) && !!encoded;
}

