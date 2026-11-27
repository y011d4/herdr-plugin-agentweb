// @vitest-environment happy-dom
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { askAnswer, renderMarkdown, conversationItems, latestActivity, WORKER_NOTICE, type TimelineItem } from '../src/transcript.ts';
import { createElement } from 'react';
import { Notice } from '../src/ui/ChatLog.tsx';
import { chatHtml, htmlOf } from './render.ts';

// what ui/ChatLog.tsx draws for an item, or a notice line, as HTML
const renderItem = (item: TimelineItem): string => chatHtml(item);
const noticeHtml = (line: string): string => htmlOf(createElement(Notice, { line }));

// renderMarkdown is the chat prose renderer used for user + assistant turns.
// It must be XSS-safe (all text escaped before formatting) and dependency-free.
describe('renderMarkdown — inline', () => {
  it('renders bold, italic (* and _), and strikethrough', () => {
    const h = renderMarkdown('**b** *i* _u_ ~~s~~');
    assert.match(h, /<strong>b<\/strong>/);
    assert.match(h, /<em>i<\/em>/);
    assert.match(h, /<em>u<\/em>/);
    assert.match(h, /<del>s<\/del>/);
  });

  it('renders inline code and does not format inside it', () => {
    const h = renderMarkdown('call `run(**x**)` now');
    assert.match(h, /<code>run\(\*\*x\*\*\)<\/code>/);
    assert.doesNotMatch(h, /<strong>/);
  });

  it('does not italicize snake_case identifiers', () => {
    const h = renderMarkdown('the foo_bar_baz value');
    assert.doesNotMatch(h, /<em>/);
    assert.match(h, /foo_bar_baz/);
  });

  it('keeps ordinary spaced digits intact (placeholder-collision guard)', () => {
    // Regression: a bad placeholder scheme once ate " N " sequences.
    const h = renderMarkdown('done in 5 minutes and 3 seconds');
    assert.match(h, /done in 5 minutes and 3 seconds/);
  });
});

describe('renderMarkdown — links', () => {
  it('linkifies http(s) with safe rel/target, and nothing else', () => {
    const h = renderMarkdown('see [docs](https://example.com/a?b=1&c=2)');
    assert.match(h, /<a class="chat-link" href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
    assert.doesNotMatch(renderMarkdown('[mail](mailto:a@b.com)'), /<a /);
  });

  // The bare URL a transcript line links, or null for none.
  const bare = (md: string): string | null => /<a class="chat-link" href="([^"]*)"[^>]*>\1<\/a>/.exec(renderMarkdown(md))?.[1] ?? null;

  it('links bare http(s) URLs, with the same safe rel/target', () => {
    assert.match(renderMarkdown('PR: https://github.com/o/r/pull/1'),
      /PR: <a class="chat-link" href="https:\/\/github\.com\/o\/r\/pull\/1" target="_blank" rel="noopener noreferrer">https:\/\/github\.com\/o\/r\/pull\/1<\/a>/);
    assert.equal(bare('HTTP://EXAMPLE.COM/x'), 'HTTP://EXAMPLE.COM/x');
    assert.equal(bare('http://127.0.0.1:8392/?token=ab&x=1#y'), 'http://127.0.0.1:8392/?token=ab&amp;x=1#y');
  });

  it('cuts a bare URL before Japanese text and punctuation around it', () => {
    assert.equal(bare('詳細はhttps://example.com/docsを見て'), 'https://example.com/docs');
    for (const tail of ['。', '、', '」', '）', '』', '】', ' です']) {
      assert.equal(bare(`「https://example.com/a${tail}`), 'https://example.com/a', tail);
    }
    assert.match(renderMarkdown('見て:https://a.example/b。'), /見て:<a [^>]*>https:\/\/a\.example\/b<\/a>。/);
  });

  it('cuts trailing ASCII punctuation, emphasis markers and unopened brackets', () => {
    for (const s of ['https://a.example/b.', 'https://a.example/b,', '(see https://a.example/b)', '(see https://a.example/b).',
      '[https://a.example/b]', "'https://a.example/b'", '"https://a.example/b"', '<https://a.example/b>', 'https://a.example/b?!',
      'https://a.example/b:', 'https://a.example/b;', 'https://a.example/b&']) {
      assert.equal(bare(s), 'https://a.example/b', s);
    }
    assert.equal(bare('https://en.wikipedia.org/wiki/Foo_(bar)'), 'https://en.wikipedia.org/wiki/Foo_(bar)');
    assert.equal(bare('https://a.example/x_y_z/'), 'https://a.example/x_y_z/', 'underscores inside stay (no <em>)');
    assert.match(renderMarkdown('**https://a.example/b**'), /<strong><a [^>]*>https:\/\/a\.example\/b<\/a><\/strong>/);
  });

  it('leaves code, markdown link text and non-http schemes alone', () => {
    assert.doesNotMatch(renderMarkdown('`https://a.example/b`'), /<a /);
    assert.doesNotMatch(renderMarkdown('```\nhttps://a.example/b\n```'), /<a /);
    assert.equal((renderMarkdown('[https://a.example](https://b.example)').match(/<a /g) ?? []).length, 1, 'no anchor inside an anchor');
    for (const s of ['javascript:alert(1)', 'data:text/html,x', 'ftp://a.example', 'https://', 'see http:// then']) {
      assert.doesNotMatch(renderMarkdown(s), /<a /, s);
    }
  });

  it('keeps a bare URL from breaking out of its href', () => {
    const h = renderMarkdown('https://a.example/"onmouseover="alert(1) https://a.example/<img src=x onerror=alert(1)>');
    assert.doesNotMatch(h, /<img|" ?onmouseover=/);
    assert.equal(bare('https://a.example/"x'), 'https://a.example/');
  });

  it('resolves inline code nested inside link text (no leaked placeholder)', () => {
    const h = renderMarkdown('run [`ls -la`](https://example.com)');
    assert.match(h, /<a class="chat-link" href="https:\/\/example\.com"[^>]*><code>ls -la<\/code><\/a>/);
    assert.doesNotMatch(h, /u0000/); // the internal sentinel must never leak to output
  });

  it('refuses javascript:/data: URLs — leaves literal text, no href', () => {
    const h = renderMarkdown('[x](javascript:alert(1))');
    assert.doesNotMatch(h, /href=/);
    assert.doesNotMatch(h, /<a /);
    assert.match(h, /\[x\]\(javascript:alert\(1\)\)/);
  });
});

describe('renderMarkdown — blocks', () => {
  it('renders ATX headings h1–h6', () => {
    assert.match(renderMarkdown('# Title'), /<h1 class="chat-h chat-h1">Title<\/h1>/);
    assert.match(renderMarkdown('### Sub'), /<h3 class="chat-h chat-h3">Sub<\/h3>/);
  });

  it('renders unordered and ordered lists', () => {
    assert.match(renderMarkdown('- a\n- b'), /<ul class="chat-ul"><li>a<\/li><li>b<\/li><\/ul>/);
    assert.match(renderMarkdown('1. a\n2. b'), /<ol class="chat-ol"><li>a<\/li><li>b<\/li><\/ol>/);
  });

  it('nests lists by indentation inside the parent li', () => {
    const h = renderMarkdown('- a\n  - a1\n  - a2\n- b');
    assert.match(h, /<li>a<ul class="chat-ul"><li>a1<\/li><li>a2<\/li><\/ul><\/li>/);
    assert.match(h, /<li>b<\/li>/);
  });

  it('does not drop list items when a leading-indented item later dedents', () => {
    const h = renderMarkdown('  - a\n- b');
    assert.match(h, /<li>a<\/li>/);
    assert.match(h, /<li>b<\/li>/); // must not be swallowed when buildList stops early
  });

  it('renders blockquotes (recursively) and horizontal rules', () => {
    assert.match(renderMarkdown('> quoted **b**'), /<blockquote class="chat-quote"><p class="chat-p">quoted <strong>b<\/strong><\/p><\/blockquote>/);
    assert.match(renderMarkdown('---'), /<hr class="chat-hr">/);
  });

  it('keeps fenced code blocks verbatim and escaped, dropping the lang line', () => {
    const h = renderMarkdown('text\n```js\nconst a = 1 < 2;\n```');
    assert.match(h, /<pre class="chat-code" data-lang="js"><code>const a = 1 &lt; 2;<\/code><\/pre>/);
    assert.match(h, /<p class="chat-p">text<\/p>/);
  });

  it('renders GFM tables with alignment', () => {
    const h = renderMarkdown('| A | B |\n|:--|--:|\n| 1 | 2 |');
    assert.match(h, /<table class="chat-table">/);
    assert.match(h, /<th style="text-align:left">A<\/th>/);
    assert.match(h, /<th style="text-align:right">B<\/th>/);
    assert.match(h, /<td style="text-align:right">2<\/td>/);
  });

  it('joins wrapped paragraph lines with <br>', () => {
    assert.match(renderMarkdown('line one\nline two'), /<p class="chat-p">line one<br>line two<\/p>/);
  });
});

describe('renderMarkdown — safety', () => {
  it('escapes raw HTML so transcripts cannot inject markup', () => {
    const h = renderMarkdown('<script>alert(1)</script> & "quote"');
    assert.doesNotMatch(h, /<script>/);
    assert.match(h, /&lt;script&gt;/);
    assert.match(h, /&amp; &quot;quote&quot;/);
  });

  it('drops a literal \\u0000 sentinel from input rather than corrupting output', () => {
    const h = renderMarkdown('x\\u0000y'); // 6-char literal that mimics the internal placeholder
    assert.match(h, /xy/);
    assert.doesNotMatch(h, /undefined/);
  });
});

describe('renderItem — assistant + user turns use the markdown renderer', () => {
  it('wraps assistant prose in chat-md and renders markdown', () => {
    const item: TimelineItem = { kind: 'assistant', text: '# Hi\n\n- one', sidechain: false, ts: null };
    const h = renderItem(item);
    assert.match(h, /class="chat-item chat-assistant"/);
    assert.match(h, /<div class="chat-md"><h1 class="chat-h chat-h1">Hi<\/h1><ul class="chat-ul"><li>one<\/li><\/ul><\/div>/);
  });

  it('renders user prompt markdown inside the bubble', () => {
    const item: TimelineItem = { kind: 'user', text: 'run `ls` please', sidechain: false, ts: null };
    const h = renderItem(item);
    assert.match(h, /class="chat-bubble chat-md"/);
    assert.match(h, /<code>ls<\/code>/);
  });

  it("splits the bridge's [yoicks] lines at either end of a user turn from the user's own words", () => {
    const user = (text: string): string => renderItem({ kind: 'user', text, sidechain: false, ts: null });
    const shown = (h: string): string[] => [...h.matchAll(/class="chat-item (chat-notice|chat-user)">(.*?)<\/div>/g)]
      .map((m) => `${m[1]}: ${m[2].replace(/<[^>]+>/g, '')}`);
    assert.deepEqual(shown(user('[yoicks] w-a: working → done')), ['chat-notice: [yoicks] w-a: working → done']);
    assert.deepEqual(shown(user('[yoicks] w-a: working → done\n[yoicks] w-b: working → blocked')),
      ['chat-notice: [yoicks] w-a: working → done', 'chat-notice: [yoicks] w-b: working → blocked']);
    // one turn as Claude Code stores it (one string): the notice, then the user's own question
    assert.deepEqual(shown(user('[yoicks] w-a: working → done\n\nこんな感じの表示が出ますが')),
      ['chat-notice: [yoicks] w-a: working → done', 'chat-user: こんな感じの表示が出ますが']);
    assert.deepEqual(shown(user('見て\n\n[yoicks] w-a: working → done')), ['chat-user: 見て', 'chat-notice: [yoicks] w-a: working → done']);
    // only the ends: one in the middle, or not at a line's start, stays the user's
    assert.deepEqual(shown(user('a\n[yoicks] x\nb')), ['chat-user: a[yoicks] xb']);
    assert.deepEqual(shown(user('see [yoicks] x')), ['chat-user: see [yoicks] x']);
    assert.doesNotMatch(user('- this:\n  [yoicks] w-a: done'), /chat-notice/); // indented: a list item's line
  });

  it("makes a worker's name in a notice a button that opens it (data-agent); the rest stays text, escaped", () => {
    const btn = (n: string): string => `<button type="button" class="chat-notice-agent" data-agent="${n}">${n}</button>`;
    assert.equal(noticeHtml('[yoicks] w-a: working → done'), `[yoicks] ${btn('w-a')}: working → done`);
    assert.equal(noticeHtml('[yoicks] w-a: done → idle, ready, task not sent'), `[yoicks] ${btn('w-a')}: done → idle, ready, task not sent`);
    assert.equal(noticeHtml('[yoicks] started w_b2 (pane w8:p1) in /x <y>; sent'), `[yoicks] started ${btn('w_b2')} (pane w8:p1) in /x &lt;y&gt;; sent`);
    // not a worker: the bridge's own word, a name herdr wouldn't take, nothing after it
    for (const l of ['[yoicks] restarted while you were working; check overview.', '[yoicks] W-A: x → y', '[yoicks] w-a', '[yoicks] <b>: x']) {
      assert.doesNotMatch(noticeHtml(l), /<button/, l);
    }
    assert.equal(noticeHtml('[yoicks] <b>: x'), '[yoicks] &lt;b&gt;: x');
    assert.match(renderItem({ kind: 'user', text: '[yoicks] w-a: working → done', sidechain: false, ts: null }), /class="chat-item chat-notice">\[yoicks\] <button[^>]*data-agent="w-a"/);
  });
});

describe('conversationItems / latestActivity (home chat)', () => {
  const u = (text: string, sidechain = false): TimelineItem => ({ kind: 'user', text, sidechain, ts: null });
  const a = (text: string, sidechain = false): TimelineItem => ({ kind: 'assistant', text, sidechain, ts: null });
  const tool = (name: string, summary: string): TimelineItem =>
    ({ kind: 'tool_use', id: name, name, summary, todos: null, ask: null, sidechain: false, ts: null });
  const result: TimelineItem = { kind: 'tool_result', forId: 'x', text: 'out', truncated: false, isError: false, sidechain: false, ts: null };

  it('keeps only the user/assistant words, dropping tools, injected turns and subagents', () => {
    const items = [u('fix it'), tool('Bash', 'herdr agent list'), result, u('<task-notification> done'), a('sub', true), a('done!')];
    assert.deepEqual(conversationItems(items).map((i) => (i as { text: string }).text), ['fix it', 'done!']);
  });

  it("keeps a question (AskUserQuestion) and shows its answer as the user's, across appends", () => {
    const ask: TimelineItem = { kind: 'tool_use', id: 'q1', name: 'AskUserQuestion', summary: '', todos: null,
      ask: [{ question: '好きな果物は？', header: '果物', multiSelect: false, options: [{ label: 'りんご', description: '' }] }], sidechain: false, ts: null };
    const answered = (forId: string, text: string, isError = false): TimelineItem => ({ kind: 'tool_result', forId, text, truncated: false, isError, sidechain: false, ts: 5 });
    const asks = new Map();
    assert.deepEqual(conversationItems([u('聞いて'), ask], asks).map((i) => i.kind), ['user', 'tool_use']);
    // the answer arrives in a later append (Claude Code's wording, as on 2.1.322)
    const later = conversationItems([answered('q1', 'Your questions have been answered: "好きな果物は？"="ばなな \\"完熟\\"". You can now continue with these answers in mind.'), result], asks);
    assert.deepEqual(later, [{ kind: 'user', text: 'ばなな "完熟"', sidechain: false, ts: 5 }]);
    // several questions: one line each; no answer named (refused, interrupted): the result as it is
    assert.equal(askAnswer('answered: "A?"="x", "B?"="y, z". Go on.'), 'A?: x\nB?: y, z');
    assert.equal(conversationItems([answered('q1', 'ほげ', true)], asks)[0].kind, 'tool_result');
    // a result cut short may name only some answers: it stays as it is, its "truncated" with it
    const cut = { ...answered('q1', 'answered: "A?"="x", "B?"="y'), truncated: true } as TimelineItem;
    assert.equal(conversationItems([cut], asks)[0].kind, 'tool_result');
    // Chat about this (Claude Code's refusal, the bridge's /answer {chat}): a dim notice, not the refusal's words
    const chat = conversationItems([answered('q1', 'The user wants to clarify these questions.\n    This means they may…\n- "好きな果物は？"\n  (No answer provided)', true)], asks);
    assert.deepEqual(chat, [{ kind: 'user', text: '[yoicks] Chat about this', sidechain: false, ts: 5 }]);
    assert.match(renderItem(chat[0]), /class="chat-item chat-notice"/);
    // the answers given before it stay, a line each (as the bridge's clarify lists them)
    const listed = 'The user wants to clarify these questions.\n    Questions asked:\n- "好きな果物は？"\n  Answer: ばなな, りんご\n- "いつ？"\n  (No answer provided)\n- "量は？"\n  Answer: 2 個\nくらい';
    assert.deepEqual(conversationItems([answered('q1', listed, true)], asks).map((i) => (i as { text: string }).text),
      ['好きな果物は？: ばなな, りんご\n量は？: 2 個\nくらい', '[yoicks] Chat about this']);
    // cut short (a long one): the entries before the cut, the cut one left out
    const long = { ...answered('q1', listed.slice(0, -4), true), truncated: true } as TimelineItem;
    assert.deepEqual(conversationItems([long], asks).map((i) => (i as { text: string }).text), ['好きな果物は？: ばなな, りんご', '[yoicks] Chat about this']);
    // an answer that only quotes those words is still an answer
    const quoted = 'The user answered: "好きな果物は？"="The user wants to clarify these questions.\\n". Read the answers carefully.';
    assert.equal(conversationItems([answered('q1', quoted)], asks)[0].kind, 'user');
    assert.notEqual((conversationItems([answered('q1', quoted)], asks)[0] as { text: string }).text, '[yoicks] Chat about this');
  });

  it("shows a worker the headless orchestrator started as a [yoicks] notice of the bridge's answer, across appends", () => {
    const start: TimelineItem = { kind: 'tool_use', id: 's1', name: 'mcp__yoicks__agent_start', summary: '', todos: null, ask: null, sidechain: false, ts: null };
    const res = (forId: string, text: string, isError = false): TimelineItem => ({ kind: 'tool_result', forId, text, truncated: false, isError, sidechain: false, ts: 7 });
    const calls = new Map();
    assert.deepEqual(conversationItems([u('頼んで'), start], calls).map((i) => i.kind), ['user']);
    // the bridge's answer, as on 11-26's personal session: one line, a dim notice
    const shown = conversationItems([res('s1', 'started w-a (pane w8H:p1) in /r; delivered to w-a: you are woken when it finishes or stops for an answer'), result], calls);
    assert.deepEqual(shown, [{ kind: 'user', text: '[yoicks] started w-a (pane w8H:p1) in /r; delivered to w-a: you are woken when it finishes or stops for an answer', sidechain: false, ts: 7 }]);
    assert.match(renderItem(shown[0]), /class="chat-item chat-notice"/);
    // not delivered (an error result) says so too, on one line
    assert.deepEqual(conversationItems([res('s1', 'started w-a (pane p) in /r; not delivered to w-a:\nagent_pane_busy', true)], calls).map((i) => (i as { text: string }).text),
      ['[yoicks] started w-a (pane p) in /r; not delivered to w-a: agent_pane_busy']);
    // another tool's result stays hidden
    assert.deepEqual(conversationItems([tool('mcp__yoicks__agent_read', 'w-a'), res('mcp__yoicks__agent_read', 'screen')], calls), []);
  });

  it('shows a task sent to a worker (agent_prompt) and a removed worktree as [yoicks] notices', () => {
    const res = (forId: string, text: string, isError = false): TimelineItem => ({ kind: 'tool_result', forId, text, truncated: false, isError, sidechain: false, ts: 8 });
    const call = (id: string, name: string, summary: string): TimelineItem => ({ ...tool(name, summary), id } as TimelineItem);
    const prompt = (id: string, summary: string): TimelineItem => call(id, 'mcp__yoicks__agent_prompt', summary);
    const calls = new Map();
    const texts = (items: TimelineItem[]): string[] => conversationItems(items, calls).map((i) => (i as { text: string }).text);
    // its summary is `<name>: <the text's first line>` (transcript_normalize.go); the call alone shows nothing
    assert.deepEqual(texts([prompt('p1', 'w-a: Also add a test for the redirect'), prompt('p2', 'w-a: /exit'), prompt('p3', 'w-a: ' + 'あ'.repeat(60)),
      prompt('p4', `w-a: ${'x'.repeat(49)} and more`)]), []);
    const delivered = 'delivered to w-a: you are woken when it finishes or stops for an answer';
    // delivered: the task's first line, cut short (no space left before the …); /exit is just such a task
    assert.deepEqual(texts([res('p1', delivered), res('p2', delivered), res('p3', delivered), res('p4', delivered)]),
      ['[yoicks] sent to w-a: Also add a test for the redirect', '[yoicks] sent to w-a: /exit', `[yoicks] sent to w-a: ${'あ'.repeat(50)}…`, `[yoicks] sent to w-a: ${'x'.repeat(49)}…`]);
    // not delivered: the bridge's reason, without its own "not delivered to <name>:" / "task not sent:"
    assert.deepEqual(texts([
      prompt('f1', 'w-a: go'), res('f1', 'not delivered to w-a:\nagent_not_found', true),
      prompt('f2', 'w-a: go'), res('f2', 'task not sent: w-a waits on a question in its pane; you are woken when it is ready'),
      prompt('f3', 'w-b: go'), res('f3', 'refused: w-b is not an agent of this Claude account', true),
    ]), ['[yoicks] not sent to w-a: agent_not_found', '[yoicks] not sent to w-a: w-a waits on a question in its pane; you are woken when it is ready',
      '[yoicks] not sent to w-b: refused: w-b is not an agent of this Claude account']);
    // the worker's name is a button, as in the other notices (ui/ChatLog.tsx's Notice draws WORKER_NOTICE's [2] as one)
    assert.deepEqual(WORKER_NOTICE.exec('[yoicks] sent to w-a: /exit')?.slice(1), ['[yoicks] sent to ', 'w-a', ': /exit']);
    assert.deepEqual(WORKER_NOTICE.exec('[yoicks] not sent to w-a: x')?.slice(1), ['[yoicks] not sent to ', 'w-a', ': x']);
    // a removed worktree: the bridge's answer, as agent_start's
    assert.deepEqual(texts([call('r1', 'mcp__yoicks__worktree_remove', '/r-wt-x'), res('r1', 'removed /r-wt-x and branch x'),
      call('r2', 'mcp__yoicks__worktree_remove', '/r-wt-y'), res('r2', 'refused: an agent still runs in it (end it with /exit first); /r-wt-y was left as it is', true)]),
    ['[yoicks] removed /r-wt-x and branch x', '[yoicks] refused: an agent still runs in it (end it with /exit first); /r-wt-y was left as it is']);
  });

  it('hides only Claude Code\'s injected tags, not user text that starts with "<"', () => {
    const injected = ['<system-reminder>x', '<local-command-stdout>x', '<command-name>/clear</command-name>', '<bash-input>ls'];
    const own = ['<pasted_content>log</pasted_content>', '<div> is broken', '< 3 items?'];
    assert.deepEqual(conversationItems([...injected, ...own].map((t) => u(t))).map((i) => (i as { text: string }).text), own);
  });

  it('tracks the latest tool since the agent last spoke, across appends', () => {
    const first = latestActivity([u('go'), tool('Bash', 'herdr agent start w-x')], null);
    assert.equal(first, 'Bash herdr agent start w-x');
    assert.equal(latestActivity([result], first), first); // a result keeps the step shown
    assert.equal(latestActivity([a('started w-x')], first), null); // it spoke: thinking/writing again
  });
});

describe('renderItem — images', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  it("shows a user turn's images under its words, or alone", () => {
    const h = renderItem({ kind: 'user', text: 'what is it?', images: [png, png], sidechain: false, ts: null });
    assert.match(h, /^<div class="chat-item chat-user"><div class="chat-bubble chat-md"><p class="chat-p">what is it\?<\/p><\/div><\/div><div class="chat-item chat-user chat-images">/);
    assert.equal(h.split(`<img class="chat-image" alt="image" src="${png}">`).length, 3);
    assert.equal(renderItem({ kind: 'user', text: '', images: [png], sidechain: false, ts: null }),
      `<div class="chat-item chat-user chat-images"><button type="button" class="chat-image-open" aria-label="View image"><img class="chat-image" alt="image" src="${png}"></button></div>`);
  });
  it('escapes a src', () => {
    assert.doesNotMatch(renderItem({ kind: 'user', text: '', images: ['x" onerror="y'], sidechain: false, ts: null }), /" onerror/);
  });
});
