/**
 * ui/ChatLog.tsx — a chat log's items (Claude Code's transcript, TimelineItems) as React components on
 * Mantine's, drawn by pane-view.ts into its #chat-log. The engine keeps the element, the items' source,
 * and the scroll: this only draws, in a React root of its own on that element (under its own
 * MantineProvider, the app's theme), and synchronously (flushSync), so the engine measures and scrolls
 * the new DOM at once. A reset draws the log afresh (no <details> stays open across it); an append adds
 * to its end and leaves what is on show as it is (an open tool result stays open). The prose is
 * renderMarkdown's HTML, escaped (transcript.ts), in Mantine's Typography; everything else is React's
 * text. The class names the tests and webcheck read (chat-item, chat-user, chat-assistant,
 * chat-result…) stay on their elements. On a Home (createChatLog's `reply`) a message can be replied to
 * (Repliable): its quote goes into the composer, and a reply shows what it quotes on top (QuoteRef), and
 * each message shows when it was sent (its transcript line's time: chatTime).
 */
import { ActionIcon, Anchor, Box, Code, Group, Image, MantineProvider, Menu, Paper, Text, Typography, UnstyledButton } from '@mantine/core';
import { createContext, memo, useContext, useState, type ReactNode, type Ref, type SyntheticEvent } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { openAgentNamed } from '../nav.ts';
import { showToast } from '../notify.ts';
import { theme } from '../theme.ts';
import { dueLabel } from '../todos.ts';
import { inlineMarkdown, parseQuote, quoteLine, renderMarkdown, splitNotices, WORKER_NOTICE, type AskQuestion, type Quote, type QuoteOf, type TimelineItem, type TodoEntry } from '../transcript.ts';
import { previewImage } from './Modals.tsx';

export interface ChatLog {
  /** draws `items` in place of the log (none: "No messages yet.") */
  reset(items: TimelineItem[]): void;
  /** adds `items` at the end */
  append(items: TimelineItem[]): void;
  destroy(): void;
}

/** `home`: an orchestrator's Home, where its replies are bubbles too (the left ones); `reply`: its messages'
 *  Reply, which gets the message's quote line (transcript.ts's quoteLine). */
export function createChatLog(el: HTMLElement, { home = false, reply }: { home?: boolean; reply?: (quote: string) => void } = {}): ChatLog {
  const root = createRoot(el);
  let items: TimelineItem[] = [];
  let drawn = 0; // each reset: a fresh tree
  let midnight: ReturnType<typeof setTimeout> | undefined;
  // the app's provider already wrote Mantine's variables and global classes: this one only gives the theme
  const draw = (): void => {
    flushSync(() => root.render(
      <MantineProvider theme={theme} forceColorScheme="dark" withCssVariables={false} withGlobalClasses={false}>
        <ReplyTo value={reply ?? null}><Items key={drawn} items={items} home={home} /></ReplyTo>
      </MantineProvider>,
    ));
    // a Home's times name the day once it isn't today: drawn again at midnight (a phone asleep then: as it wakes)
    if (!home) return;
    clearTimeout(midnight);
    midnight = setTimeout(draw, new Date().setHours(24, 0, 0, 0) - Date.now());
  };
  return {
    reset(next) { items = next; drawn++; draw(); },
    append(more) { items = [...items, ...more]; draw(); },
    // not during a React render (the pane's unmount calls this): after it
    destroy() { clearTimeout(midnight); queueMicrotask(() => root.unmount()); },
  };
}

function Items({ items, home }: { items: TimelineItem[]; home: boolean }) {
  if (!items.length) return <Text className="chat-empty" m="auto" fz={13} c="dimmed">No messages yet.</Text>;
  const today = new Date().setHours(0, 0, 0, 0); // a new day draws the times again (a memo'd item keeps its own)
  return <>{items.map((it, i) => <ChatItem key={i} item={it} home={home} today={today} />)}</>; // appended only: a position is an item
}

/** When a message was sent, in local time (the day too when not `today`'s): "18:00", "yesterday 09:05", "11/30 09:00". */
const chatTime = (ts: number, today: number): string => dueLabel(ts, today).text.replace(/^today /, '');

// a Home message's time (its data-time): dim and small, as CSS content, so the message's text (a test's, Copy's, a
// mouse selection's) stays its words alone. TIME_UNDER: on a line of its own under the bubble.
const TIME = 'after:text-[10px] after:leading-none after:text-(--color-text-dim) after:content-[attr(data-time)]';
const TIME_UNDER = `${TIME} after:mt-1 after:block`;

// the prose: renderMarkdown's escaped HTML in Mantine's Typography (style.css's .chat-md tunes it for chat)
const Markdown = ({ className = '', text }: { className?: string; text: string }) => (
  <Typography className={`chat-md wrap-anywhere ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
);

// a subagent's turn: dimmed, a dashed rule on its left, its tag on top
const SIDECHAIN = 'chat-sidechain border-l-2 border-(--color-border) pl-2 opacity-85 [--tw-border-style:dashed]'; // the left edge only: no preflight, so border-dashed would dash every side
const SubTag = () => <Text span className="chat-sub-tag" display="inline-block" fz={10} c="dimmed" tt="uppercase" lts="0.04em" mb={3}>subagent</Text>;

// a tool call's card: the surface, its left edge in the tool's color (a question's: blocked)
const Card = ({ className, edge, children }: { className: string; edge: string; children: ReactNode }) => (
  <Paper className={`chat-item ${className} border-l-3 ${edge}`} withBorder radius={8} px={10} py={7} bg="dark.7">{children}</Paper>
);
const ToolName = ({ children }: { children: string }) => <Text span className="chat-tool-name" ff="monospace" fz={12} fw={650} c="working">{children}</Text>;

/** One item: a user turn (its notices, its bubble, its images), the assistant's words (on a Home, a
 *  bubble too), a thinking block, a tool call (a question, a to-do list) or its result. */
export const ChatItem = memo(function ChatItem({ item, home = false, today }: { item: TimelineItem; home?: boolean; today: number }) {
  const sub = item.sidechain ? SIDECHAIN : ''; // after a space: Tailwind never finds a class written right before ${…}
  const tag = item.sidechain ? <SubTag /> : null;
  const time = home && item.ts !== null ? chatTime(item.ts, today) : undefined;
  switch (item.kind) {
    case 'user': {
      // the images sent with it: under its words, or alone (the bridge sends only data: URLs)
      const images = item.images?.length ? (
        <Group className={`chat-item chat-user chat-images max-w-[88%] self-end ${sub} ${time ? `${TIME} after:basis-full after:text-right` : ''}`}
          gap={6} justify="flex-end" data-time={time}>
          {item.images.map((src, i) => (
            <UnstyledButton key={i} className="chat-image-open max-w-full" aria-label="View image" onClick={() => previewImage(src, 'image')}>
              <Image className="chat-image" src={src} alt="image" mah={160} maw="100%" w="auto" fit="contain" radius={10} />
            </UnstyledButton>
          ))}
        </Group>
      ) : null;
      if (images && !item.text.trim()) return images;
      const { text } = item;
      const own = images ? undefined : time; // the user's turn: its time under its images, else under its words
      const bubble = (t: string): ReactNode => {
        const q = parseQuote(t); // a reply: what it quotes on top, then its words
        const words = q ? q.body : t;
        return (
          <Repliable className={`chat-item chat-user max-w-[88%] self-end ${sub} ${own ? `${TIME_UNDER} after:text-right` : ''}`} of="me" text={words} time={own}>
            {tag}
            <Paper className="chat-bubble rounded-[14px_14px_4px_14px]" bg="accent" c="white" px={12} py={8}>
              {q && <QuoteRef q={q} />}
              {words ? <Markdown text={words} /> : null}
            </Paper>
          </Repliable>
        );
      };
      const { before, body, after } = splitNotices(text);
      if (!before.length && !after.length) return <>{bubble(text)}{images}</>;
      // the bridge's notices: dim lines, not the user's
      const notices = (ls: string[]): ReactNode => ls.map((l, i) => (
        <Repliable key={i} className={`chat-item chat-notice self-center ${sub}`} of="notice" text={l}>
          <Text component="div" className={`whitespace-pre-wrap wrap-anywhere ${time ? `${TIME} after:ml-1.5` : ''}`} fz={12} c="dimmed" ta="center"
            data-time={time}><Notice line={l} /></Text>
        </Repliable>
      ));
      return <>{notices(before)}{body ? bubble(body) : null}{notices(after)}{images}</>;
    }
    case 'assistant':
      // a Home's replies are left bubbles, opposite the user's
      return home ? (
        <Repliable className={`chat-item chat-assistant max-w-[92%] self-start ${sub} ${time ? TIME_UNDER : ''}`} of="you" text={item.text} time={time}>
          {tag}
          <Paper className="rounded-[14px_14px_14px_4px]" withBorder bg="dark.7" px={12} py={8}><Markdown text={item.text} /></Paper>
        </Repliable>
      ) : <div className={`chat-item chat-assistant self-stretch ${sub}`}>{tag}<Markdown text={item.text} /></div>;
    case 'thinking':
      return (
        <div className={`chat-item chat-thinking-wrap ${sub}`}>
          <Disclosure className="chat-thinking text-[13px] text-(--color-text-dim)" summary={<i>Thinking</i>}>
            <Box className="chat-thinking-body mt-1 whitespace-pre-wrap wrap-anywhere"
              dangerouslySetInnerHTML={{ __html: inlineMarkdown(item.text) + (item.truncated ? '<span class="chat-more">…</span>' : '') }} />
          </Disclosure>
        </div>
      );
    case 'tool_use':
      // AskUserQuestion is a question card (read-only here; the answer panel, ui/PromptPanel.tsx, answers it)
      if (item.name === 'AskUserQuestion' && item.ask?.length) {
        return (
          <Card className={`chat-tool chat-ask ${sub}`} edge="border-l-(--color-blocked)">
            <Group className={time ? `${TIME} after:ml-auto` : undefined} gap={8} align="baseline" data-time={time}><ToolName>Question</ToolName></Group>
            <AskQuestions ask={item.ask} />
          </Card>
        );
      }
      return (
        <Card className={`chat-tool ${sub}`} edge="border-l-(--color-working)">
          <Group className="chat-tool-head" gap={8} align="baseline">
            <ToolName>{item.name}</ToolName>
            {item.summary ? <Text span className="chat-tool-summary break-all" ff="monospace" fz={12} c="dimmed">{item.summary}</Text> : null}
          </Group>
          {item.name === 'TodoWrite' && item.todos ? <Todos todos={item.todos} /> : null}
        </Card>
      );
    case 'tool_result':
      return (
        <div className={`chat-item chat-result-wrap ${sub}`}>
          <Disclosure className={`chat-result text-[12px] ${item.isError ? 'chat-result-error' : ''}`}
            summary={<Text span ff="monospace" inherit c={item.isError ? 'blocked' : 'dimmed'}>{item.isError ? 'Error' : 'Result'}</Text>}>
            <Code block className={`chat-result-body mt-[5px] max-h-[40vh] overflow-auto rounded-md border bg-[#0d0f13] px-2.5 py-2 text-[12px] leading-[1.4] whitespace-pre-wrap wrap-anywhere text-[#bcbcbc] ${item.isError ? 'border-(--color-blocked)' : 'border-(--color-border)'}`}>
              {item.text + (item.truncated ? '\n… (truncated)' : '')}
            </Code>
          </Disclosure>
        </div>
      );
  }
});

// a Home's Reply (createChatLog's `reply`); none elsewhere: a pane's chat is read-only
const ReplyTo = createContext<((quote: string) => void) | null>(null);

const REPLY_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </svg>
);

/** A message a Home can reply to (`of`: whose, `text`: its words): Reply puts its quote line into the
 *  composer, Copy copies its words. Both from a long press on a phone or a right click on a PC (Mantine's
 *  Menu.ContextMenu), Reply also from the ↩ in its box's top-right corner (its first child's: the bubble, a
 *  notice's line), shown on a PC's hover or keyboard focus (inside the box, so the mouse reaches it without
 *  leaving the message; the box keeps room for it, `!` to beat the inline padding of Mantine's `px`), on a
 *  phone there for a screen reader only. On a link or a button, or with its text selected, the browser's own
 *  menu instead. A mouse still selects its text; a long press selects none (Copy is for that). Its
 *  data-quote is that quote line: a reply's QuoteRef finds it by it. */
function Repliable({ className, of, text, time, children }: { className: string; of: Exclude<QuoteOf, 'todo'>; text: string; time?: string; children: ReactNode }) {
  const reply = useContext(ReplyTo);
  const [native, setNative] = useState(false);
  if (!reply || !text.trim()) return <div className={className} data-time={time}>{children}</div>;
  const quote = quoteLine(of, text);
  // before the menu's own handlers see the press
  const press = (e: SyntheticEvent<HTMLDivElement>): void => {
    const sel = getSelection();
    setNative(!!(e.target as Element).closest('a, button') || (!!sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)));
  };
  const copy = (): void => {
    (navigator.clipboard?.writeText(text) ?? Promise.reject(new Error())).then(
      () => showToast('Copied', ''), () => showToast('Not copied', 'This browser did not allow it.'));
  };
  return (
    <Menu position="bottom-start" returnFocus={false}>
      <Menu.ContextMenu disabled={native}>
        <div className={`group/msg relative rounded-[14px] pointer-fine:select-text! pointer-fine:[&>:first-child]:pr-9! data-flash:outline-2 data-flash:outline-offset-2 data-flash:outline-(--color-accent) ${className}`}
          data-quote={quote} data-time={time} onTouchStart={press} onMouseDown={press}>
          {children}
          {/* a notice has no bubble: beside its line, centered */}
          <ActionIcon className={`chat-reply absolute right-1 ${of === 'notice' ? 'top-1/2 -translate-y-1/2' : 'top-1'} opacity-0 group-hover/msg:opacity-100 focus-visible:opacity-100 focus-visible:outline-current pointer-coarse:sr-only`}
            variant="subtle" color="gray" size={28} aria-label="Reply" onClick={() => reply(quote)}>{REPLY_ICON}</ActionIcon>
        </div>
      </Menu.ContextMenu>
      <Menu.Dropdown>
        <Menu.Item className="min-h-11" fz="md" data-action="reply" onClick={() => reply(quote)}>Reply</Menu.Item>
        <Menu.Item className="min-h-11" fz="md" data-action="copy" onClick={copy}>Copy</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

// whose message a quote is (a to-do item's: none, it isn't in the chat)
const QUOTE_LABEL: Record<QuoteOf, string> = { you: 'Orchestrator', me: 'You', notice: 'yoicks', todo: 'To-do' };

/** What a quote shows of what it quotes: `head` (whose, by default), then its excerpt (two lines at most). */
export const QuoteText = ({ q, head = QUOTE_LABEL[q.of] }: { q: Quote; head?: string }) => (
  <>
    <Text span display="block" fz={11} fw={700} opacity={0.8}>{head}</Text>
    <Text span fz={12} lh={1.35} lineClamp={2} className="wrap-anywhere">{q.excerpt}</Text>
  </>
);

/** On top of a reply's bubble: what it quotes. A tap scrolls the chat to that message (the nearest before it
 *  with that quote line) and marks it a moment; a to-do item's isn't in the chat, so it is no button. */
function QuoteRef({ q }: { q: Quote }) {
  const cls = 'chat-quote-ref mb-1.5 block w-full rounded-md border-l-3 border-white/60 bg-black/20 px-2 py-1 text-left';
  if (q.of === 'todo') return <div className={cls} data-quote-of="todo"><QuoteText q={q} /></div>;
  return (
    <UnstyledButton className={cls} data-quote-of={q.of} aria-label={`Show the message replied to (${QUOTE_LABEL[q.of]}): ${q.excerpt}`}
      onClick={(e) => showOriginal(e.currentTarget, q.line)}><QuoteText q={q} /></UnstyledButton>
  );
}

// ponytail: found by its quote line, the nearest before the reply: of two messages alike in their first 100 characters
// (a worker's repeated status notice), the later one. The orchestrator reads only that line too; a reference of the
// item's own (its transcript line's uuid in the quote) would tell them apart.
function showOriginal(from: HTMLElement, line: string): void {
  const el = [...(from.closest('.chat-log')?.querySelectorAll<HTMLElement>('[data-quote]') ?? [])]
    .filter((m) => m.dataset.quote === line && !m.contains(from) && !!(m.compareDocumentPosition(from) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1);
  if (!el) {
    showToast('Not in this chat', "The message replied to isn't in the part of the chat shown here.");
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.dataset.flash = '';
  setTimeout(() => { delete el.dataset.flash; }, 1600);
}

/** A native <details> whose summary has a ▸ (▾ while open) before it, and no marker of the browser's:
 *  the chat's thinking and tool results, the answer panel's terminal. Its state is the element's own (an
 *  open one stays open while the log grows). */
export function Disclosure({ className, summary, children, ref }: { className: string; summary: ReactNode; children: ReactNode; ref?: Ref<HTMLDetailsElement> }) {
  return (
    <details ref={ref} className={`group ${className}`}>
      <summary className="list-none text-(--color-text-dim) hover:text-(--color-text) before:content-['▸_'] group-open:before:content-['▾_'] [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      {children}
    </details>
  );
}

/** A notice line: a worker's name in it is a link-like button that opens that worker (nav.ts's openAgentNamed). */
export function Notice({ line }: { line: string }) {
  const m = WORKER_NOTICE.exec(line);
  if (!m) return <>{line}</>;
  return (
    <>{m[1]}<Anchor component="button" type="button" className="chat-notice-agent py-1 underline-offset-2 hover:text-(--color-text)" underline="always" inherit
      data-agent={m[2]} onClick={() => openAgentNamed(m[2])}>{m[2]}</Anchor>{m[3]}</>
  );
}

// a to-do's mark and its look: done struck through and dim with a green ✓, the one in progress ▸ in blue
const TODO: Record<string, { mark: string; text: string; color: string }> = {
  completed: { mark: '✓', text: 'text-(--color-text-dim) line-through', color: 'text-(--color-done)' },
  in_progress: { mark: '▸', text: 'text-(--color-text)', color: 'text-(--color-working)' },
};

function Todos({ todos }: { todos: TodoEntry[] }) {
  return (
    <ul className="chat-todos mt-1.5 text-[13px]">
      {todos.map((t, i) => {
        const look = TODO[t.status] ?? { mark: '○', text: '', color: '' };
        return (
          <li key={i} className={`todo-${t.status} flex gap-[7px] py-0.5 ${look.text}`}>
            <span className={`todo-mark w-[1em] shrink-0 ${look.color || 'text-(--color-text-dim)'}`}>{look.mark}</span>{t.content}
          </li>
        );
      })}
    </ul>
  );
}

function AskQuestions({ ask }: { ask: AskQuestion[] }) {
  return (
    <>
      {ask.map((q, qi) => (
        <div key={qi} className="ask-q mt-1.5">
          {q.header ? <Text span display="inline-block" fz={10} c="dimmed" tt="uppercase" lts="0.04em">{q.header}</Text> : null}
          <Text className="ask-q-text wrap-anywhere" fz={14} mt={2} mb={6}>{q.question}</Text>
          <ul className="ask-opts-static">
            {q.options.map((op, oi) => (
              <li key={oi} className="ask-opt-static flex items-baseline gap-2 py-[3px] text-[13px]">
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
