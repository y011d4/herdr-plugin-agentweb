/**
 * transcript.ts — render Claude Code transcript TimelineItems to HTML for the
 * chat view. Pure string-building; no DOM state. app.ts owns the container and
 * live updates.
 *
 * TimelineItem is duplicated from server/transcript-normalize.ts — the web and
 * server are separate tsc projects that share only the wire contract (same rule
 * as types.ts). Keep the two in sync.
 */

export interface TodoEntry {
  content: string;
  status: string;
}

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskOption[];
}

export type TimelineItem =
  | { kind: 'user'; text: string; sidechain: boolean; ts: number | null }
  | { kind: 'assistant'; text: string; sidechain: boolean; ts: number | null }
  | { kind: 'thinking'; text: string; truncated: boolean; sidechain: boolean; ts: number | null }
  | { kind: 'tool_use'; id: string; name: string; summary: string; todos: TodoEntry[] | null; ask: AskQuestion[] | null; sidechain: boolean; ts: number | null }
  | { kind: 'tool_result'; forId: string | null; text: string; truncated: boolean; isError: boolean; sidechain: boolean; ts: number | null };

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Only http(s)/mailto links become anchors; anything else (javascript:, data:,
// relative paths) is left as literal text so a transcript can't smuggle a
// script-URL into an href. `url` arrives already HTML-escaped.
function safeUrl(url: string): string | null {
  const probe = url.replace(/&amp;/g, '&').trim().toLowerCase();
  return /^(https?:\/\/|mailto:)/.test(probe) ? url : null;
}

// Emphasis on already-escaped text: ~~del~~, **bold**, __bold__, *em*, _em_.
// Bold runs before italic so `**x**` isn't mis-split. `_` emphasis is guarded by
// word boundaries so snake_case in prose survives.
function emphasis(s: string): string {
  return s
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, '<em>$1</em>')
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w])/g, '$1<em>$2</em>');
}

// Inline markdown on raw text: escape, then `code` and [links] (protected from
// emphasis via placeholders), then emphasis. Returns HTML with no line handling.
function renderInline(raw: string): string {
  const stash: string[] = [];
  const put = (html: string): string => `\\u0000${stash.push(html) - 1}\\u0000`;
  const s = escapeHtml(raw.replace(/\\u0000/g, '')) // strip the placeholder sentinel from input
    .replace(/`([^`\n]+)`/g, (_m, c) => put(`<code>${c}</code>`))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeUrl(url);
      return href
        ? put(`<a class="chat-link" href="${href}" target="_blank" rel="noopener noreferrer">${emphasis(text)}</a>`)
        : m;
    });
  // Restore looped, not single-pass: a stashed link/code span can itself contain
  // a lower-indexed placeholder (e.g. `code` inside link text). Each pass resolves
  // one nesting level; indices only decrease, so it terminates.
  let out = emphasis(s);
  while (/\\u0000\d+\\u0000/.test(out)) {
    out = out.replace(/\\u0000(\d+)\\u0000/g, (_m, i) => stash[Number(i)] ?? '');
  }
  return out;
}

// Inline-only markdown that preserves line breaks (for the thinking block).
function inlineMd(s: string): string {
  return renderInline(s).replace(/\n/g, '<br>');
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HR_RE = /^ {0,3}([-*_])[ \t]*(\1[ \t]*){2,}$/;

interface ListItem { indent: number; ordered: boolean; content: string; }

// A line that ends the current paragraph because it opens a different block.
function isBlockStart(line: string): boolean {
  return /^ {0,3}#{1,6}\s/.test(line) || /^ {0,3}>/.test(line) || HR_RE.test(line) || LIST_RE.test(line);
}

// Build nested <ul>/<ol> from a flat, indent-tagged item list. Items deeper than
// the current level are attached inside the preceding <li>.
function buildList(items: ListItem[], start: number, indent: number): { html: string; next: number } {
  const ordered = items[start].ordered;
  let html = ordered ? '<ol class="chat-ol">' : '<ul class="chat-ul">';
  let i = start;
  while (i < items.length && items[i].indent >= indent) {
    if (items[i].indent > indent) {
      const nested = buildList(items, i, items[i].indent);
      html = html.replace(/<\/li>$/, `${nested.html}</li>`);
      i = nested.next;
      continue;
    }
    html += `<li>${items[i].content}</li>`;
    i++;
  }
  return { html: html + (ordered ? '</ol>' : '</ul>'), next: i };
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

// A GFM table: header row + `---|:--:` separator + body rows. Returns null if the
// separator doesn't line up, so the caller falls back to paragraph rendering.
function renderTable(lines: string[], start: number): { html: string; next: number } | null {
  const sep = lines[start + 1];
  if (!/^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/.test(sep)) return null;
  const header = splitRow(lines[start]);
  const align = splitRow(sep).map((c) => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? ' style="text-align:center"' : r ? ' style="text-align:right"' : l ? ' style="text-align:left"' : '';
  });
  let i = start + 2;
  const rows: string[][] = [];
  while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
    rows.push(splitRow(lines[i]));
    i++;
  }
  const th = header.map((c, k) => `<th${align[k] ?? ''}>${renderInline(c)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${header.map((_c, k) => `<td${align[k] ?? ''}>${renderInline(r[k] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  return { html: `<div class="chat-table-wrap"><table class="chat-table"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`, next: i };
}

// Parse a fence-free text region into block-level HTML: headings, lists,
// blockquotes (recursive), tables, horizontal rules, and paragraphs.
function renderBlocks(text: string): string {
  const lines = text.split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    const h = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      html += `<h${lvl} class="chat-h chat-h${lvl}">${renderInline(h[2])}</h${lvl}>`;
      i++;
      continue;
    }

    if (HR_RE.test(line)) { html += '<hr class="chat-hr">'; i++; continue; }

    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quote.push(lines[i].replace(/^ {0,3}>[ \t]?/, ''));
        i++;
      }
      html += `<blockquote class="chat-quote">${renderBlocks(quote.join('\n'))}</blockquote>`;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length) {
      const table = renderTable(lines, i);
      if (table) { html += table.html; i = table.next; continue; }
    }

    if (LIST_RE.test(line)) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), content: renderInline(m[3]) });
          i++;
        } else if (items.length && /^\s+\S/.test(lines[i])) {
          items[items.length - 1].content += ` ${renderInline(lines[i].trim())}`; // lazy continuation
          i++;
        } else {
          break;
        }
      }
      html += buildList(items, 0, items[0].indent).html;
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    html += `<p class="chat-p">${renderInline(para.join('\n')).replace(/\n/g, '<br>')}</p>`;
  }
  return html;
}

// Full-ish markdown for chat prose: fenced code blocks are kept verbatim in
// <pre>; every other region is block-parsed. Dependency-free and XSS-safe (all
// text is escaped before formatting; only http(s)/mailto links become anchors).
export function renderMarkdown(src: string): string {
  const parts = src.replace(/\\u0000/g, '').split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const seg = parts[i];
      const nl = seg.indexOf('\n');
      const first = nl >= 0 ? seg.slice(0, nl).trim() : '';
      const body = nl >= 0 ? seg.slice(nl + 1) : seg; // drop the ```lang line
      const lang = /^[\w+.-]+$/.test(first) ? ` data-lang="${escapeHtml(first)}"` : '';
      html += `<pre class="chat-code"${lang}><code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`;
    } else {
      html += renderBlocks(parts[i]);
    }
  }
  return html;
}

const TODO_MARK: Record<string, string> = { completed: '&#10003;', in_progress: '&#9656;', pending: '&#9675;' };

function renderTodos(todos: TodoEntry[]): string {
  const rows = todos
    .map((t) => `<li class="todo-${escapeHtml(t.status)}"><span class="todo-mark">${TODO_MARK[t.status] ?? '&#9675;'}</span>${escapeHtml(t.content)}</li>`)
    .join('');
  return `<ul class="chat-todos">${rows}</ul>`;
}

// Render AskUserQuestion questions + options read-only, for transcript history.
// Interactive answering (buttons) is owned by the prompt panel in app.ts, which
// unifies AskUserQuestion options and options parsed from a live TUI prompt.
export function renderAskQuestions(ask: AskQuestion[]): string {
  return ask.map((q) => {
    const header = q.header ? `<span class="ask-q-header">${escapeHtml(q.header)}</span>` : '';
    const opts = q.options.map((op, oi) => {
      const num = `<span class="ask-opt-num">${oi + 1}</span>`;
      const label = `<span class="ask-opt-label">${escapeHtml(op.label)}</span>`;
      const desc = op.description ? `<span class="ask-opt-desc">${escapeHtml(op.description)}</span>` : '';
      return `<li class="ask-opt-static">${num}${label}${desc}</li>`;
    }).join('');
    return `<div class="ask-q">${header}<div class="ask-q-text">${escapeHtml(q.question)}</div><ul class="ask-opts-static">${opts}</ul></div>`;
  }).join('');
}

/** Render a single TimelineItem to a self-contained HTML block (safe to append). */
export function renderItem(item: TimelineItem): string {
  const sub = item.sidechain ? ' chat-sidechain' : '';
  const subTag = item.sidechain ? '<span class="chat-sub-tag">subagent</span>' : '';
  switch (item.kind) {
    case 'user':
      return `<div class="chat-item chat-user${sub}">${subTag}<div class="chat-bubble chat-md">${renderMarkdown(item.text)}</div></div>`;
    case 'assistant':
      return `<div class="chat-item chat-assistant${sub}">${subTag}<div class="chat-md">${renderMarkdown(item.text)}</div></div>`;
    case 'thinking':
      return `<div class="chat-item chat-thinking-wrap${sub}"><details class="chat-thinking"><summary>Thinking</summary><div class="chat-thinking-body">${inlineMd(item.text)}${item.truncated ? '<span class="chat-more">…</span>' : ''}</div></details></div>`;
    case 'tool_use': {
      // AskUserQuestion renders as a labelled question card (read-only in
      // history; the pending prompt gets interactive buttons via the prompt panel).
      if (item.name === 'AskUserQuestion' && item.ask && item.ask.length) {
        return `<div class="chat-item chat-tool chat-ask${sub}"><div class="chat-tool-head"><span class="chat-tool-name">Question</span></div>${renderAskQuestions(item.ask)}</div>`;
      }
      const todos = item.name === 'TodoWrite' && item.todos ? renderTodos(item.todos) : '';
      const summary = item.summary ? `<span class="chat-tool-summary">${escapeHtml(item.summary)}</span>` : '';
      return `<div class="chat-item chat-tool${sub}"><div class="chat-tool-head"><span class="chat-tool-name">${escapeHtml(item.name)}</span>${summary}</div>${todos}</div>`;
    }
    case 'tool_result': {
      const err = item.isError ? ' chat-result-error' : '';
      const more = item.truncated ? '\n… (truncated)' : '';
      const label = item.isError ? 'Error' : 'Result';
      return `<div class="chat-item chat-result-wrap${sub}"><details class="chat-result${err}"><summary>${label}</summary><pre class="chat-result-body">${escapeHtml(item.text + more)}</pre></details></div>`;
    }
  }
}

/** Render a list of items to a single HTML string. */
export function renderItems(items: TimelineItem[]): string {
  return items.map(renderItem).join('');
}
