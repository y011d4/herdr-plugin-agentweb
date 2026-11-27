/**
 * ui/ChatLog.tsx — a chat log's items (Claude Code's transcript, TimelineItems) as React components on
 * Mantine's, drawn by pane-view.ts into its #chat-log. The engine keeps the element, the items' source,
 * and the scroll: this only draws, in a React root of its own on that element (under its own
 * MantineProvider, the app's theme), and synchronously (flushSync), so the engine measures and scrolls
 * the new DOM at once. A reset draws the log afresh (no <details> stays open across it); an append adds
 * to its end and leaves what is on show as it is (an open tool result stays open). The prose is
 * renderMarkdown's HTML, escaped (transcript.ts), in Mantine's Typography; everything else is React's
 * text. The class names the tests and webcheck read (chat-item, chat-user, chat-assistant,
 * chat-result…) stay on their elements.
 */
import { Anchor, Box, Code, Group, Image, MantineProvider, Paper, Text, Typography, UnstyledButton } from '@mantine/core';
import { memo, type ReactNode, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { openAgentNamed } from '../nav.ts';
import { theme } from '../theme.ts';
import { inlineMarkdown, renderMarkdown, splitNotices, WORKER_NOTICE, type AskQuestion, type TimelineItem, type TodoEntry } from '../transcript.ts';
import { previewImage } from './Modals.tsx';

export interface ChatLog {
  /** draws `items` in place of the log (none: "No messages yet.") */
  reset(items: TimelineItem[]): void;
  /** adds `items` at the end */
  append(items: TimelineItem[]): void;
  destroy(): void;
}

/** `home`: an orchestrator's Home, where its replies are bubbles too (the left ones). */
export function createChatLog(el: HTMLElement, { home = false } = {}): ChatLog {
  const root = createRoot(el);
  let items: TimelineItem[] = [];
  let drawn = 0; // each reset: a fresh tree
  // the app's provider already wrote Mantine's variables and global classes: this one only gives the theme
  const draw = (): void => flushSync(() => root.render(
    <MantineProvider theme={theme} forceColorScheme="dark" withCssVariables={false} withGlobalClasses={false}>
      <Items key={drawn} items={items} home={home} />
    </MantineProvider>,
  ));
  return {
    reset(next) { items = next; drawn++; draw(); },
    append(more) { items = [...items, ...more]; draw(); },
    // not during a React render (the pane's unmount calls this): after it
    destroy() { queueMicrotask(() => root.unmount()); },
  };
}

function Items({ items, home }: { items: TimelineItem[]; home: boolean }) {
  if (!items.length) return <Text className="chat-empty" m="auto" fz={13} c="dimmed">No messages yet.</Text>;
  return <>{items.map((it, i) => <ChatItem key={i} item={it} home={home} />)}</>; // appended only: a position is an item
}

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
export const ChatItem = memo(function ChatItem({ item, home = false }: { item: TimelineItem; home?: boolean }) {
  const sub = item.sidechain ? SIDECHAIN : ''; // after a space: Tailwind never finds a class written right before ${…}
  const tag = item.sidechain ? <SubTag /> : null;
  switch (item.kind) {
    case 'user': {
      // the images sent with it: under its words, or alone (the bridge sends only data: URLs)
      const images = item.images?.length ? (
        <Group className={`chat-item chat-user chat-images max-w-[88%] self-end ${sub}`} gap={6} justify="flex-end">
          {item.images.map((src, i) => (
            <UnstyledButton key={i} className="chat-image-open max-w-full" aria-label="View image" onClick={() => previewImage(src, 'image')}>
              <Image className="chat-image" src={src} alt="image" mah={160} maw="100%" w="auto" fit="contain" radius={10} />
            </UnstyledButton>
          ))}
        </Group>
      ) : null;
      if (images && !item.text.trim()) return images;
      const { text } = item;
      const bubble = (t: string): ReactNode => (
        <div className={`chat-item chat-user max-w-[88%] self-end ${sub}`}>
          {tag}
          <Paper className="chat-bubble rounded-[14px_14px_4px_14px]" bg="accent" c="white" px={12} py={8}><Markdown text={t} /></Paper>
        </div>
      );
      const { before, body, after } = splitNotices(text);
      if (!before.length && !after.length) return <>{bubble(text)}{images}</>;
      // the bridge's notices: dim lines, not the user's
      const notices = (ls: string[]): ReactNode => ls.map((l, i) => (
        <Text key={i} component="div" className={`chat-item chat-notice self-center whitespace-pre-wrap wrap-anywhere ${sub}`} fz={12} c="dimmed" ta="center">
          <Notice line={l} />
        </Text>
      ));
      return <>{notices(before)}{body ? bubble(body) : null}{notices(after)}{images}</>;
    }
    case 'assistant':
      // a Home's replies are left bubbles, opposite the user's
      return home ? (
        <div className={`chat-item chat-assistant max-w-[92%] self-start ${sub}`}>
          {tag}
          <Paper className="rounded-[14px_14px_14px_4px]" withBorder bg="dark.7" px={12} py={8}><Markdown text={item.text} /></Paper>
        </div>
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
            <Group gap={8} align="baseline"><ToolName>Question</ToolName></Group>
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

/** A native <details> whose summary has a ▸ (▾ while open) before it, and no marker of the browser's:
 *  the chat's thinking and tool results, the answer panel's terminal. Its state is the element's own (an
 *  open one stays open while the log grows). */
export function Disclosure({ className, summary, children, ref }: { className: string; summary: ReactNode; children: ReactNode; ref?: Ref<HTMLDetailsElement> }) {
  return (
    <details ref={ref} className={`group ${className}`}>
      <summary className="cursor-pointer list-none text-(--color-text-dim) before:content-['▸_'] group-open:before:content-['▾_'] [&::-webkit-details-marker]:hidden">
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
    <>{m[1]}<Anchor component="button" type="button" className="chat-notice-agent py-1 underline-offset-2" underline="always" inherit
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
