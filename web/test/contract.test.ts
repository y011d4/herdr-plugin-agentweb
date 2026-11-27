// @vitest-environment happy-dom
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conversationItems, type TimelineItem } from '../src/transcript.ts';
import { chatDom } from './render.ts';
import { dashboardCards } from '../src/dashboard-group.ts';
import type { AppState } from '../src/types.ts';

// The Go bridge's JSON (testdata/contract, written by internal/bridge/contract_test.go)
// fed through the web's renderers: the types agree (npm run check:contract), and so
// does what the code does with the values.
// (under happy-dom, for the chat's DOM, the module's URL is Vite's /@fs/<path>)
const load = <T>(name: string): T =>
  JSON.parse(readFileSync(decodeURIComponent(new URL(`../../testdata/contract/${name}`, import.meta.url).pathname).replace(/^\/@fs/, ''), 'utf8')) as T;

describe('the Go bridge contract fixtures', () => {
  it('render as chat items, and the home chat keeps only the dialogue', () => {
    const items = load<TimelineItem[]>('timeline-items.json');
    const log = chatDom(items); // what the chat log draws (ui/ChatLog.tsx)
    const html = log.innerHTML;
    assert.match(html, /fix the bug/);
    assert.match(html, /<strong>fixed<\/strong>/);
    assert.match(html, /cherry/); // the AskUserQuestion option
    assert.equal(log.querySelector('img.chat-image')?.getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=', "a user turn's image");
    // the assistant turn is a sidechain; the question (AskUserQuestion) stays, its answer isn't among them
    assert.deepEqual(conversationItems(items).map((i) => i.kind), ['user', 'user', 'tool_use']);
  });

  it('give the dashboard a card per agent, orchestrators and shells left out', () => {
    const state = load<AppState>('client-state.json');
    const cards = dashboardCards(state.workspaces, state.orchestrators.map((o) => o.paneId));
    assert.deepEqual(cards.map((c) => c.pane.paneId).sort(), ['p1', 'p3', 'p6', 'p7']);
    const p3 = cards.find((c) => c.pane.paneId === 'p3')!;
    assert.equal(p3.branch, null); // a detached linked worktree
    assert.equal(p3.isWorktree, true);
    assert.equal(p3.pane.agent?.completionSeq, 4);
    assert.equal(state.orchestratorPaneId, 'p4');
    assert.deepEqual(state.orchestrators.map((o) => o.agents), [['p1', 'p3', 'p4'], null]);
  });
});
