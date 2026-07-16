/**
 * prompt.ts — pure parsing/identity for a live TUI prompt on a pane's screen.
 *
 * DOM-free so it can be unit-tested (server/test/prompt.test.ts). stripAnsi and
 * promptIdentity are duplicated byte-for-byte in server/prompt-identity.ts (the
 * bridge recomputes the identity to verify answers); keep the two in sync.
 */

export interface PromptOption { send: string; label: string }
export interface ParsedPrompt { question: string | null; options: PromptOption[]; selected: number }

// A menu's navigation hint line. Deliberately menu-specific ("Enter to select /
// confirm", the ↑/↓ arrows, "Esc to cancel / close") — NOT generic phrases like
// "Tab to" or "Space to", which appear in the composer/status bar (e.g. "shift+tab
// to cycle") and would otherwise sweep the volatile status bar into the identity or
// mislabel it as a prompt hint.
const MENU_HINT = /(Enter to (select|confirm)|↑\/↓|↑ ↓|Esc to (cancel|close))/i;

// Strip ANSI escapes to plain text for parsing the on-screen prompt. ESC/BEL are
// written as \x1b/\x07 escapes (not raw control bytes).
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
}

// Parse a numbered selection menu ("❯ 1. Yes\n  2. No …") out of a live TUI prompt
// (permission / plan / confirm / AskUserQuestion dialogs), which carry no structured
// transcript data: the question text, the options (bottom-most sequential 1,2,3…
// block), and which option is highlighted (the ❯ marker, 1-based). Non-option lines
// — each option's own description, dividers, blanks — sit between options, so they're
// skipped without ending the block; a long run of unrelated lines (gap > 4) ends it
// and a fresh "1." restarts it. Requires >= 2 options AND a ❯ highlight: an active
// menu always highlights an option, while ordinary numbered prose ("1. do X … 2. do
// Y") does not, so the marker is what tells a real, answerable menu from plain output.
// (Verified against a real captured AskUserQuestion screen.)
export function parsePrompt(text: string): ParsedPrompt | null {
  const raw = text.split('\n'); // kept un-stripped so the menu box border (│) is visible
  const lines = raw.map((l) => l.replace(/[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼]/g, ' ').replace(/\s+$/, ''));
  const blocks: Array<{ options: PromptOption[]; selected: number; first: number; last: number }> = [];
  let cur: PromptOption[] = [];
  let sel = 0;
  let first = -1;
  let last = -1;
  let gap = 0;
  const commit = (): void => {
    if (cur.length >= 2) blocks.push({ options: cur, selected: sel, first, last });
    cur = []; sel = 0; first = -1; last = -1; gap = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([❯➤▶►])?\s*(\d+)[.)]\s+(\S.*)$/);
    if (!m) { if (cur.length && ++gap > 4) commit(); continue; }
    gap = 0;
    const num = Number(m[2]);
    if (num === cur.length + 1) {
      if (first < 0) first = i;
      last = i;
      if (m[1]) sel = num;
      cur.push({ send: m[2], label: m[3].trim() });
    } else {
      commit();
      if (num === 1) { cur = [{ send: '1', label: m[3].trim() }]; first = i; last = i; if (m[1]) sel = 1; }
    }
  }
  commit();
  const best = blocks.length ? blocks[blocks.length - 1] : null; // bottom-most block
  if (!best) return null;
  // Require the ❯ highlight: an active menu always marks its current option, ordinary
  // numbered prose never does. A navigation hint is NOT used to promote a block —
  // a hint below the numbers could belong to a *different* prompt beneath unrelated
  // prose, which must not become tappable buttons. Unhighlighted numbers are plain
  // terminal output; the raw terminal (always shown) stays the way to answer them.
  if (best.selected === 0) return null;
  // Reject if the active prompt is actually a DIFFERENT one below this block. Walk
  // down from the last option: a real active menu's own hint follows through only
  // menu-continuation lines (blank, indented option description), and when a pane is
  // blocked on a menu that hint is the bottom of the screen — nothing (no composer or
  // status bar) is rendered below it. So reaching the menu's own hint ends the scan
  // cleanly. Anything else below the options is a DIFFERENT prompt: a new box (a ─/━
  // top rule in the raw line, or a ☐/☑ category — its inner text is indented too, so
  // key on the box boundary, not the indent) or other left-aligned content. If any
  // such foreign content is seen, this highlighted block is stale scrollback above a
  // lower active prompt and must not be offered as buttons — reject it even when that
  // lower prompt has no navigation hint of its own (EOF). Hints ABOVE are ignored.
  let sawForeign = false;
  for (let i = best.last + 1; i < lines.length; i++) {
    const t = lines[i];
    if (MENU_HINT.test(t)) break; // the menu's own hint (nothing foreign preceded it) — end of the menu
    if (/[─━]{4,}/.test(raw[i] ?? '') || /^[☐☑✓]/.test(t.trim())) { sawForeign = true; continue; } // new box/category
    if (!t.trim()) continue; // blank — continuation
    if (/^\s+\S/.test(t)) continue; // indented option description — continuation
    sawForeign = true; // left-aligned content below the options → a different prompt
  }
  if (sawForeign) return null; // a different prompt sits below this block → it is stale, hint or not
  // Question: the contiguous lines just above the first option (a long prompt wraps
  // across several lines). Claude renders the prompt inside a box drawn with a
  // horizontal ─ rule on top and a ☐ category line, with a blank padding line
  // between the question and the options — so a naive "stop at the first blank"
  // loses the question. Walk up, skipping padding blanks and collecting text, until
  // the box's top edge (a ─/━ rule or the ☐/☑ category line). Only accept the text
  // if that edge was actually reached: unrelated terminal output above a bare menu
  // has no such boundary, so it is left out instead of shown as a bogus question.
  const isRule = (i: number): boolean => /[─━]{4,}/.test(raw[i] ?? '');
  const qLines: string[] = [];
  let boxed = false;
  for (let i = best.first - 1; i >= 0 && i >= best.first - 12; i--) {
    const t = lines[i].trim();
    if (isRule(i)) { boxed = true; break; } // box top rule — edge reached
    if (/^[☐☑✓]/.test(t)) { boxed = true; break; } // category/title line — edge reached
    if (!t) continue; // padding blank — keep looking for the box edge
    if (/^(Enter to select|Press|Type something|Chat about this|↑|↓|Esc|Tab)/i.test(t)) continue;
    qLines.unshift(t.replace(/^[•·]+\s*/, ''));
  }
  const question = boxed && qLines.length ? qLines.join(' ') : null;
  return { question, options: best.options, selected: best.selected };
}

// Identity of the on-screen prompt, used to skip needless re-renders and — when
// answering — to detect that the prompt changed out from under a stale button so a
// digit never lands on a different prompt. It hashes the visible prompt REGION rather
// than just the parsed question+options: that captures the literal on-screen question
// text even when parsing yields a null question, so two distinct prompts that share
// the same parsed signature (e.g. a null question with Yes/No) still get different
// ids. The active prompt's bottom edge is the LAST of its navigation hint or its last
// numbered option (a ❯-only menu has no hint); everything below is the volatile status
// bar and must be excluded or the identity churns and every tap 409s. Box-drawing and
// ❯ selection markers are stripped so cursor movement and borders don't churn it.
export function promptIdentity(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼❯➤▶►]/g, ' ').replace(/\s+$/, ''));
  const OPTION = /^\s*\d+[.)]\s+\S/;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (MENU_HINT.test(lines[i]) || OPTION.test(lines[i])) end = i + 1;
  }
  return lines.slice(0, end).join('\n').replace(/\n{2,}/g, '\n').trim();
}
