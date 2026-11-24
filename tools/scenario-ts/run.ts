// Runs the TypeScript herdr client against a socket and prints what it reports, one
// JSON line each (the fakeherdr Output shape), for tools/fakeherdr/cmd/record-scenarios.
// stdin takes commands: "refresh" (client.refresh()) and "exit".
// Usage: node tools/scenario-ts/run.ts <socket path>
// Delete with the TypeScript server (CLAUDE.md, Follow-ups).
import { createInterface } from 'node:readline';
import { createHerdrClient } from '../../server/herdr-client.ts';
import type { NormalizedState } from '../../server/types.ts';

const t0 = Date.now();
const out = (o: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify({ t: Date.now() - t0, ...o }) + '\n');
};

function panes(state: NormalizedState): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const [id, p] of state._paneById) {
    m[id] = p.agent ? { status: p.agent.status, seq: p.agent.completionSeq, changeSeq: p.agent.stateChangeSeq } : null;
  }
  return m;
}

function tabs(state: NormalizedState): Record<string, string> {
  return Object.fromEntries([...state._tabById].map(([id, t]) => [id, t.label]));
}

const client = createHerdrClient({
  socketPath: process.argv[2],
  onState(state) {
    const f = state.focused;
    out({
      kind: 'state', connected: state.connected, panes: panes(state),
      focused: `${f.workspaceId ?? ''}/${f.tabId ?? ''}/${f.paneId ?? ''}`, tabs: tabs(state),
    });
  },
  onAgentStatus(change) { out({ kind: 'status', paneId: change.paneId, from: change.from, to: change.to }); },
  onConnectionChange(connected) { out({ kind: 'conn', connected }); },
});
client.start();

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'refresh') void client.refresh().catch(() => {});
  if (line === 'exit') { client.destroy(); process.exit(0); }
});
