/**
 * prompt-identity.ts — pure identity of an on-screen TUI prompt region.
 *
 * MUST stay byte-for-byte in sync with stripAnsi()/promptIdentity() in
 * web/src/app.ts. The client sends the identity it computed as `expect_prompt`,
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

// Identity of the visible prompt region: the context and menu down through the
// "Enter to select…" navigation hint, with box-drawing and ❯ selection markers
// stripped and the volatile status bar below the hint excluded. Captures the
// literal on-screen question text (even when parsing yields no question), so two
// distinct prompts that share a parsed signature still get different identities,
// while cursor moves and status-bar ticks don't churn it.
export function promptIdentity(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼❯➤▶►]/g, ' ').replace(/\s+$/, ''));
  // The active prompt's bottom edge is the LAST of its navigation hint or its last
  // numbered option (a ❯-only menu has no hint); everything below is the volatile
  // status bar and must be excluded or the identity churns and every tap 409s. The
  // hint set MUST match parsePrompt's guard and the option pattern its matcher (with
  // ❯ markers already stripped above), so the identity always covers exactly the
  // block parsePrompt renders buttons for — never the status bar, never nothing.
  const HINT = /(Enter to select|to navigate|to select|Esc to (cancel|close)|↑\/↓|↑ ↓|Tab to|Space to)/i;
  const OPTION = /^\s*\d+[.)]\s+\S/;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (HINT.test(lines[i]) || OPTION.test(lines[i])) end = i + 1;
  }
  return lines.slice(0, end).join('\n').replace(/\n{2,}/g, '\n').trim();
}
