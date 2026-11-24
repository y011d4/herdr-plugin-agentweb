// Writes testdata/vectors/injected-turns.json: which user turns are ones Claude Code
// writes itself (background-task wakeups, reminders, slash commands, `!` runs) rather
// than the user's own words. The web home chat (web/src/transcript.ts
// conversationItems) and the overview's task line (isTaskTurn in
// internal/bridge/overview.go) each carry this rule; the vectors keep them in step:
// web/test/injected-turns-vectors.test.ts and internal/bridge/vectors_test.go check
// both sides against this file, which is written from the web copy.
// Usage: node tools/vectors/injected-turns.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { conversationItems, type TimelineItem } from '../../web/src/transcript.ts';

const texts = [
  'fix the bug',
  '<task-notification>agent w-x finished</task-notification>',
  '<system-reminder>be brief</system-reminder>',
  '<local-command-stdout>ok</local-command-stdout>',
  '<local-command-caveat>x</local-command-caveat>',
  '<command-name>/clear</command-name>',
  '<command-message>clear</command-message>',
  '<command-args></command-args>',
  '<bash-input>ls</bash-input>',
  '<bash-stdout>a</bash-stdout>',
  '<bash-stderr>e</bash-stderr>',
  '  \n<system-reminder>indented</system-reminder>',
  '　<task-notification>ideographic space first</task-notification>',
  ' <bash-input>no-break space first</bash-input>',
  '<pasted_content>the user\'s own paste</pasted_content>',
  'see <system-reminder> later in the text',
  '<System-Reminder>case matters</System-Reminder>',
  '<command-namex>not a known tag</command-namex>',
  '<bash-output>not a known tag</bash-output>',
  '',
];

const user = (text: string): TimelineItem => ({ kind: 'user', text, sidechain: false, ts: null });
const vectors = texts.map((text) => ({ text, injected: conversationItems([user(text)]).length === 0 }));
const dir = new URL('../../testdata/vectors/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('injected-turns.json', dir), JSON.stringify(vectors, null, 2) + '\n');
