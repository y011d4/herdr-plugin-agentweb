/**
 * Pure transcript normalizer. No I/O, no side effects.
 *
 * Turns one line of a Claude Code JSONL session transcript
 * (`~/.claude/projects/<slug>/<sessionId>.jsonl`) into zero or more
 * display-ready TimelineItems for the PWA's chat view. Kept I/O-free and
 * unit-tested, mirroring server/state.ts.
 *
 * The JSONL format is Claude Code's own, private and undocumented: tolerate
 * unknown line/block types by skipping them (forward compatibility) rather than
 * throwing. Only the fields we render are read.
 */

// Cap oversized fields so a single line can't bloat a WS frame. Conversational
// text (user/assistant) is the content itself and kept whole; thinking and tool
// results are previews and truncated.
const THINKING_MAX = 8_000;
const RESULT_MAX = 4_000;
const SUMMARY_MAX = 200;

export type TimelineItem =
  | { kind: 'user'; text: string; sidechain: boolean; ts: number | null }
  | { kind: 'assistant'; text: string; sidechain: boolean; ts: number | null }
  | { kind: 'thinking'; text: string; truncated: boolean; sidechain: boolean; ts: number | null }
  | { kind: 'tool_use'; id: string; name: string; summary: string; todos: TodoEntry[] | null; sidechain: boolean; ts: number | null }
  | { kind: 'tool_result'; forId: string | null; text: string; truncated: boolean; isError: boolean; sidechain: boolean; ts: number | null };

export interface TodoEntry {
  content: string;
  status: string;
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

function toMs(timestamp: unknown): number | null {
  if (typeof timestamp !== 'string') return null;
  const t = Date.parse(timestamp);
  return Number.isNaN(t) ? null : t;
}

/** A short one-line summary of a tool call, tuned per well-known tool. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  let s: string;
  switch (name) {
    case 'Bash':
      s = str(o.command).split('\n')[0];
      break;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      s = str(o.file_path);
      break;
    case 'Glob':
      s = str(o.pattern) + (o.path ? ` in ${str(o.path)}` : '');
      break;
    case 'Grep':
      s = str(o.pattern) + (o.path ? ` in ${str(o.path)}` : '');
      break;
    case 'Task':
      s = `${str(o.subagent_type)}: ${str(o.description)}`.replace(/^: /, '');
      break;
    case 'TodoWrite':
      s = Array.isArray(o.todos) ? `${o.todos.length} items` : '';
      break;
    case 'WebFetch':
    case 'WebSearch':
      s = str(o.url) || str(o.query);
      break;
    default: {
      // generic: first string-valued field, else compact key list
      const firstStr = Object.values(o).find((v) => typeof v === 'string' && v.length > 0);
      s = typeof firstStr === 'string' ? firstStr.split('\n')[0] : Object.keys(o).join(', ');
    }
  }
  return s.length > SUMMARY_MAX ? s.slice(0, SUMMARY_MAX) + '…' : s;
}

function extractTodos(input: unknown): TodoEntry[] | null {
  if (!input || typeof input !== 'object') return null;
  const todos = (input as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return null;
  return todos.map((t) => {
    const o = (t ?? {}) as Record<string, unknown>;
    return { content: typeof o.content === 'string' ? o.content : '', status: typeof o.status === 'string' ? o.status : '' };
  });
}

/** Flatten a tool_result content field (string, or array of text/blocks) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const o = (b ?? {}) as Record<string, unknown>;
        if (typeof o.text === 'string') return o.text;
        if (o.type === 'image') return '[image]';
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Normalize one raw JSONL line into zero or more TimelineItems.
 * Returns [] for lines we don't render (meta, system, snapshots, unparseable).
 */
export function normalizeLine(rawLine: string): TimelineItem[] {
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawLine);
    // A valid-but-non-object line (null, array, number, string) has no fields to
    // read — skip it rather than throwing on a property access below.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    o = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  // Injected context / bookkeeping lines are not conversation.
  if (o.isMeta === true) return [];
  if (o.type === 'system' || o.type === 'summary' || o.type === 'file-history-snapshot') return [];

  const sidechain = o.isSidechain === true;
  const ts = toMs(o.timestamp);
  const message = o.message as Record<string, unknown> | undefined;
  if (!message) return [];
  const out: TimelineItem[] = [];

  if (o.type === 'user') {
    const content = message.content;
    if (typeof content === 'string') {
      const text = content.trim();
      if (text) out.push({ kind: 'user', text, sidechain, ts });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const b = (block ?? {}) as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ kind: 'user', text: b.text, sidechain, ts });
        } else if (b.type === 'tool_result') {
          const raw = toolResultText(b.content);
          const { text, truncated } = truncate(raw, RESULT_MAX);
          out.push({
            kind: 'tool_result',
            forId: typeof b.tool_use_id === 'string' ? b.tool_use_id : null,
            text,
            truncated,
            isError: b.is_error === true,
            sidechain,
            ts,
          });
        }
      }
    }
  } else if (o.type === 'assistant') {
    const content = message.content;
    if (!Array.isArray(content)) return [];
    for (const block of content) {
      const b = (block ?? {}) as Record<string, unknown>;
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        const { text, truncated } = truncate(b.thinking, THINKING_MAX);
        out.push({ kind: 'thinking', text, truncated, sidechain, ts });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push({ kind: 'assistant', text: b.text, sidechain, ts });
      } else if (b.type === 'tool_use') {
        const name = typeof b.name === 'string' ? b.name : 'tool';
        out.push({
          kind: 'tool_use',
          id: typeof b.id === 'string' ? b.id : '',
          name,
          summary: summarizeToolInput(name, b.input),
          todos: name === 'TodoWrite' ? extractTodos(b.input) : null,
          sidechain,
          ts,
        });
      }
    }
  }
  return out;
}
