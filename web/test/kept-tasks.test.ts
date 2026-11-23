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
    assert.equal(k.beginSend('a', 'typed'), false);
    assert.equal(k.sending('a'), false);
  });
});

describe('KeptTasks: sending the kept task', () => {
  it('a successful send stops keeping it', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    assert.equal(k.beginSend('a', 'task'), true);
    assert.equal(k.finishSend('a', true), null);
    assert.equal(k.draft('a'), null);
    assert.equal(k.sending('a'), false);
  });

  it('while the send is in flight the pane is locked and a reopened composer shows nothing (no double send)', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    k.beginSend('a', 'task');
    assert.equal(k.sending('a'), true);
    assert.equal(k.draft('a'), '');
    k.finishSend('a', true);
    assert.equal(k.sending('a'), false);
    assert.equal(k.draft('a'), null);
  });

  it('a failed send keeps the task again and returns it for the displayed composer', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    k.beginSend('a', 'task');
    assert.equal(k.finishSend('a', false), 'task');
    assert.equal(k.sending('a'), false); // unlocked
    assert.equal(k.draft('a'), 'task'); // a reopened composer shows it too
    k.beginSend('a', 'task'); // and it can be sent again
    k.finishSend('a', true);
    assert.equal(k.draft('a'), null);
  });

  it('sends the task as the user edited it, and restores that version on failure', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    k.edit('a', 'task, but tests first');
    k.beginSend('a', 'task, but tests first');
    assert.equal(k.finishSend('a', false), 'task, but tests first');
    assert.equal(k.draft('a'), 'task, but tests first');
  });

  it('a finish with no send in flight changes nothing', () => {
    const k = new KeptTasks();
    k.keep('a', 'task');
    assert.equal(k.finishSend('a', true), null);
    assert.equal(k.draft('a'), 'task');
    assert.equal(k.finishSend('none', false), null);
  });

  it('sending one pane does not touch another pane\'s kept task', () => {
    const k = new KeptTasks();
    k.keep('a', 'task a');
    k.keep('b', 'task b');
    k.beginSend('a', 'task a');
    assert.equal(k.sending('b'), false);
    k.finishSend('a', true);
    assert.equal(k.draft('b'), 'task b');
  });
});
