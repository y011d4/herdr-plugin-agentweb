/**
 * prompt-identity.ts — pure identity of an on-screen TUI prompt region.
 *
 * MUST stay byte-for-byte in sync with stripAnsi()/parsePrompt()/promptIdentity()
 * in web/src/prompt.ts. The client sends the identity it computed as `expect_prompt`,
 * and the bridge recomputes it from a fresh read — gated on parsePrompt, exactly like
 * the client — to confirm the prompt hasn't changed before pressing the answer digit
 * (closing the client read->POST TOCTOU gap). If the implementations diverge, an
 * answer would 409 or, worse, a stale menu could verify. Server and web are separate
 * tsc projects sharing only the REST contract, so this is duplicated rather than
 * imported — change both sides together (a test diff-checks the shared functions).
 */

export interface PromptOption { send: string; label: string }
export interface ParsedPrompt { question: string | null; options: PromptOption[]; selected: number }

// Strip ANSI escapes (CSI + OSC) to plain text. ESC/BEL are written as \x1b/\x07
// escapes (not raw control bytes), matching the client regex exactly.
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
}

// A menu's navigation hint line. Menu-specific on purpose — NOT "Tab to"/"Space to",
// which appear in the composer/status bar ("shift+tab to cycle") and would sweep the
// volatile status bar into the identity. Kept in sync with web/src/prompt.ts.
const MENU_HINT = /(Enter to (select|confirm)|↑\/↓|↑ ↓|Esc to (cancel|close))/i;

// Identity of the visible prompt region: the context and menu down through the last
// navigation hint or last numbered option (a ❯-only menu has no hint), with box-
// drawing and ❯ selection markers stripped and the volatile status bar below the menu
// excluded. Captures the literal on-screen question text (even when parsing yields no
// question), so two distinct prompts that share a parsed signature still get different
// identities, while cursor moves and status-bar ticks don't churn it.
export function promptIdentity(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼❯➤▶►]/g, ' ').replace(/\s+$/, ''));
  const OPTION = /^\s*\d+[.)]\s+\S/;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (MENU_HINT.test(lines[i]) || OPTION.test(lines[i])) end = i + 1;
  }
  return lines.slice(0, end).join('\n').replace(/\n{2,}/g, '\n').trim();
}

// Verbatim copy of parsePrompt() from web/src/prompt.ts (keep in sync). The bridge
// gates the verify identity on this so a screen the client would NOT treat as an
// active answerable menu (e.g. a stale menu above a different active prompt) yields
// an empty id that won't match the client's expect_prompt → the answer is refused.
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
  if (best.selected === 0) return null;
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
