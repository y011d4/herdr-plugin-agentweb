import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { KeptTasks, taskToKeep } from '../src/kept-tasks.ts';

describe('taskToKeep', () => {
  it('keeps a task the bridge reported undelivered', () => {
    assert.deepEqual(taskToKeep({ paneId: 'w1:p2', taskDelivered: false }, 'do it'), { paneId: 'w1:p2', text: 'do it' });
  });
  it('keeps nothing when the task was delivered, absent, or there is no pane', () => {
    assert.equal(taskToKeep({ paneId: 'w1:p2', taskDelivered: true }, 'do it'), null);
    assert.equal(taskToKeep({ paneId: 'w1:p2' }, 'do it'), null);
    assert.equal(taskToKeep({ paneId: 'w1:p2', taskDelivered: false }, ''), null);
    assert.equal(taskToKeep({ taskDelivered: false }, 'do it'), null);
  });
});

describe('KeptTasks: keeping a task in the composer', () => {
  it('shows the kept task in its own pane only, one per pane', () => {
    const k = new KeptTasks();
    k.keep('a', 'task a');
    k.keep('b', 'task b');
    assert.equal(k.draft('a'), 'task a');
    assert.equal(k.draft('b'), 'task b');
    assert.equal(k.draft('other'), null);
  });

  it('follows edits, including erasing and retyping', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    k.edit('a', '');
    assert.equal(k.draft('a'), '');
    k.edit('a', 'new task');
    assert.equal(k.draft('a'), 'new task');
  });

  it('leaves panes with nothing kept alone', () => {
    const k = new KeptTasks();
    k.edit('a', 'typed');
    assert.equal(k.draft('a'), null);
    assert.equal(k.beginSend('a', 'typed'), null);
  });
});

describe('KeptTasks: sending the kept task', () => {
  it('a successful send stops keeping it', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    const t = k.beginSend('a', 'task')!;
    assert.equal(k.finishSend('a', t, true), null);
    assert.equal(k.draft('a'), null);
  });

  it('a composer reopened while the send is in flight shows nothing (no double send)', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    const t = k.beginSend('a', 'task')!;
    assert.equal(k.draft('a'), '');
    k.finishSend('a', t, true);
    assert.equal(k.draft('a'), null);
  });

  it('a failed send keeps the task again and returns it for the displayed composer', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    const t = k.beginSend('a', 'task')!;
    assert.equal(k.finishSend('a', t, false), 'task');
    assert.equal(k.draft('a'), 'task'); // a reopened composer shows it too
    const t2 = k.beginSend('a', 'task')!; // and it can be sent again
    k.finishSend('a', t2, true);
    assert.equal(k.draft('a'), null);
  });

  it('edits made during the send are kept, whether the send succeeds or fails', () => {
    for (const ok of [true, false]) {
      const k = new KeptTasks();
      k.keep('a', 'task');
      const t = k.beginSend('a', 'task')!;
      k.edit('a', 'task, but tests first');
      assert.equal(k.finishSend('a', t, ok), null, 'the composer showing the edits is left alone');
      assert.equal(k.draft('a'), 'task, but tests first');
    }
  });

  it('erasing the composer during the send counts as an edit', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    const t = k.beginSend('a', 'task')!;
    k.edit('a', '');
    assert.equal(k.finishSend('a', t, false), null);
    assert.equal(k.draft('a'), '');
  });

  it('a superseded send finishing late changes nothing', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    const first = k.beginSend('a', 'task')!;
    const second = k.beginSend('a', 'task')!;
    assert.equal(k.finishSend('a', first, false), null);
    assert.equal(k.draft('a'), '');
    k.finishSend('a', second, true);
    assert.equal(k.draft('a'), null);
  });

  it('sending one pane does not touch another pane\'s kept task', () => {
    const k = new KeptTasks();
    k.keep('a', 'task a');
    k.keep('b', 'task b');
    const t = k.beginSend('a', 'task a')!;
    k.finishSend('a', t, true);
    assert.equal(k.draft('b'), 'task b');
  });
});
