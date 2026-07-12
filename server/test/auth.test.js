import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need a fresh module instance per test group because initAuth stores
// module-level state. Use a dynamic import with a cache-buster query string
// so Node's module cache doesn't interfere.
async function freshAuth(stateDir) {
  const mod = await import(`../auth.js?bust=${Date.now()}`);
  mod.initAuth(stateDir);
  return mod;
}

describe('auth', () => {
  let tmpDir;
  let auth;
  let token;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'herdr-auth-test-'));
    auth = await freshAuth(tmpDir);
    token = readFileSync(join(tmpDir, 'token'), 'utf8').trim();
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('verifyToken accepts the generated token', () => {
    assert.ok(auth.verifyToken(token), 'correct token should be accepted');
  });

  it('verifyToken rejects an empty string', () => {
    assert.equal(auth.verifyToken(''), false);
  });

  it('verifyToken rejects a wrong token of same length', () => {
    // 64 hex chars (same length as the real token) but all zeros
    const wrong = '0'.repeat(64);
    assert.equal(auth.verifyToken(wrong), false);
  });

  it('verifyToken rejects a token of different length', () => {
    assert.equal(auth.verifyToken('abc'), false);
    assert.equal(auth.verifyToken('a'.repeat(63)), false);
    assert.equal(auth.verifyToken('a'.repeat(65)), false);
  });

  it('verifyToken rejects null/undefined', () => {
    assert.equal(auth.verifyToken(null), false);
    assert.equal(auth.verifyToken(undefined), false);
  });

  it('generates token written to state dir with correct format', () => {
    assert.match(token, /^[0-9a-f]{64}$/, 'token should be 64 hex chars');
  });

  it('re-uses the same token on a second init call', async () => {
    const auth2 = await freshAuth(tmpDir);
    const second = readFileSync(join(tmpDir, 'token'), 'utf8').trim();
    assert.equal(token, second);
    assert.ok(auth2.verifyToken(token));
  });
});

describe('extractToken', () => {
  let auth;
  let tmpDir;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'herdr-auth-extract-'));
    auth = await freshAuth(tmpDir);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakeReq(headers = {}, url = '/') {
    return { headers, url };
  }

  it('extracts token from Authorization Bearer header', () => {
    const req = fakeReq({ authorization: 'Bearer mytoken123' }, '/api/state');
    assert.equal(auth.extractToken(req), 'mytoken123');
  });

  it('extracts token from ?token= query param', () => {
    const req = fakeReq({}, '/ws?token=mytoken123');
    assert.equal(auth.extractToken(req), 'mytoken123');
  });

  it('prefers Authorization header over query param', () => {
    const req = fakeReq({ authorization: 'Bearer headertoken' }, '/api/state?token=querytoken');
    assert.equal(auth.extractToken(req), 'headertoken');
  });

  it('returns null when neither header nor param is present', () => {
    const req = fakeReq({}, '/api/state');
    assert.equal(auth.extractToken(req), null);
  });
});
