/**
 * prompt.ts — pure parsing/identity for a live TUI prompt on a pane's screen.
 *
 * DOM-free so it can be unit-tested (server/test/prompt.test.ts). stripAnsi and
 * promptIdentity are duplicated byte-for-byte in server/prompt-identity.ts (the
 * bridge recomputes the identity to verify answers); keep the two in sync.
 */
// Strip ANSI escapes to plain text for parsing the on-screen prompt. ESC/BEL are
// written as \x1b/\x07 escapes (not raw control bytes).
export function stripAnsi(s) {
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
export function parsePrompt(text) {
    const raw = text.split('\n'); // kept un-stripped so the menu box border (│) is visible
    const lines = raw.map((l) => l.replace(/[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼]/g, ' ').replace(/\s+$/, ''));
    const blocks = [];
    let cur = [];
    let sel = 0;
    let first = -1;
    let gap = 0;
    const commit = () => {
        if (cur.length >= 2)
            blocks.push({ options: cur, selected: sel, first });
        cur = [];
        sel = 0;
        first = -1;
        gap = 0;
    };
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^\s*([❯➤▶►])?\s*(\d+)[.)]\s+(\S.*)$/);
        if (!m) {
            if (cur.length && ++gap > 4)
                commit();
            continue;
        }
        gap = 0;
        const num = Number(m[2]);
        if (num === cur.length + 1) {
            if (first < 0)
                first = i;
            if (m[1])
                sel = num;
            cur.push({ send: m[2], label: m[3].trim() });
        }
        else {
            commit();
            if (num === 1) {
                cur = [{ send: '1', label: m[3].trim() }];
                first = i;
                if (m[1])
                    sel = 1;
            }
        }
    }
    commit();
    const best = blocks.length ? blocks[blocks.length - 1] : null; // bottom-most block
    if (!best)
        return null;
    // Require the ❯ highlight: an active menu always marks its current option, ordinary
    // numbered prose never does. A navigation hint is NOT used to promote a block —
    // a hint below the numbers could belong to a *different* prompt beneath unrelated
    // prose, which must not become tappable buttons. Unhighlighted numbers are plain
    // terminal output; the raw terminal (always shown) stays the way to answer them.
    if (best.selected === 0)
        return null;
    // Question: the contiguous lines just above the first option (a long prompt wraps
    // across several lines). Claude renders the prompt inside a box drawn with a
    // horizontal ─ rule on top and a ☐ category line, with a blank padding line
    // between the question and the options — so a naive "stop at the first blank"
    // loses the question. Walk up, skipping padding blanks and collecting text, until
    // the box's top edge (a ─/━ rule or the ☐/☑ category line). Only accept the text
    // if that edge was actually reached: unrelated terminal output above a bare menu
    // has no such boundary, so it is left out instead of shown as a bogus question.
    const isRule = (i) => /[─━]{4,}/.test(raw[i] ?? '');
    const qLines = [];
    let boxed = false;
    for (let i = best.first - 1; i >= 0 && i >= best.first - 12; i--) {
        const t = lines[i].trim();
        if (isRule(i)) {
            boxed = true;
            break;
        } // box top rule — edge reached
        if (/^[☐☑✓]/.test(t)) {
            boxed = true;
            break;
        } // category/title line — edge reached
        if (!t)
            continue; // padding blank — keep looking for the box edge
        if (/^(Enter to select|Press|Type something|Chat about this|↑|↓|Esc|Tab)/i.test(t))
            continue;
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
export function promptIdentity(text) {
    const lines = text.split('\n').map((l) => l.replace(/[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼❯➤▶►]/g, ' ').replace(/\s+$/, ''));
    const HINT = /(Enter to select|to navigate|to select|Esc to (cancel|close)|↑\/↓|↑ ↓|Tab to|Space to)/i;
    const OPTION = /^\s*\d+[.)]\s+\S/;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
        if (HINT.test(lines[i]) || OPTION.test(lines[i]))
            end = i + 1;
    }
    return lines.slice(0, end).join('\n').replace(/\n{2,}/g, '\n').trim();
}
