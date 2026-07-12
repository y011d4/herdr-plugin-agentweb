import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

let tokenBuf = null;

export function initAuth(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tokenPath = join(stateDir, 'token');

  let hex;
  try {
    hex = readFileSync(tokenPath, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('invalid');
  } catch {
    hex = randomBytes(32).toString('hex');
    writeFileSync(tokenPath, hex, { mode: 0o600 });
  }

  tokenBuf = Buffer.from(hex, 'utf8');
  return hex;
}

export function verifyToken(candidate) {
  if (!tokenBuf) return false;
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const candidateBuf = Buffer.from(candidate, 'utf8');
  // timingSafeEqual requires same length; pad/reject on mismatch to avoid length oracle
  if (candidateBuf.length !== tokenBuf.length) return false;
  return timingSafeEqual(candidateBuf, tokenBuf);
}

export function extractToken(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token') || null;
}
