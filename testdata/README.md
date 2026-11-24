# testdata

Recordings of the TypeScript bridge, which the Go bridge (its port) must
reproduce. Both are taken against `tools/fakeherdr`, a scriptable fake herdr
socket, never against a real herdr.

## scenarios/

What the TypeScript herdr client (`server/herdr-client.ts`) reports in each
situation of `tools/fakeherdr/scenarios.go`: status changes, state pushes (each
pane's agent status and seqs) and connection changes.
`internal/bridge/herdr_client_test.go` runs the same scenarios against the Go client
and compares with `fakeherdr.Compare`: each pane's transitions in order, connection
changes in order, the last state, and for `CountStates` scenarios the number of
state pushes. Timing and how different panes' transitions interleave are not
compared.

Regenerate (about 40 s; needs node ≥ 23.6 and `npm ci`):

    go run ./tools/fakeherdr/cmd/record-scenarios [name...]

## wire/

Per operation (REST, WS, CLI): the requests herdr received, in order, and the HTTP
answer, WS messages or CLI output. Paths under the recording's temp dir read `$TMP`,
generated agent names `claude-<time>`, and the bridge's token and port `<token>` and
`<port>`.

The recorder runs the bridge on 127.0.0.1:8392 with every directory (state, config,
data, HOME, a scratch git repo with an origin) in a fresh temp dir, two `sleep`
processes standing in for agents of two Claude accounts, and fakes first on PATH:
`herdr` and `gh` log their calls (listed under `herdrCli`), `direnv` runs a command
with the dir's `.envrc` loaded (no allow list), and `tailscale` and `qrencode` act as
absent, so nothing depends on this machine's own setup. Each CLI command runs under
`setsid -f`, detached from any `claude` process, since the CLI takes its nearest
claude ancestor's account as its own. From the repo root (needs node >= 23.6):

    go build -o /tmp/record-wire ./tools/fakeherdr/cmd/record-wire && /tmp/record-wire

It writes `wire/DONE` (or `wire/FAILED`) when finished. Two runs give the same files,
except the order of a fan-out the TypeScript sends concurrently (`cli-overview`'s
account lookups).

`TestGoMatchesWireRecordings` (`tools/fakeherdr/cmd/record-wire/main_test.go`, part of
`go test ./...`; build the web UI first) builds the Go `agentwebctl`, records it
(`agentwebctl serve` and its CLI commands) through every operation on a free port, and
compares:

- the HTTP exchange and WS messages as JSON values (key order doesn't count; WS
  messages received as a set);
- the CLI's arguments, exit code, stdout and stderr exactly, and the fake
  `herdr`/`gh` calls. The TypeScript's usage lines say `agentwebctl.js` where the Go
  ones say `agentwebctl`;
- the herdr requests in order. A run of the same method counts as a set (a fan-out
  the TypeScript sends concurrently). The WS watches poll on a timer, so they are
  compared as the set of distinct requests.

`agent.list`, `pane.process_info` and `session.snapshot` may also come from the
bridge's background work (completion seqs, the account cache, rebuilds), so a
comparison that differs only in those needs a look before it counts.
