import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need a fresh module instance per test group because initAuth stores
// module-level state. Use a dynamic import with a cache-buster query string
// so Node's module cache doesn't interfere.
async function freshAuth(stateDir: string) {
  const mod = await import(`../auth.ts?bust=${Date.now()}`);
  mod.initAuth(stateDir);
  return mod as typeof import('../auth.ts');
}

describe('auth', () => {
  let tmpDir: string;
  let auth: Awaited<ReturnType<typeof freshAuth>>;
  let token: string;

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
    const wrong = '0'.repeat(token.length);
    assert.equal(auth.verifyToken(wrong), false);
  });

  it('verifyToken rejects a token of different length', () => {
    assert.equal(auth.verifyToken('abc'), false);
    assert.equal(auth.verifyToken('a'.repeat(token.length - 1)), false);
    assert.equal(auth.verifyToken('a'.repeat(token.length + 1)), false);
  });

  it('verifyToken rejects null/undefined', () => {
    assert.equal(auth.verifyToken(null), false);
    assert.equal(auth.verifyToken(undefined), false);
  });

  it('generates token written to state dir with correct format', () => {
    assert.match(token, /^[0-9a-f]{32}$/, 'new tokens should be 32 hex chars');
  });

  it('keeps a legacy 64-hex token from an older version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-agentweb-auth-legacy-'));
    try {
      const legacy = 'ab'.repeat(32); // 64 hex chars
      writeFileSync(join(dir, 'token'), legacy, { mode: 0o600 });
      const auth2 = await freshAuth(dir);
      assert.equal(readFileSync(join(dir, 'token'), 'utf8').trim(), legacy);
      assert.ok(auth2.verifyToken(legacy));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-uses the same token on a second init call', async () => {
    const auth2 = await freshAuth(tmpDir);
    const second = readFileSync(join(tmpDir, 'token'), 'utf8').trim();
    assert.equal(token, second);
    assert.ok(auth2.verifyToken(token));
  });

  it('repairs a pre-existing token file with loose permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-agentweb-auth-perms-'));
    try {
      const existing = 'cd'.repeat(16); // valid 32-hex token
      writeFileSync(join(dir, 'token'), existing);
      chmodSync(join(dir, 'token'), 0o644); // world/group-readable, as if pre-existing
      await freshAuth(dir);
      // token value preserved, but the mode must be tightened to 0600
      assert.equal(readFileSync(join(dir, 'token'), 'utf8').trim(), existing);
      assert.equal(statSync(join(dir, 'token')).mode & 0o777, 0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('extractToken', () => {
  let auth: Awaited<ReturnType<typeof freshAuth>>;
  let tmpDir: string;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'herdr-auth-extract-'));
    auth = await freshAuth(tmpDir);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function fakeReq(headers: Record<string, string> = {}, url = '/') {
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
