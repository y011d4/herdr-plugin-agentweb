import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPaneProfileStore } from '../pane-profile-store.ts';

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentweb-pps-'));
  return join(dir, 'pane-profiles.json');
}

test('set/get/delete round-trips in a single instance', () => {
  const store = createPaneProfileStore(tempFile());
  assert.equal(store.get('w1:p1'), undefined);
  store.set('w1:p1', 'claude-yolo');
  assert.equal(store.get('w1:p1'), 'claude-yolo');
  store.delete('w1:p1');
  assert.equal(store.get('w1:p1'), undefined);
});

test('persists across instances (survives a bridge restart)', () => {
  const file = tempFile();
  const a = createPaneProfileStore(file);
  a.set('w1:p1', 'claude-yolo');
  a.set('w2:p3', 'codex');
  // A fresh store on the same file reloads the entries.
  const b = createPaneProfileStore(file);
  assert.equal(b.get('w1:p1'), 'claude-yolo');
  assert.equal(b.get('w2:p3'), 'codex');
  b.delete('w1:p1');
  // The deletion is durable too.
  const c = createPaneProfileStore(file);
  assert.equal(c.get('w1:p1'), undefined);
  assert.equal(c.get('w2:p3'), 'codex');
});

test('the on-disk file is compact JSON with 0600 perms', () => {
  const file = tempFile();
  const store = createPaneProfileStore(file);
  store.set('w1:p1', 'claude');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { 'w1:p1': 'claude' });
});

test('a malformed or missing file starts empty rather than throwing', () => {
  const missing = tempFile(); // never written
  assert.doesNotThrow(() => createPaneProfileStore(missing));
  assert.equal(createPaneProfileStore(missing).get('x'), undefined);

  const bad = tempFile();
  writeFileSync(bad, '{not json');
  const store = createPaneProfileStore(bad);
  assert.equal(store.get('x'), undefined);
  store.set('w1:p1', 'claude'); // still writable afterwards
  assert.equal(createPaneProfileStore(bad).get('w1:p1'), 'claude');
});

test('a "__proto__" entry in the file neither loads nor pollutes Object.prototype', () => {
  const file = tempFile();
  writeFileSync(file, JSON.stringify({ __proto__: 'evil', 'w1:p1': 'claude' }));
  const store = createPaneProfileStore(file);
  assert.equal(store.get('w1:p1'), 'claude');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(({} as Record<string, unknown>).__proto__ === 'evil', false);
  rmSync(file);
});
