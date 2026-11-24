/**
 * prompt.ts — pure parsing/identity for a live TUI prompt on a pane's screen.
 *
 * DOM-free so it can be unit-tested (web/test/prompt.test.ts). stripAnsi and
 * promptIdentity are duplicated in the Go bridge (internal/bridge/prompt_identity.go,
 * which recomputes the identity to verify answers); testdata/vectors/prompt.json keeps
 * the two in sync.
 */

// description: the text Claude Code prints under an option, indented ('' if none).
export interface PromptOption { send: string; label: string; description: string }
export interface ParsedPrompt { question: string | null; options: PromptOption[]; selected: number }

// Terminal display width of a line: CJK and other wide glyphs occupy two cells.
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
export function displayCols(line: string): number {
  let w = 0;
  for (const ch of line) w += WIDE_CHAR.test(ch) ? 2 : 1;
  return w;
}

// Whether `next` is the terminal's wrap of `prev` on a screen `width` cells wide: `prev`
// left no room for next's first word. The room is capped so a long first word (a path,
// a run of CJK text) under a short line still reads as a line of its own.
// ponytail: positions only, so a label ending within a word of the right edge takes its
// description as its own tail (rare: labels are short); Claude Code dims descriptions,
// so the ANSI style of the two lines would tell them apart if that ever matters.
function isWrap(prev: string, next: string, width: number): boolean {
  const room = width - displayCols(prev);
  return room <= 12 && room <= displayCols(next.match(/\S+/)?.[0] ?? '');
}

// Rejoin line `next` to `text`, which ends with line `prev`. A word wrap dropped a
// space there. A word too long for a whole line (a path) was split mid-word, and CJK
// text breaks between any two glyphs; those dropped none, and filled `prev` (up to one
// cell short when the next glyph is wide and didn't fit).
// ponytail: two separate words that each fill most of a line, the first ending right
// at the edge, look the same as one split word (Claude Code marks neither) and get
// joined; a long path split mid-word is the common case, so it wins.
function joinWrap(text: string, prev: string, next: string, width: number): string {
  const t = next.trim();
  const tail = prev.match(/\S+$/)?.[0] ?? '';
  const head = t.match(/^\S+/)?.[0] ?? '';
  const room = width - displayCols(prev);
  const full = room === 0 || (room === 1 && WIDE_CHAR.test(head[0] ?? ''));
  const split = full && (displayCols(tail + head) > width - next.search(/\S/) ||
    (WIDE_CHAR.test(tail.slice(-1)) && WIDE_CHAR.test(head[0] ?? '')));
  return split ? text + t : `${text} ${t}`;
}

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
// block), and which option is highlighted (the ❯ marker, 1-based). The lines right
// under an option that are indented at least to its text (past a multi-select's "[ ]"
// box, so that menu's unnumbered "Submit" row is not one) continue it: first the rest
// of a label the terminal wrapped, then its description (Claude Code prints those
// below the label, however many lines they wrap to). Other non-option lines —
// dividers, blanks — sit between options too, so they're skipped without ending the
// block; a long run of them (gap > 4) ends it and a fresh "1." restarts it. Requires
// >= 2 options AND a ❯ highlight: an active menu always highlights an option, while ordinary numbered prose ("1. do X … 2. do
// Y") does not, so the marker is what tells a real, answerable menu from plain output.
// (Verified against a real captured AskUserQuestion screen.)
export function parsePrompt(text: string): ParsedPrompt | null {
  const raw = text.split('\n'); // kept un-stripped so the menu box border (│) is visible
  const lines = raw.map((l) => l.replace(/[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼]/g, ' ').replace(/\s+$/, ''));
  const width = Math.max(...raw.map((l) => displayCols(l.replace(/\s+$/, '')))); // the full-width ─ rule
  const blocks: Array<{ options: PromptOption[]; selected: number; first: number; last: number }> = [];
  let cur: PromptOption[] = [];
  let sel = 0;
  let first = -1;
  let last = -1;
  let gap = 0;
  let col = 0; // the column of the current option's text
  let cont = false; // still on lines continuing the current option
  let inLabel = false; // ...and on the label's wrapped part, not yet its description
  const commit = (): void => {
    if (cur.length >= 2) blocks.push({ options: cur, selected: sel, first, last });
    cur = []; sel = 0; first = -1; last = -1; gap = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // A line indented to the current option's text continues it, even one that reads
    // like an option ("2. …" in a description), and is no gap.
    if (cur.length && cont && t && lines[i].search(/\S/) >= col) {
      const o = cur[cur.length - 1];
      const prev = lines[i - 1];
      if (inLabel && isWrap(prev, lines[i], width)) o.label = joinWrap(o.label, prev, lines[i], width);
      else { inLabel = false; o.description = o.description ? joinWrap(o.description, prev, lines[i], width) : t; }
      continue;
    }
    const m = lines[i].match(/^\s*([❯➤▶►])?\s*(\d+)[.)]\s+(\S.*)$/);
    if (!m) {
      if (cur.length) { cont = false; if (++gap > 4) commit(); }
      continue;
    }
    gap = 0;
    col = lines[i].length - m[3].length + (/^\[.\] /u.test(m[3]) ? 4 : 0);
    cont = inLabel = true;
    const num = Number(m[2]);
    if (num === cur.length + 1) {
      if (first < 0) first = i;
      last = i;
      if (m[1]) sel = num;
      cur.push({ send: m[2], label: m[3].trim(), description: '' });
    } else {
      commit();
      if (num === 1) { cur = [{ send: '1', label: m[3].trim(), description: '' }]; first = i; last = i; if (m[1]) sel = 1; }
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
  // menu-continuation lines (blank, or an indented option description like
  // "     ✓ recommended"), and when a pane is blocked on a menu that hint is the
  // bottom of the screen — nothing (no composer or status bar) is rendered below it.
  // So reaching the menu's own hint ends the scan cleanly. Anything else below the
  // options is a DIFFERENT prompt: a new box (its ─/━ top rule in the raw line) or
  // left-aligned content. (We key on the box's rule, NOT its ☐/☑ category line — a
  // category is indistinguishable from an indented "✓"/"☐" option description, so
  // matching it here would reject a valid described menu; the box's rule flags the new
  // prompt anyway.) If any such foreign content is seen, this highlighted block is
  // stale scrollback above a lower active prompt and must not be offered as buttons —
  // reject it even when that lower prompt has no navigation hint of its own (EOF).
  // Hints ABOVE are ignored.
  let sawForeign = false;
  for (let i = best.last + 1; i < lines.length; i++) {
    const t = lines[i];
    if (MENU_HINT.test(t)) break; // the menu's own hint (nothing foreign preceded it) — end of the menu
    if (/[─━]{4,}/.test(raw[i] ?? '')) { sawForeign = true; continue; } // a new box's top rule below = a different prompt
    if (!t.trim()) continue; // blank — continuation
    if (/^\s+\S/.test(t)) continue; // indented option description — continuation (e.g. "     ✓ recommended")
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
    if (/^[←☐☑✓]/.test(t)) { boxed = true; break; } // category/title line, or the tab bar of several questions — edge reached
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
