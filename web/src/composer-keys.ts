/**
 * Enter in a composer: on a PC it sends (Shift+Enter inserts a newline), on a touch
 * device it inserts a newline and only the Send button sends, so a phone keyboard's
 * return key can't fire off a half-typed message. Pure, so it is unit-testable.
 */

/**
 * A PC: the primary pointer is a mouse or trackpad (fine, can hover). It asks what the
 * device is rather than what the UA string claims: phones and tablets answer
 * `hover: none` / `pointer: coarse` whatever browser they run (and a UA string can be
 * desktop-mode spoofed), while a touchscreen laptop answers for its trackpad and has a
 * keyboard. The primary pointer, not `any-pointer`: that would turn a phone with a
 * stylus or a mouse paired once into a PC. Read on each keydown, so it follows changes.
 */
export const DESKTOP_QUERY = '(hover: hover) and (pointer: fine)';

type EnterKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing' | 'keyCode'>;

/** Whether this keydown sends the message instead of inserting a newline. */
export function enterSends(e: EnterKey, desktop: boolean): boolean {
  // The Enter that confirms an IME conversion must never send: isComposing marks it,
  // and Safari fires it after compositionend (isComposing false) with keyCode 229.
  if (e.isComposing || e.keyCode === 229) return false;
  return desktop && e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
}
