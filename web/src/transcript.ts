/**
 * transcript.ts — Claude Code's transcript items (TimelineItem) for the chat view, pure: the markdown
 * of its prose as escaped HTML (renderMarkdown, inlineMarkdown), the [yoicks] notices of a user turn,
 * and what a Home's chat keeps (conversationItems, latestActivity). ui/ChatLog.tsx draws the items;
 * pane-view.ts owns the container and its live updates.
 *
 * TimelineItem mirrors the Go bridge's (internal/bridge/types.go): the two share
 * only the wire contract (same rule as types.ts). Keep the two in sync.
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
  // images: the ones sent with it, as data: URLs (absent when none)
  | { kind: 'user'; text: string; images?: string[]; sidechain: boolean; ts: number | null }
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

// Only http(s) links become anchors; anything else (javascript:, data:, mailto:,
// relative paths) is left as literal text so a transcript can't smuggle a
// script-URL into an href. `url` arrives already HTML-escaped.
function safeUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

// A bare http(s) URL in escaped text: printable ASCII except `&` (only as `&amp;`) and `\`,
// so it ends at whitespace, `&lt;`/`&gt;`/`&quot;`, a stash placeholder, and at any
// non-ASCII character: Japanese around it (「詳細はhttps://a.b/cを見て。」) stays text.
// ponytail: a raw non-ASCII path (https://ja.wikipedia.org/wiki/東京) links only up to its
// first non-ASCII character; percent-encoded paths link whole.
const BARE_URL_RE = /https?:\/\/(?:&amp;|[\x21-\x25\x27-\x5b\x5d-\x7e])+/gi;

// GFM's autolink tail: trailing punctuation, a trailing `&`, and a `)`/`]` the URL
// doesn't open itself aren't part of it ("(see https://a.b/c).", "**https://a.b**").
function trimUrlTail(url: string): string {
  for (;;) {
    const t = url.replace(/(?:[.,:;!?*_~']|&amp;)+$/, '');
    const close = t.slice(-1);
    const open = close === ')' ? '(' : close === ']' ? '[' : '';
    if (!open || t.split(close).length <= t.split(open).length) return t;
    url = t.slice(0, -1);
  }
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

// Inline markdown on raw text: escape, then `code`, [links] and bare URLs (protected
// from emphasis via placeholders), then emphasis. Returns HTML with no line handling.
function renderInline(raw: string): string {
  const stash: string[] = [];
  const put = (html: string): string => `\\u0000${stash.push(html) - 1}\\u0000`;
  const link = (href: string, html: string): string =>
    put(`<a class="chat-link" href="${href}" target="_blank" rel="noopener noreferrer">${html}</a>`);
  const s = escapeHtml(raw.replace(/\\u0000/g, '')) // strip the placeholder sentinel from input
    .replace(/`([^`\n]+)`/g, (_m, c) => put(`<code>${c}</code>`))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
      const href = safeUrl(url);
      return href ? link(href, emphasis(text)) : m;
    })
    .replace(BARE_URL_RE, (m) => {
      const url = trimUrlTail(m);
      return /\/\/./.test(url) ? link(url, url) + m.slice(url.length) : m;
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

/** Inline-only markdown that preserves line breaks (the thinking block), as HTML: escaped, as renderMarkdown's. */
export function inlineMarkdown(s: string): string {
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
      // Emit one list per indentation run, following buildList's returned `next`,
      // so a leading-indented item that later dedents (e.g. "  - a" then "- b")
      // doesn't drop the items buildList stops before.
      let start = 0;
      while (start < items.length) {
        const built = buildList(items, start, items[start].indent);
        html += built.html;
        start = built.next;
      }
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
// text is escaped before formatting; only http(s) links become anchors).
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

// the bridge writes each of its lines at a line's start: an indented one is the user's (a list item's, a quote's)
const YOICKS_NOTICE = /^\[yoicks\] /;
// a notice about a worker, named as herdr names agents: its status change (`<name>: <from> → <to>`), start
// (`started <name> (pane …`) or task (`sent to <name>: …`, `not sent to <name>: …`); the name is a button that
// opens it (ui/ChatLog.tsx's Notice): [1] what comes before it, [2] the name, [3] the rest
export const WORKER_NOTICE = /^(\[yoicks\] (?:started |(?:not )?sent to )?)([a-z][a-z0-9_-]{0,31})((?:: | \(pane ).*)$/s;

/**
 * A user turn's leading and trailing `[yoicks] …` lines (the bridge's own word to a headless
 * orchestrator: a worker's status change or start, a restart), apart from the user's own words
 * between them: one turn can hold both (a notice pasted into a message, say).
 */
export function splitNotices(text: string): { before: string[]; body: string; after: string[] } {
  const lines = text.split('\n');
  const edge = (l: string): boolean => YOICKS_NOTICE.test(l) || !l.trim();
  let a = 0;
  let b = lines.length;
  while (a < b && edge(lines[a])) a++;
  while (b > a && edge(lines[b - 1])) b--;
  const notices = (ls: string[]): string[] => ls.filter((l) => YOICKS_NOTICE.test(l)).map((l) => l.trim());
  return { before: notices(lines.slice(0, a)), body: lines.slice(a, b).join('\n'), after: notices(lines.slice(b)) };
}

// User turns Claude Code writes itself: background-task wakeups, reminders, slash
// commands and their output, `!` shell runs. (`<pasted_content>` is the user's
// own paste, so it stays.)
const INJECTED_USER_TURN = /^\s*<(task-notification|system-reminder|local-command-[\w-]+|command-(name|message|args)|bash-(input|stdout|stderr))>/;

// Claude Code's AskUserQuestion result: `… "<question>"="<answer>", "<question>"="<answer>". …`
const ASK_ANSWER = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
const unquote = (s: string): string => s.replace(/\\(.)/g, '$1');

/** What an AskUserQuestion result says was answered: the answer, or `question: answer` per line
 *  for several; null when it names none (refused, interrupted). */
export function askAnswer(text: string): string | null {
  const pairs = [...text.matchAll(ASK_ANSWER)].map((m) => [unquote(m[1]), unquote(m[2])]);
  if (!pairs.length) return null;
  return pairs.length === 1 ? pairs[0][1] : pairs.map(([q, a]) => `${q}: ${a}`).join('\n');
}

// a question's result when the user chose Chat about this: Claude Code's words for it (the bridge's
// /answer {chat}), recorded as a refused tool's are, the message alone as an error. It lists each
// question, `- "<question>"`, then `  Answer: <answer>` or `  (No answer provided)`.
const CHAT_ABOUT_IT = /^The user wants to clarify these questions\.\n/;
const CHAT_ANSWER = /^([\s\S]*)"\n {2}Answer: ([\s\S]*)$/; // an entry after its `\n- "`: a question may span lines

// a headless orchestrator's tools whose result shows as a [yoicks] notice: a worker started (its result says
// whether the first task reached it), a task sent to one, a worktree removed
const PROMPT_TOOL = 'mcp__yoicks__agent_prompt';
const NOTICE_TOOLS = new Set(['mcp__yoicks__agent_start', PROMPT_TOOL, 'mcp__yoicks__worktree_remove']);
const TASK_SHOWN = 50; // characters of a sent task's first line

export type ToolUse = Extract<TimelineItem, { kind: 'tool_use' }>;

/** The [yoicks] notice of a NOTICE_TOOLS call's result: the bridge's answer on one line, but for a task
 *  sent (agent_prompt, whose summary is `<name>: <the task's first line>`) `sent to <name>: <that line,
 *  cut short>`, or `not sent to <name>: <why>`. */
function toolNotice(call: ToolUse, text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (call.name !== PROMPT_TOOL) return `[yoicks] ${line}`;
  const i = call.summary.indexOf(': ');
  const [name, first] = i < 0 ? [call.summary, ''] : [call.summary.slice(0, i), call.summary.slice(i + 2)];
  if (!/^delivered to /.test(line)) return `[yoicks] not sent to ${name}: ${line.replace(/^(?:not delivered to \S+|task not sent): /, '')}`;
  const task = [...first];
  return `[yoicks] sent to ${name}: ${task.length > TASK_SHOWN ? `${task.slice(0, TASK_SHOWN).join('').trimEnd()}…` : first}`;
}

/**
 * The home (orchestrator) chat shows only the dialogue: the user's and the
 * assistant's own words, and its questions (AskUserQuestion) with what the user
 * answered as their own bubble (Chat about this: a [yoicks] notice), and what a
 * headless one did to its workers (NOTICE_TOOLS: a start, a task, a worktree removed)
 * as [yoicks] notices. Other tool
 * calls/results, thinking, subagent traffic and injected user turns are hidden.
 * `calls` (kept across appends: a call and its result arrive apart) maps those
 * calls' tool_use ids to their call.
 */
export function conversationItems(items: TimelineItem[], calls = new Map<string, ToolUse>()): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const it of items) {
    if (it.sidechain) continue;
    const call = it.kind === 'tool_result' && it.forId !== null ? calls.get(it.forId) : undefined;
    if (it.kind === 'assistant' || (it.kind === 'user' && !INJECTED_USER_TURN.test(it.text))) out.push(it);
    else if (it.kind === 'tool_use' && it.name === 'AskUserQuestion' && it.ask?.length) {
      calls.set(it.id, it);
      out.push(it);
    } else if (it.kind === 'tool_use' && NOTICE_TOOLS.has(it.name)) calls.set(it.id, it);
    else if (it.kind === 'tool_result' && call && NOTICE_TOOLS.has(call.name)) {
      out.push({ kind: 'user', text: toolNotice(call, it.text), sidechain: false, ts: it.ts });
    } else if (it.kind === 'tool_result' && call && it.isError && CHAT_ABOUT_IT.test(it.text)) {
      // the answers given before it stay in the chat, `question: answer` a line (cut short: the entries before the cut)
      const given = it.text.split('\n- "').slice(1, it.truncated ? -1 : undefined).flatMap((e) => CHAT_ANSWER.exec(e)?.slice(1, 3).join(': ') ?? []).join('\n');
      if (given) out.push({ kind: 'user', text: given, sidechain: false, ts: it.ts });
      out.push({ kind: 'user', text: '[yoicks] Chat about this', sidechain: false, ts: it.ts });
    } else if (it.kind === 'tool_result' && call) {
      const answer = it.truncated ? null : askAnswer(it.text); // cut short, it may name only some: shown as it is
      out.push(answer === null ? it : { kind: 'user', text: answer, sidechain: false, ts: it.ts });
    }
  }
  return out;
}

/**
 * What the agent is doing right now, folded over newly arrived items: its latest
 * tool call since it last spoke, or null (thinking / writing). Pass the previous
 * result as `prev` so appends continue from it.
 */
export function latestActivity(items: TimelineItem[], prev: string | null): string | null {
  let cur = prev;
  for (const it of items) {
    if (it.sidechain) continue;
    if (it.kind === 'tool_use') cur = it.summary ? `${it.name} ${it.summary}` : it.name;
    else if (it.kind === 'assistant' || it.kind === 'user') cur = null;
  }
  return cur;
}

// A reply (a Home's Reply on a message, or Ask on a to-do item): the message sent starts with one quote line,
// a Markdown blockquote the orchestrator reads as it is, then a blank line and the user's words. The line
// names what it quotes (`of`), and the chat finds a message's original by it (ui/ChatLog.tsx's data-quote).
export type QuoteOf = 'you' | 'me' | 'notice' | 'todo';
const QUOTE_HEAD: Record<QuoteOf, string> = {
  you: 'Replying to your message', // the orchestrator's
  me: 'Replying to my message', // the user's
  notice: 'Replying to this notice', // the bridge's [yoicks] line
  todo: 'To-do',
};
const QUOTE_OF = new Map(Object.entries(QUOTE_HEAD).map(([of, head]) => [head, of as QuoteOf]));
const QUOTE_RE = /^> (Replying to your message|Replying to my message|Replying to this notice|To-do): (.+)(?:\n\n|\n?$)/;
const EXCERPT = 100; // characters of the quoted message, on one line
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// a message's text as the chat shows it: renderMarkdown's HTML (escaped text and its own tags only) without its
// tags, an inline one's (bold, code, a link…) gone, any other's a space, and its four entities back as characters
const plain = (s: string): string => renderMarkdown(s)
  .replace(/<\/?(?:strong|em|del|code|a)\b[^>]*>/g, '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The quote line of a message: its text on one line, as it reads (a notice's: as it is, the chat shows it so), cut short. */
export function quoteLine(of: Exclude<QuoteOf, 'todo'>, text: string): string {
  const cs = [...((of === 'notice' ? '' : oneLine(plain(text))) || oneLine(text))]; // nothing shown (an empty code block): its text
  return `> ${QUOTE_HEAD[of]}: ${cs.length > EXCERPT ? `${cs.slice(0, EXCERPT).join('').trimEnd()}…` : cs.join('')}`;
}

/** The quote line of a to-do item: its text, then its id (the orchestrator's `todo` knows it by it), worker and link. */
export function todoQuote(item: { id: string; text: string; agent: string | null; url: string | null }): string {
  const more = [`id ${item.id}`, ...(item.agent ? [`worker ${item.agent}`] : []), ...(item.url ? [item.url] : [])];
  return `> ${QUOTE_HEAD.todo}: ${oneLine(item.text)} (${more.join(', ')})`;
}

export interface Quote {
  of: QuoteOf;
  /** the line as sent (an original's data-quote is the same line) */
  line: string;
  /** what it shows of the original: its excerpt (a to-do item's text, without its id) */
  excerpt: string;
  /** the user's words after it */
  body: string;
}

/** The quote a message starts with, or null. */
export function parseQuote(text: string): Quote | null {
  const m = QUOTE_RE.exec(text);
  if (!m) return null;
  const of = QUOTE_OF.get(m[1])!;
  const excerpt = of === 'todo' ? m[2].replace(/ \(id [^)]*\)$/, '') : m[2];
  return { of, line: `> ${m[1]}: ${m[2]}`, excerpt, body: text.slice(m[0].length) };
}
