/**
 * ui/ChatLog.tsx — a chat log's items (Claude Code's transcript, TimelineItems) as React components,
 * drawn by pane-view.ts into its #chat-log. The engine keeps the element, the items' source, and the
 * scroll: this only draws, in a React root of its own on that element, and synchronously (flushSync),
 * so the engine measures and scrolls the new DOM at once, as it did after innerHTML. A reset draws the
 * log afresh (as innerHTML did: no <details> stays open across it); an append adds to its end and
 * leaves what is on show as it is (an open tool result stays open). The prose is renderMarkdown's
 * HTML, escaped (transcript.ts); everything else is React's text.
 */
import { memo, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { openAgentNamed } from '../nav.ts';
import { inlineMarkdown, renderMarkdown, splitNotices, WORKER_NOTICE, type AskQuestion, type TimelineItem, type TodoEntry } from '../transcript.ts';
import { previewImage } from './Modals.tsx';

export interface ChatLog {
  /** draws `items` in place of the log (none: "No messages yet.") */
  reset(items: TimelineItem[]): void;
  /** adds `items` at the end */
  append(items: TimelineItem[]): void;
  destroy(): void;
}

export function createChatLog(el: HTMLElement): ChatLog {
  const root = createRoot(el);
  let items: TimelineItem[] = [];
  let drawn = 0; // each reset: a fresh tree
  const draw = (): void => flushSync(() => root.render(<Items key={drawn} items={items} />));
  return {
    reset(next) { items = next; drawn++; draw(); },
    append(more) { items = [...items, ...more]; draw(); },
    // not during a React render (the pane's unmount calls this): after it
    destroy() { queueMicrotask(() => root.unmount()); },
  };
}

function Items({ items }: { items: TimelineItem[] }) {
  if (!items.length) return <div className="chat-empty">No messages yet.</div>;
  return <>{items.map((it, i) => <ChatItem key={i} item={it} />)}</>; // appended only: a position is an item
}

const Markdown = ({ className, text }: { className: string; text: string }) => (
  <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
);

/** One item: a user turn (its notices, its bubble, its images), the assistant's words, a thinking block,
 *  a tool call (a question, a to-do list) or its result. */
export const ChatItem = memo(function ChatItem({ item }: { item: TimelineItem }) {
  const sub = item.sidechain ? ' chat-sidechain' : '';
  const tag = item.sidechain ? <span className="chat-sub-tag">subagent</span> : null;
  switch (item.kind) {
    case 'user': {
      // the images sent with it: under its words, or alone (the bridge sends only data: URLs)
      const images = item.images?.length ? (
        <div className={`chat-item chat-user chat-images${sub}`}>
          {item.images.map((src, i) => (
            <button key={i} type="button" className="chat-image-open" aria-label="View image" onClick={() => previewImage(src, 'image')}>
              <img className="chat-image" src={src} alt="image" />
            </button>
          ))}
        </div>
      ) : null;
      if (images && !item.text.trim()) return images;
      const { text } = item;
      const bubble = (t: string): ReactNode => <div className={`chat-item chat-user${sub}`}>{tag}<Markdown className="chat-bubble chat-md" text={t} /></div>;
      const { before, body, after } = splitNotices(text);
      if (!before.length && !after.length) return <>{bubble(text)}{images}</>;
      // the bridge's notices: dim lines, not the user's
      const notices = (ls: string[]): ReactNode => ls.map((l, i) => <div key={i} className={`chat-item chat-notice${sub}`}><Notice line={l} /></div>);
      return <>{notices(before)}{body ? bubble(body) : null}{notices(after)}{images}</>;
    }
    case 'assistant':
      return <div className={`chat-item chat-assistant${sub}`}>{tag}<Markdown className="chat-md" text={item.text} /></div>;
    case 'thinking':
      return (
        <div className={`chat-item chat-thinking-wrap${sub}`}>
          <details className="chat-thinking">
            <summary>Thinking</summary>
            <div className="chat-thinking-body"
              dangerouslySetInnerHTML={{ __html: inlineMarkdown(item.text) + (item.truncated ? '<span class="chat-more">…</span>' : '') }} />
          </details>
        </div>
      );
    case 'tool_use':
      // AskUserQuestion is a question card (read-only here; the answer panel, ui/PromptPanel.tsx, answers it)
      if (item.name === 'AskUserQuestion' && item.ask?.length) {
        return (
          <div className={`chat-item chat-tool chat-ask${sub}`}>
            <div className="chat-tool-head"><span className="chat-tool-name">Question</span></div>
            <AskQuestions ask={item.ask} />
          </div>
        );
      }
      return (
        <div className={`chat-item chat-tool${sub}`}>
          <div className="chat-tool-head">
            <span className="chat-tool-name">{item.name}</span>
            {item.summary ? <span className="chat-tool-summary">{item.summary}</span> : null}
          </div>
          {item.name === 'TodoWrite' && item.todos ? <Todos todos={item.todos} /> : null}
        </div>
      );
    case 'tool_result':
      return (
        <div className={`chat-item chat-result-wrap${sub}`}>
          <details className={`chat-result${item.isError ? ' chat-result-error' : ''}`}>
            <summary>{item.isError ? 'Error' : 'Result'}</summary>
            <pre className="chat-result-body">{item.text + (item.truncated ? '\n… (truncated)' : '')}</pre>
          </details>
        </div>
      );
  }
});

/** A notice line: a worker's name in it is a button that opens that worker (nav.ts's openAgentNamed). */
export function Notice({ line }: { line: string }) {
  const m = WORKER_NOTICE.exec(line);
  if (!m) return <>{line}</>;
  return (
    <>{m[1]}<button type="button" className="chat-notice-agent" data-agent={m[2]} onClick={() => openAgentNamed(m[2])}>{m[2]}</button>{m[3]}</>
  );
}

const TODO_MARK: Record<string, string> = { completed: '✓', in_progress: '▸', pending: '○' };

function Todos({ todos }: { todos: TodoEntry[] }) {
  return (
    <ul className="chat-todos">
      {todos.map((t, i) => <li key={i} className={`todo-${t.status}`}><span className="todo-mark">{TODO_MARK[t.status] ?? '○'}</span>{t.content}</li>)}
    </ul>
  );
}

function AskQuestions({ ask }: { ask: AskQuestion[] }) {
  return (
    <>
      {ask.map((q, qi) => (
        <div key={qi} className="ask-q">
          {q.header ? <span className="ask-q-header">{q.header}</span> : null}
          <div className="ask-q-text">{q.question}</div>
          <ul className="ask-opts-static">
            {q.options.map((op, oi) => (
              <li key={oi} className="ask-opt-static">
                <span className="ask-opt-num">{oi + 1}</span>
                <span className="ask-opt-label">{op.label}</span>
                {op.description ? <span className="ask-opt-desc">{op.description}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}
