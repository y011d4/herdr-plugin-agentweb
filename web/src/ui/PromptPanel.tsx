/**
 * ui/PromptPanel.tsx — the answer panel of a blocked pane in chat, shown by ui/Pane.tsx while
 * pane-view.ts reports a prompt (it polls the screen and decides when the panel shows): the
 * question and a button per option of the menu read off the screen, with the raw screen as
 * collapsible context below. The composer and quick keys stay available.
 *
 * A tap presses the option's digit, one atomic keystroke that selects and submits it (CLAUDE.md),
 * with the prompt's identity as expect_prompt: the bridge re-reads the screen and presses only into
 * that prompt, else answers 409 (prompt_changed). The buttons are keyed on that identity, so a poll
 * can't swap a button out from under a tap, and a new prompt gets fresh ones.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiPost, orchestratorPost } from '../api.ts';
import { showToast } from '../notify.ts';
import type { PaneView, PanelPrompt } from '../pane-view.ts';
import type { PromptOption } from '../prompt.ts';
import type { AskQuestion } from '../transcript.ts';
import { BUILD } from './Settings.tsx';

const COOLDOWN_MS = 1500; // the floor of the re-tap block after a sent answer

export function PromptPanel({ paneId, prompt, view }: { paneId: string; prompt: PanelPrompt; view: Pick<PaneView, 'answered' | 'reread'> }) {
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
    // "Chat about this" hands the turn back to the user in this pane: no going Back after it
    view.answered(id, /^Chat about this/i.test(o.label), post);
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
    <div className={sending ? 'chat-prompt chat-prompt-sending' : 'chat-prompt'} id="chat-prompt">
      <div className="chat-prompt-head">&#9203; Waiting for your input <span className="chat-prompt-build">{BUILD}</span></div>
      <div className="chat-prompt-q">{parsed?.question ?? ''}</div>
      <div className="chat-prompt-options">
        {parsed?.options.map((o) => (
          <button key={`${id}\n${o.send}`} className={sent === o.send ? 'ask-opt ask-opt-sent' : 'ask-opt'} type="button" onClick={() => { void tap(o); }}>
            <span className="ask-opt-num">{o.send}</span>
            <span className="ask-opt-text">
              <span className="ask-opt-label">{o.label}</span>
              {o.description ? <span className="ask-opt-desc">{o.description}</span> : null}
            </span>
          </button>
        ))}
      </div>
      <details className="chat-prompt-term" ref={term}>
        <summary>Terminal</summary>
        {screen === null
          ? <div className="chat-prompt-screen"><span className="loading-spinner"></span></div>
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
 * composer stays: a message sent meanwhile declines the question with its text (the bridge's /send).
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
    <div className={sending ? 'chat-prompt chat-prompt-sending' : 'chat-prompt'} id="headless-prompt">
      <div className="chat-prompt-head">
        &#9203; {q.header || 'Question'}{pending.questions.length > 1 ? ` (${step + 1}/${pending.questions.length})` : ''}
      </div>
      <div className="chat-prompt-q">{q.question}</div>
      <div className="chat-prompt-options">
        {q.options.map((o, i) => (
          <button key={o.label} type="button" className={q.multiSelect && picked.includes(o.label) ? 'ask-opt ask-opt-sent' : 'ask-opt'}
            aria-pressed={q.multiSelect ? picked.includes(o.label) : undefined}
            onClick={() => { if (q.multiSelect) toggle(o.label); else answer(o.label); }}>
            <span className="ask-opt-num">{q.multiSelect ? (picked.includes(o.label) ? '✓' : '') : i + 1}</span>
            <span className="ask-opt-text">
              <span className="ask-opt-label">{o.label}</span>
              {o.description ? <span className="ask-opt-desc">{o.description}</span> : null}
            </span>
          </button>
        ))}
      </div>
      {q.multiSelect && (
        <button type="button" className="btn-primary" id="headless-prompt-next" disabled={!picked.length || sending}
          onClick={() => answer(q.options.filter((o) => picked.includes(o.label)).map((o) => o.label).join(', '))}>
          {last ? 'Send' : 'Next'}
        </button>
      )}
      <div className="chat-prompt-hint">Or type a reply below: it declines the question with your words.</div>
    </div>
  );
}
