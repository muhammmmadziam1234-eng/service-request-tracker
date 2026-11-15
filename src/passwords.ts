import {randomBytes, scrypt, timingSafeEqual} from 'node:crypto';

/** Current cost: N=16384, r=8, p=1 (16 MiB of memory per hash), 16-byte salt, 64-byte key. */
export const SCRYPT = {N: 16384, r: 8, p: 1, saltLength: 16, keyLength: 64} as const;
export interface ScryptCost {N: number; r: number; p: number}

function derive(password: string, salt: Buffer, {N, r, p}: ScryptCost, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, keyLength, {N, r, p, maxmem: 256 * 1024 * 1024}, (error, key) => (error ? reject(error) : resolve(key))));
}

/** Format: scrypt$N$r$p$salt$key (base64). The cost travels with the hash, so it can be raised later without locking anyone out. */
export async function hashPassword(password: string, cost: ScryptCost = SCRYPT): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength);
  const key = await derive(password, salt, cost, SCRYPT.keyLength);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function parse(stored: string): (ScryptCost & {salt: Buffer; key: Buffer}) | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(N) || N < 1024 || N > 2 ** 20 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4] ?? '', 'base64'), key = Buffer.from(parts[5] ?? '', 'base64');
  return salt.length >= 8 && key.length >= 16 ? {N, r, p, salt, key} : null;
}

/** Constant-time comparison of the derived key. A malformed stored value simply fails. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.N !== SCRYPT.N || parsed.r !== SCRYPT.r || parsed.p !== SCRYPT.p || parsed.key.length !== SCRYPT.keyLength;
}
