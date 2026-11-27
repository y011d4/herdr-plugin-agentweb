// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { clearToasts, getToasts } from '../src/notify.ts';
import type { PanelPrompt } from '../src/pane-view.ts';
import { parsePrompt, promptIdentity } from '../src/prompt.ts';
import { PromptPanel } from '../src/ui/PromptPanel.tsx';
import { errors } from './contract.gen.ts';
import { fire, render } from './render.ts';

// The bridge: every request waits until the test answers it.
interface Req { method: string; url: string; body: any; answered: boolean; answer: (status: number, body: unknown) => void }
let reqs: Req[];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function answerPost(body: unknown, status = 200): Promise<void> {
  const r = reqs.find((q) => !q.answered && q.method === 'POST');
  assert.ok(r, 'no open POST');
  r.answered = true;
  await act(async () => { r.answer(status, body); await flush(); });
}
const posts = () => reqs.filter((q) => q.method === 'POST' && q.url === '/api/panes/p6/input').map((q) => q.body);

const menu = (question: string) => ['─'.repeat(40), ' ☐ Fruit', question, '',
  '❯ 1. apple', '     Crisp and sweet', '  2. banana', '     Soft, and in a bunch', '  3. cherry',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');
const ASK = menu('Pick a fruit');
/** The panel's content for a screen, as pane-view.ts feeds it. */
const at = (text: string, screen: string | null = '<span>screen</span>'): PanelPrompt => {
  const parsed = parsePrompt(text);
  return { parsed, id: parsed ? promptIdentity(text) : '', screen };
};

// pane-view.ts's side: what the panel tells it, and the prompt it shows.
let answered: Array<{ id: string; chat: boolean }>;
let rereads: number;
let modes: string[];
const view = {
  answered: (id: string, chat: boolean, post: Promise<unknown>) => { answered.push({ id, chat }); post.catch(() => {}); },
  reread: async () => { rereads++; },
  setMode: (mode: 'terminal' | 'chat') => { modes.push(mode); },
};
let show: (p: PanelPrompt) => void;
function Host({ initial }: { initial: PanelPrompt }) {
  const [p, set] = useState(initial);
  show = set;
  return <PromptPanel paneId="p6" prompt={p} view={view} />;
}

let container: HTMLElement;
let unmount: () => Promise<void>;
const mount = async (p: PanelPrompt) => { ({ container, unmount } = await render(<Host initial={p} />)); };
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => container.querySelector<T>(sel)!;
const options = () => [...container.querySelectorAll<HTMLButtonElement>('#chat-prompt .ask-opt')];
// the buttons while an answer settles: disabled; the tapped one marked
const sending = (): boolean => options().every((b) => b.disabled);
const marked = (): boolean[] => options().map((b) => b.classList.contains('ask-opt-sent'));
const tap = (i: number) => fire(() => options()[i].click());

beforeEach(() => {
  reqs = [];
  answered = [];
  rereads = 0;
  modes = [];
  unmount = async () => {};
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => new Promise((res) => {
    reqs.push({ method: init.method ?? 'GET', url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), answered: false,
      answer: (status, body) => res({ ok: status < 400, status, json: async () => body }) });
  }));
  clearToasts();
});
afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('answer panel', () => {
  it('shows the question and the options, each label with its description under it', async () => {
    await mount(at(ASK));
    assert.match($('.chat-prompt-head').textContent!, /^⏳ Waiting for your input /);
    assert.equal($('.chat-prompt-q').textContent, 'Pick a fruit');
    assert.deepEqual(options().map((b) => [b.querySelector('.ask-opt-num')!.textContent, b.querySelector('.ask-opt-label')!.textContent,
      b.querySelector('.ask-opt-desc')?.textContent ?? null]),
    [['1', 'apple', 'Crisp and sweet'], ['2', 'banana', 'Soft, and in a bunch'], ['3', 'cherry', null]]);
    assert.ok(options()[1].querySelector('.ask-opt-text > .ask-opt-label + .ask-opt-desc'), 'the description sits under the label');
    assert.equal($<HTMLDetailsElement>('.chat-prompt-term').open, false, 'a question to read: the terminal collapses');
    assert.equal($('.chat-prompt-screen').innerHTML, '<span>screen</span>');
    await fire(() => $('.ask-opt-desc').click()); // the whole button is the tap target
    assert.deepEqual(posts(), [{ press: '1', expect_prompt: promptIdentity(ASK) }]);
  });

  it('keeps the terminal open with no question to read, and shows a spinner before the first screen', async () => {
    await mount({ parsed: null, id: '', screen: null });
    assert.equal(options().length, 0);
    assert.equal($('.chat-prompt-q').textContent, '');
    assert.equal($<HTMLDetailsElement>('.chat-prompt-term').open, true);
    assert.ok($('.chat-prompt-screen .mantine-Loader-root'), 'the spinner');
    const bare = ASK.replace(/^.*Fruit\nPick a fruit\n/m, ''); // a menu with no question to read
    assert.equal(parsePrompt(bare)!.question, null);
    await fire(() => show(at(bare)));
    assert.equal(options().length, 3);
    assert.equal($<HTMLDetailsElement>('.chat-prompt-term').open, true, 'bare buttons: the terminal stays open');
    assert.equal($('.chat-prompt-screen').innerHTML, '<span>screen</span>');
  });

  it('sends one press for a double tap, with the prompt it answers', async () => {
    await mount(at(ASK));
    await tap(1);
    await tap(1);
    assert.deepEqual(posts(), [{ press: '2', expect_prompt: promptIdentity(ASK) }]);
    assert.deepEqual(answered, [{ id: promptIdentity(ASK), chat: false }]);
    assert.ok(sending());
    assert.deepEqual(marked(), [false, true, false]);
  });

  it('holds re-taps 1.5s after the press is sent, or until a new prompt shows', async () => {
    vi.useFakeTimers();
    await mount(at(ASK));
    await tap(1);
    await answerPost({ ok: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(1499); });
    await tap(0);
    assert.equal(posts().length, 1, 'held');
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    assert.ok(!sending());
    await tap(0);
    assert.equal(posts().length, 2, 'taken after the floor');
    await answerPost({ ok: true });
    await tap(2);
    assert.equal(posts().length, 2, 'held again');
    const next = menu('Pick another');
    await fire(() => show(at(next)));
    assert.ok(!sending(), 'a new prompt: live at once');
    assert.deepEqual(marked(), [false, false, false], 'fresh buttons');
    await tap(2);
    assert.deepEqual(posts()[2], { press: '3', expect_prompt: promptIdentity(next) });
  });

  it('on a 409 (prompt changed) re-reads the prompt, says so, and takes a new tap', async () => {
    await mount(at(ASK));
    await tap(1);
    await answerPost(errors.find((e) => e.error.code === 'prompt_changed'), 409);
    assert.equal(rereads, 1);
    assert.deepEqual(getToasts().map((t) => t.title), ['Prompt changed']);
    assert.ok(!sending(), 'the buttons are live again');
    assert.deepEqual(marked(), [false, false, false]);
    await tap(0);
    assert.equal(posts().length, 2);
    assert.equal(posts()[1].press, '1');
    await answerPost({ error: { code: 'x', message: 'boom' } }, 500);
    assert.equal(rereads, 1, 'another failure: no re-read');
    assert.deepEqual(getToasts().map((t) => `${t.title}: ${t.body}`).slice(-1), ['Send failed: boom']);
  });

  it('keeps the same buttons while the prompt identity holds, and gives a new prompt fresh ones', async () => {
    await mount(at(ASK));
    const before = options();
    await fire(() => show(at(ASK, '<span>later</span>'))); // a new poll: a fresh parse, a new screen, the same prompt
    assert.equal($('.chat-prompt-screen').innerHTML, '<span>later</span>');
    assert.ok(options().every((b, i) => b === before[i]), 'the same nodes');
    await fire(() => show(at(menu('Pick another'))));
    assert.ok(options().every((b, i) => b !== before[i]), 'new nodes');
  });

  it('answers "Chat about this" without closing after it, and opens the terminal to type in once it lands', async () => {
    const chat = ASK.replace('  3. cherry', '  3. cherry\n  4. Chat about this');
    await mount(at(chat));
    await tap(3);
    assert.deepEqual(answered, [{ id: promptIdentity(chat), chat: true }]);
    assert.deepEqual(modes, [], 'not before the press lands');
    await answerPost({});
    assert.deepEqual(modes, ['terminal']);
  });

  it('"Type something." is no answer yet (nothing to confirm): the terminal opens to type it; a failed press stays', async () => {
    const typed = ASK.replace('  3. cherry', '  3. cherry\n  4. Type something.');
    await mount(at(typed));
    await tap(3);
    assert.deepEqual(answered, []);
    await answerPost({ error: 'boom' }, 500);
    assert.deepEqual(modes, [], 'a failed press: the panel stays');
    await vi.waitFor(() => assert.ok(!sending()));
    await tap(3);
    await answerPost({});
    assert.deepEqual(modes, ['terminal']);
    assert.deepEqual(posts(), [{ press: '4', expect_prompt: promptIdentity(typed) }, { press: '4', expect_prompt: promptIdentity(typed) }]);
  });

  it("a multi-select's \"[ ] Type something\" too; the terminal opens even when the panel went before the press answered", async () => {
    const multi = ASK.replace('  3. cherry', '  3. cherry\n  4. [ ] Type something');
    await mount(at(multi));
    assert.equal(options()[3].textContent, '4[ ] Type something');
    await tap(3);
    assert.deepEqual(answered, []);
    await unmount(); // the pane left `blocked`: the panel is gone
    unmount = async () => {};
    await answerPost({});
    assert.deepEqual(modes, ['terminal']);
  });
});
