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

// Inline markdown on already-safe text: `code`, **bold**, and line breaks.
function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// Modest markdown: fenced code blocks kept verbatim in <pre>, everything else
// gets inline formatting. Enough to make assistant prose readable without a full
// markdown engine.
export function renderMarkdownLite(src: string): string {
  const parts = src.split('```');
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const seg = parts[i];
      const nl = seg.indexOf('\n');
      const body = nl >= 0 ? seg.slice(nl + 1) : seg; // drop the ```lang line
      html += `<pre class="chat-code"><code>${escapeHtml(body.replace(/\n$/, ''))}</code></pre>`;
    } else {
      html += inlineMd(parts[i]);
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
      return `<div class="chat-item chat-user${sub}">${subTag}<div class="chat-bubble">${renderMarkdownLite(item.text)}</div></div>`;
    case 'assistant':
      return `<div class="chat-item chat-assistant${sub}">${subTag}<div class="chat-md">${renderMarkdownLite(item.text)}</div></div>`;
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
