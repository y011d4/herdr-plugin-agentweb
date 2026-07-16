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
  // Truncate at the LAST navigation hint — that belongs to the bottom-most (active)
  // prompt, the same block parsePrompt() renders buttons for. Stopping at the first
  // hint would end at an older prompt scrolled above and drop the active one from the
  // identity. Everything below the active hint is the volatile status bar, excluded.
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/(Enter to select|to navigate|Esc to (cancel|close)|↑\/↓|↑ ↓)/i.test(lines[i])) end = i + 1;
  }
  return lines.slice(0, end).join('\n').replace(/\n{2,}/g, '\n').trim();
}
