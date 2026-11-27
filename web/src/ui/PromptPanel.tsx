/**
 * ui/PromptPanel.tsx — the answer panel of a blocked pane in chat, shown by ui/Pane.tsx while
 * pane-view.ts reports a prompt (it polls the screen and decides when the panel shows): the
 * question and a button per option of the menu read off the screen, with the raw screen as
 * collapsible context below. A Home's composer stays available; a pane's chat has none (read-only).
 *
 * A tap presses the option's digit, one atomic keystroke that selects and submits it (CLAUDE.md),
 * with the prompt's identity as expect_prompt: the bridge re-reads the screen and presses only into
 * that prompt, else answers 409 (prompt_changed). The buttons are keyed on that identity, so a poll
 * can't swap a button out from under a tap, and a new prompt gets fresh ones. An option that asks for
 * typing ("Type something.", "Chat about this") switches the view to the terminal once it lands: the
 * composer is there.
 */
import { Button, Loader, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { apiPost, orchestratorPost } from '../api.ts';
import { showToast } from '../notify.ts';
import type { PaneView, PanelPrompt } from '../pane-view.ts';
import type { PromptOption } from '../prompt.ts';
import type { AskQuestion } from '../transcript.ts';
import { BUILD } from './Settings.tsx';

const COOLDOWN_MS = 1500; // the floor of the re-tap block after a sent answer

export function PromptPanel({ paneId, prompt, view }: { paneId: string; prompt: PanelPrompt; view: Pick<PaneView, 'answered' | 'reread' | 'setMode'> }) {
  const { parsed, id, screen } = prompt;
  const busy = useRef(false); // an answer is in flight or just sent: taps are ignored
  const gen = useRef(0); // per answer, so a stale POST or timer can't release a newer answer's guard
  const cooldown = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const term = useRef<HTMLDetailsElement>(null);
  const [sending, setSending] = useState(false); // the buttons are disabled
  const [sent, setSent] = useState<string | null>(null); // the tapped option, on this prompt's buttons

  const endCooldown = (): void => {
    if (cooldown.current) { clearTimeout(cooldown.current); cooldown.current = null; }
    busy.current = false;
    setSending(false);
  };

  // The panel goes (the pane left `blocked`, or the terminal is shown) with its guard: a new
  // blocked episode is a new prompt.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (cooldown.current) clearTimeout(cooldown.current);
    };
  }, []);

  // A new prompt on screen: its buttons are fresh, not the answered ones, so they're tappable at once
  // (even blocked → blocked with no unblock seen). A screen with no menu in between is left to the
  // unblock or the floor. The terminal collapses only under a question: bare Yes/No buttons need it
  // open, to read what they answer.
  useLayoutEffect(() => {
    setSent(null);
    if (parsed) endCooldown();
    term.current!.open = !parsed?.question;
  }, [id]);

  async function tap(o: PromptOption): Promise<void> {
    const to = parseInt(o.send, 10);
    // Claude's menus never exceed ~6 options: a multi-digit one would submit on its first digit, so
    // it's refused, and the terminal below stays the way to answer it.
    if (busy.current || !id || !Number.isInteger(to) || to < 1 || to > 9) return;
    const mine = ++gen.current;
    busy.current = true;
    if (cooldown.current) { clearTimeout(cooldown.current); cooldown.current = null; }
    setSending(true);
    setSent(o.send);
    const post = apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { press: String(to), expect_prompt: id });
    // "Chat about this" hands the turn back to the user in this pane (no closing the drawer after it);
    // "Type something." opens a text field in the prompt, no answer yet (nothing to confirm). Both wait
    // for typing, which is the terminal's (a pane's chat is read-only): it opens once the press lands.
    const chat = /^Chat about this/i.test(o.label);
    const typing = /^(?:\[.\] )?Type something/i.test(o.label); // a multi-select's has its box: "[ ] Type something"
    if (!typing) view.answered(id, chat, post);
    // the view's to do, not the panel's: the pane may leave `blocked` (the panel gone) before the press answers
    if (chat || typing) post.then(() => view.setMode('terminal', false), () => {});
    try {
      await post;
      if (!alive.current || mine !== gen.current) return;
      // The digit submitted the prompt, but the panel shows it (tappable) until the pane's status
      // refreshes: the guard holds through that, so a double tap can't press the digit again into
      // the next prompt. A new prompt or the pane leaving `blocked` releases it sooner.
      cooldown.current = setTimeout(() => { if (mine === gen.current) endCooldown(); }, COOLDOWN_MS);
    } catch (err) {
      if (mine !== gen.current) return; // a newer answer owns the guard
      setSent(null);
      endCooldown();
      if ((err as { code?: string }).code === 'prompt_changed') {
        // the prompt moved on before the digit landed: show the live one, for a new tap
        await view.reread(() => mine === gen.current);
        showToast('Prompt changed', 'The prompt updated before your tap was sent — try again.');
      } else {
        showToast('Send failed', (err as Error).message);
      }
    }
  }

  return (
    <div className={PANEL} id="chat-prompt">
      <Head>&#9203; Waiting for your input <Text span ff="monospace" fz={10} fw={400} c="dimmed">{BUILD}</Text></Head>
      <Question>{parsed?.question ?? ''}</Question>
      <Options>
        {parsed?.options.map((o) => (
          // while an answer is settling, the buttons take no taps: a double tap can't press the digit again into the next prompt
          <Option key={`${id}\n${o.send}`} num={o.send} label={o.label} description={o.description} marked={sent === o.send} disabled={sending}
            onClick={() => { void tap(o); }} />
        ))}
      </Options>
      <details className="chat-prompt-term" ref={term}>
        <summary>Terminal</summary>
        {screen === null
          ? <div className="chat-prompt-screen"><Loader size={20} /></div>
          : <div className="chat-prompt-screen" dangerouslySetInnerHTML={{ __html: screen }}></div>}
      </details>
    </div>
  );
}

/**
 * A headless orchestrator's question (the State's headless.pending: its AskUserQuestion, which the
 * bridge holds open): the questions one at a time, a tap per option, a multiSelect one as checks and
 * Next/Send, then every answer in one POST …/answer with the question's id. A stale id answers 409
 * (stale_question: answered, declined or interrupted meanwhile). The parent keys it on that id, so a
 * new question gets a fresh panel; the sent one stays disabled until the State takes it away. The
 * composer stays: a message sent meanwhile is the answer in the user's own words (the bridge's /send).
 */
export function HeadlessPrompt({ name, pending }: { name: string; pending: { id: string; questions: AskQuestion[] } }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<string[]>([]); // a multiSelect question's checked labels
  const [sending, setSending] = useState(false);
  const busy = useRef(false); // set at once, so a second tap before the re-render sends nothing
  const q = pending.questions[step];
  if (!q) return null;
  const last = step + 1 === pending.questions.length;

  async function submit(all: Record<string, string>): Promise<void> {
    busy.current = true;
    setSending(true);
    try {
      await orchestratorPost(name, 'answer', { id: pending.id, answers: all });
    } catch (err) {
      busy.current = false;
      setSending(false);
      setStep(0);
      setAnswers({});
      setPicked([]);
      const stale = (err as { code?: string }).code === 'stale_question';
      showToast(stale ? 'Question changed' : 'Answer failed', stale ? 'It was answered or withdrawn before yours arrived.' : (err as Error).message);
    }
  }

  function answer(label: string): void {
    if (busy.current) return;
    const all = { ...answers, [q.question]: label };
    if (last) { void submit(all); return; }
    setAnswers(all);
    setStep(step + 1);
    setPicked([]);
  }

  const toggle = (label: string): void => setPicked((p) => (p.includes(label) ? p.filter((l) => l !== label) : [...p, label]));
  return (
    <div className={PANEL} id="headless-prompt">
      <Head>&#9203; {q.header || 'Question'}{pending.questions.length > 1 ? ` (${step + 1}/${pending.questions.length})` : ''}</Head>
      <Question>{q.question}</Question>
      <Options>
        {q.options.map((o, i) => {
          const on = picked.includes(o.label);
          return (
            <Option key={o.label} num={q.multiSelect ? (on ? '✓' : '') : String(i + 1)} label={o.label} description={o.description}
              marked={q.multiSelect && on} pressed={q.multiSelect ? on : undefined} disabled={sending}
              onClick={() => { if (q.multiSelect) toggle(o.label); else answer(o.label); }} />
          );
        })}
      </Options>
      {q.multiSelect && (
        <Button id="headless-prompt-next" fullWidth mt={2} disabled={!picked.length || sending}
          onClick={() => answer(q.options.filter((o) => picked.includes(o.label)).map((o) => o.label).join(', '))}>
          {last ? 'Send' : 'Next'}
        </Button>
      )}
      <Text fz={12} c="dimmed" mt={8}>Or type your own answer below and send it.</Text>
    </div>
  );
}

// ── The panels' parts ─────────────────────────────────────────────────────────

// below the chat, an orange rule on top; past 45% of the screen it scrolls on its own
const PANEL = 'chat-prompt shrink-0 max-h-[45vh] overflow-y-auto border-t-2 border-(--color-blocked) bg-(--color-surface) px-3 py-2.5 lg:px-(--wide-gutter)';

const Head = ({ children }: { children: ReactNode }) => <Text className="chat-prompt-head" fz={12} fw={650} c="blocked" mb={8}>{children}</Text>;
// the question (none: no line)
const Question = ({ children }: { children: string }) => (
  <Text className="chat-prompt-q whitespace-pre-wrap wrap-anywhere empty:hidden" fz={14} lh={1.4} mb={8}>{children}</Text>
);
const Options = ({ children }: { children: ReactNode }) => <div className="flex flex-col gap-1.5 not-empty:mb-2">{children}</div>;

/** An answer: its number (or a multiSelect's ✓) on orange, its label, its description under it smaller and dimmer.
 *  `marked`: the one tapped, or a multiSelect's checked one. */
function Option({ num, label, description, marked, pressed, disabled, onClick }:
  { num: string; label: string; description: string; marked: boolean; pressed?: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <UnstyledButton disabled={disabled} aria-pressed={pressed} onClick={onClick}
      className={`ask-opt${marked ? ' ask-opt-sent' : ''} flex min-h-11 items-baseline gap-2 rounded-lg border bg-(--color-surface-2) px-3 py-2.5 text-left text-[14px] text-(--color-text) active:bg-(--color-border) disabled:opacity-55 ${marked ? 'border-(--color-done) opacity-60' : 'border-(--color-border)'}`}>
      <span className="ask-opt-num bg-(--color-blocked) text-white">{num}</span>
      <span className="ask-opt-text flex min-w-0 flex-col gap-0.5 wrap-anywhere">
        <span className="ask-opt-label">{label}</span>
        {description ? <span className="ask-opt-desc text-[12px] leading-[1.4]">{description}</span> : null}
      </span>
    </UnstyledButton>
  );
}
