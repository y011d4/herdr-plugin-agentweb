/**
 * tools/shots-fixture.ts: the made-up data `node tools/webcheck.ts shots` serves in place of a bridge, and the
 * screens it shoots. Nothing here is real: the screenshots it makes go into public PR comments. The types are
 * the web's own, so `npm run check:contract` (tsconfig.contract.json) fails when the State changes under it.
 *
 * A new screen: one line in `scenes` (and the data it needs here). `ready` is a JS expression, true once the
 * screen has drawn what it shows; shots waits for it, then for the fonts and two frames.
 */
import type { AppState } from '../web/src/types.ts';
import type { TimelineItem } from '../web/src/transcript.ts';

/** The fixture's "now" (ms); the browser's clock is frozen 30s after it. */
export const T0 = Date.UTC(2026, 0, 15, 9, 0, 0);

const repo = '/home/u/src/herdr-yoicks';
const orch = '/home/u/.local/share/herdr-yoicks/orchestrators';

type Agent = NonNullable<AppState['workspaces'][number]['tabs'][number]['panes'][number]['agent']>;
const agent = (name: string, status: Agent['status'], extra: Partial<Agent> = {}): Agent => ({ name, displayName: name, status,
  customStatus: null, message: null, sinceUnixMs: T0 - 4 * 60_000, completionSeq: null, stateChangeSeq: 10, herdrName: null, ...extra });
const pane = (paneId: string, cwd: string, a: Agent | null) => ({ paneId, focused: false, cwd, launchCwd: cwd, title: null, agent: a });
const wt = (checkoutPath: string, branch: string, linked: boolean) =>
  ({ repoKey: `${repo}/.git`, repoName: 'herdr-yoicks', repoRoot: repo, checkoutPath, isLinkedWorktree: linked, branch });
/** T0's day + `days`, at h:m UTC (the browser runs in UTC) */
const at = (days: number, h: number, m = 0) => T0 - (T0 % 86_400_000) + days * 86_400_000 + (h * 60 + m) * 60_000;
const todo = (id: string, text: string, rest: { agent?: string; url?: string; due?: number } = {}) =>
  ({ id, text, agent: rest.agent ?? null, url: rest.url ?? null, due: rest.due ?? null, createdAt: T0 - 3_600_000 });

export const state: AppState = {
  connected: true,
  herdr: { version: '0.9.5', protocol: 22 },
  focused: { workspaceId: 'w1', tabId: 't1', paneId: 'p1' },
  workspaces: [
    { workspaceId: 'w1', label: 'herdr-yoicks', cwd: repo, worktree: wt(repo, 'main', false), tabs: [
      { tabId: 't1', label: 'review', panes: [pane('p1', repo, agent('claude', 'blocked', { stateChangeSeq: 14, sinceUnixMs: T0 - 40_000, herdrName: 'review' }))] },
      { tabId: 't2', label: 'flaky-test', panes: [pane('p2', repo, agent('claude', 'working',
        { stateChangeSeq: 13, sinceUnixMs: T0 - 90_000, customStatus: 'running npm test', herdrName: 'flaky-test' }))] },
      { tabId: 't3', label: 'docs', panes: [pane('p3', repo, agent('codex', 'done', { stateChangeSeq: 12, completionSeq: 2, sinceUnixMs: T0 - 12 * 60_000 }))] },
    ] },
    { workspaceId: 'w2', label: 'herdr-yoicks-wt-image', cwd: `${repo}-wt-image`, worktree: wt(`${repo}-wt-image`, 'feat/image-paste', true), tabs: [
      { tabId: 't4', label: 'image', panes: [pane('p5', `${repo}-wt-image`, agent('claude', 'idle', { stateChangeSeq: 11, sinceUnixMs: T0 - 2 * 3_600_000 }))] },
    ] },
    { workspaceId: 'w3', label: 'personal', cwd: `${orch}/personal`, worktree: null, tabs: [
      { tabId: 't5', label: 'personal', panes: [pane('p4', `${orch}/personal`, agent('claude', 'working', { stateChangeSeq: 15, sinceUnixMs: T0 - 20_000 }))] },
    ] },
  ],
  orchestrators: [
    { name: 'personal', label: 'personal', paneId: 'p4', agents: ['p1', 'p2', 'p3', 'p4', 'p5'], mode: 'tui', headless: null, todos: [
      todo('a1b2c3', 'Merge PR #119 (the to-do list, bridge side)', { agent: 'review', url: 'https://example.com/pull/119' }),
      todo('d4e5f6', 'Rotate the ntfy token on the PC', { due: at(0, 8) }),
      todo('0a0b0c', 'Delete ~/backup.tgz', { due: at(1, 9) }),
    ] },
    { name: 'work', label: 'work', paneId: 'hl:work', agents: [], mode: 'headless', todos: [todo('1a2b3c', 'Approve the deploy of #123 at the PC')], headless: {
      status: 'blocked', completionSeq: 4, model: '', activeModel: 'claude-opus-5-5', models: [],
      pending: { id: 'q1', questions: [{ question: 'Which PR should go first?', header: 'Order', multiSelect: false,
        options: [{ label: '#112', description: 'the toast scrollbar fix' }, { label: 'PR3', description: 'the agents list' }] }] },
      usage: { fiveHour: { utilization: 0.42, resetsAt: T0 + 3_600_000 }, sevenDay: { utilization: 0.18, resetsAt: T0 + 86_400_000 }, fable: null, contextPct: 23, at: T0 - 60_000 },
      warnings: [{ kind: 'canary', message: 'The last Claude Code check failed (mcp_failure)', since: T0 - 3_600_000, actions: ['clear', 'tui'] }] } },
    { name: 'side', label: 'side', paneId: null, agents: null, mode: 'tui', headless: null, todos: [todo('4d5e6f', "Run /login in side's pane")] },
  ],
  orchestratorPaneId: 'p4',
  claudeCheck: { at: T0 - 3_600_000, version: '2.1.322', ok: true, failed: [] },
  // the workers' (p3, an agent the user runs, has none: its name shows)
  purposes: { p1: 'Review PR #119 before it merges', p2: 'Find why the sidebar test flakes', p5: 'Paste images into the Home chat' },
};

type Item = TimelineItem;
const user = (text: string, images?: string[]): Item => ({ kind: 'user', text, ...(images ? { images } : {}), sidechain: false, ts: T0 });
const said = (text: string, sidechain = false): Item => ({ kind: 'assistant', text, sidechain, ts: T0 });
const tool = (id: string, name: string, summary: string, rest: { todos?: Extract<Item, { kind: 'tool_use' }>['todos']; ask?: Extract<Item, { kind: 'tool_use' }>['ask'] } = {}): Item =>
  ({ kind: 'tool_use', id, name, summary, todos: rest.todos ?? null, ask: rest.ask ?? null, sidechain: false, ts: T0 });
const result = (forId: string, text: string, isError = false, truncated = false): Item =>
  ({ kind: 'tool_result', forId, text, truncated, isError, sidechain: false, ts: T0 });

/** By pane id; a pane without one has no transcript (its terminal shows). */
export const transcripts: Record<string, Item[]> = {
  p4: [
    user('Review the open PRs, and start a worker on the flaky test in herdr-yoicks.'),
    said("I'll look at the open PRs first, then start **flaky-test** in `herdr-yoicks`."),
    user('[yoicks] started flaky-test (pane p2): the first task was sent'),
    said('Started **flaky-test**. Two PRs are open:\n- #108 the token screen\n- #109 the toasts\n\nBoth have green CI.'),
    user('[yoicks] review: working → blocked'),
    user('This is the screenshot.', ['/icons/icon-512.png']),
  ],
  p1: [
    user('Review the diff of #109 and run the tests.'),
    said("## Review\nThe toast change looks right. I'll run the tests:"),
    tool('u1', 'Bash', 'npm test'),
    result('u1', ' Test Files  27 passed (27)\n      Tests  282 passed (282)'),
    tool('u2', 'Bash', 'go test ./...'),
  ],
  // every kind of item, for the chat's look
  p5: [
    user('Add image paste to the **composer**: see `web/src/image.ts` and https://example.com/spec'),
    { kind: 'thinking', text: 'The user wants paste support. I should check *image.ts* first.', truncated: false, sidechain: false, ts: T0 },
    said("# Plan\n\nI'll do it in **three** steps:\n\n1. Read `image.ts`\n2. Wire the paste\n   - text stays text\n   - images are scaled\n3. Test it\n\n" +
      '> Images over 1 MB are refused.\n\n## Sizes\n\n| kind | limit |\n|---|---:|\n| JPEG | 1 MB |\n| count | 4 |\n\n```ts\nexport const MAX_IMAGES = 4;\n```\n\n' +
      '---\n\n### Notes\n~~old idea~~, see [the docs](https://example.com/docs).'),
    tool('t1', 'Read', 'web/src/image.ts'),
    result('t1', 'export async function toAttachment(file: File) {\n  // scales to JPEG\n}'),
    tool('t2', 'TodoWrite', '', { todos: [{ content: 'Read image.ts', status: 'completed' }, { content: 'Wire the paste', status: 'in_progress' },
      { content: 'Write the tests', status: 'pending' }] }),
    tool('t3', 'Bash', 'npm test -- image'),
    result('t3', 'FAIL test/image.test.ts > scales a PNG\nExpected 1048576, got 2097152', true, true),
    said('The subagent found the scaling bug.', true),
    tool('t4', 'AskUserQuestion', '', { ask: [{ question: 'Which limit should the composer use?', header: 'Limit', multiSelect: false,
      options: [{ label: '1 MB', description: 'as now' }, { label: '2 MB', description: 'for screenshots' }] }] }),
    user('[yoicks] review: working → blocked'),
    said('Waiting for your answer.'),
  ],
  'hl:work': [
    user('Start a worker on the flaky ws test in herdr-yoicks.'),
    tool('a1', 'mcp__yoicks__agent_start', 'flaky-test'),
    result('a1', 'started flaky-test (pane w8H:p1) in /home/u/src/herdr-yoicks; delivered to flaky-test: you are woken when it finishes or stops for an answer'),
    said('Started **flaky-test** on it.'),
    user('[yoicks] flaky-test: working → done'),
    said('It found the race. I asked it to add a regression test too.'),
    tool('a2', 'mcp__yoicks__agent_prompt', 'flaky-test: Also add a regression test for the reconnect race in ws.test.ts, then open a PR'),
    result('a2', 'delivered to flaky-test: you are woken when it finishes or stops for an answer'),
    tool('a3', 'mcp__yoicks__agent_prompt', 'review: look at the PR again'),
    result('a3', 'not delivered to review: agent_not_found: no agent named review', true),
    user('[yoicks] flaky-test: working → done'),
    tool('a5', 'mcp__yoicks__worktree_remove', '/home/u/src/herdr-yoicks-wt-flaky-ws'),
    result('a5', 'removed /home/u/src/herdr-yoicks-wt-flaky-ws and branch flaky-ws'),
    said('PR #131 is open with the fix and its test; the worker and its worktree are gone. Which PR should go first?'),
  ],
};

const SHELL = ['\u001b[32m$\u001b[0m npm test', '', ' \u001b[32m✓\u001b[0m test/theme.test.ts (4 tests)', ' \u001b[32m✓\u001b[0m test/token.test.tsx (3 tests)', '',
  ' Test Files  27 passed (27)'].join('\n');
/** A pane's screen as ANSI (GET /api/panes/:id/read and the watch's pushes); the shell's for any other pane. */
export const screen = (paneId: string): string => ({
  p1: ['\u001b[1m●\u001b[0m Bash(npm test)', '  ⎿  Test Files  27 passed (27)', '', '────────────────────────────────────────────────', ' ☐ Tests', '',
    'Run the Go tests now as well?', '', '\u001b[36m❯ 1. Yes\u001b[0m', '     Run go test ./... in the repo', '  2. No', '     Skip them for now',
    '  3. Type something.', '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n'),
} as Record<string, string>)[paneId] ?? SHELL;

export interface Scene { name: string; hash: string; ready: string; token?: false }
const items = (scope: string) => `document.querySelectorAll(${JSON.stringify(`${scope} #chat-log .chat-item`)}).length > 0`;
/** Each one is shot on a phone and on a PC. */
export const scenes: Scene[] = [
  { name: 'agents', hash: '#/agents', ready: "!!document.querySelector('#screen-agents[data-ready]')" },
  { name: 'home', hash: '#/home/personal', ready: items('') },
  { name: 'home-headless', hash: '#/home/work', ready: `${items('')} && !!document.querySelector('.ask-opt')` },
  { name: 'home-stopped', hash: '#/home/side', ready: "!!document.querySelector('#screen-home-stopped')" },
  { name: 'pane-chat', hash: '#/pane/p5', ready: items('.agent-drawer') },
  { name: 'pane-question', hash: '#/pane/p1', ready: `${items('.agent-drawer')} && !!document.querySelector('.agent-drawer .ask-opt')` },
  { name: 'pane-terminal', hash: '#/pane/p3', ready: "!!document.querySelector('.agent-drawer #term-live')?.textContent?.trim()" },
  { name: 'settings', hash: '#/settings', ready: "!!document.querySelector('#screen-settings')" },
  { name: 'token', hash: '', ready: "!!document.querySelector('#token-input')", token: false },
];
