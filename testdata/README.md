# testdata

Recordings of the TypeScript bridge, which the Go port (docs/go-migration-plan.md)
must reproduce. Both are taken against `tools/fakeherdr`, a scriptable fake herdr
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
generated agent names `claude-<time>`, the stand-in processes' pids `<pid-…>`.

The recorder runs the bridge on 127.0.0.1:8392 with every directory (state, config,
data, HOME, a scratch git repo with an origin) in a fresh temp dir, two `sleep`
processes standing in for agents of two Claude accounts, and fake `herdr`/`gh` CLIs
first on PATH (their calls are listed under `herdrCli`). The CLI ones need `direnv`
on PATH, as `agentwebctl agent start` asks it for a directory's account. It must run
detached from any `claude` process, since the CLI takes its nearest claude ancestor's
account as its own:

    go build -o /tmp/record-wire ./tools/fakeherdr/cmd/record-wire && setsid -f /tmp/record-wire

It writes `wire/DONE` (or `wire/FAILED`) when finished; two runs give identical files.

Comparing a Go run with these (P2/P3): only the requests an operation itself sends.
`agent.list`, `pane.process_info` and `session.snapshot` may also come from the
bridge's background work (completion seqs, the account cache, rebuilds), so a
comparison that differs only in those needs a look before it counts. The WS watch
recordings poll on a timer: compare the distinct requests, not their count.
