import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderItem, type TimelineItem } from '../src/transcript.ts';

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
  it('linkifies http(s) and mailto with safe rel/target', () => {
    const h = renderMarkdown('see [docs](https://example.com/a?b=1&c=2)');
    assert.match(h, /<a class="chat-link" href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs<\/a>/);
    assert.match(renderMarkdown('[mail](mailto:a@b.com)'), /href="mailto:a@b\.com"/);
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
});
