/**
 * prompt-identity.ts — pure identity of an on-screen TUI prompt region.
 *
 * MUST stay byte-for-byte in sync with stripAnsi()/promptIdentity() in
 * web/src/prompt.ts. The client sends the identity it computed as `expect_prompt`,
 * and the bridge recomputes it from a fresh read to confirm the prompt hasn't
 * changed before pressing the answer digit (closing the client read->POST TOCTOU
 * gap). If the two implementations diverge, every answer would 409. Server and web
 * are separate tsc projects sharing only the REST contract, so this is duplicated
 * rather than imported — change both sides together.
 */

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
