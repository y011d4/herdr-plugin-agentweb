# Development and releasing


For local development, clone and **link** a working tree instead of installing from
GitHub — `herdr plugin link` points herdr at your checkout so your edits take effect:

Building from source needs Go (the version in `go.mod`) and Node.js 26.x with `npm`
(`engines` in `package.json`, which CI uses too; the web UI's Vite build and Vitest tests).

```bash
git clone https://github.com/y011d4/herdr-yoicks
cd herdr-yoicks
sh scripts/plugin-build.sh          # web UI, then bin/yoicks (Go), from this checkout
herdr plugin link "$(pwd)"
```

The bridge and CLI are Go (`cmd/yoicks`, `internal/bridge`). The PWA is TypeScript and React
under `web/src/` (`main.tsx` starts the shell, `ui/App.tsx`), built by Vite to `web/dist` and
embedded in the binary.

```bash
sh scripts/plugin-build.sh          # rebuild after changes, web ones too (the binary embeds the web UI)
go test ./...                       # Go tests
npm test                            # web UI tests (Vitest)
./bin/yoicks run                    # run against your live herdr in the foreground (config: see Configuration)
YOICKS_DEV_BRIDGE=http://127.0.0.1:8390 npm run dev   # the web UI from source on :5174 (hot reload),
                                    # /api and /ws proxied to a running bridge; open ?token=<its token>
```

herdr never runs build commands for a linked plugin (not on `herdr plugin link`, nor on
`herdr plugin update`, which skips linked plugins) — rebuild with `sh scripts/plugin-build.sh`
after edits (and re-run `herdr plugin link` only when `herdr-plugin.toml` changed). It always
builds the checkout as it is; `sh scripts/plugin-build.sh release` instead downloads the release
binary of the version in `herdr-plugin.toml`, as an install does.

To deploy a linked checkout's new commits to its running bridge, or to roll it back, run this in
that checkout:

```bash
sh scripts/redeploy.sh main         # fast-forward main to origin/main, rebuild, restart
sh scripts/redeploy.sh <commit>     # the same for an earlier commit (detached)
```

It waits for the stop and start actions and for `/healthz`, and prints the `BUILD` and `CACHE`
that Settings → App version should then show. It refuses before stopping anything on a dirty
tree, when `herdr-plugin.toml` would change (herdr caches a linked manifest: it prints the
steps by hand, `herdr plugin link` included), or, for `main`, until the CI run (GitHub Actions,
through `gh`) of the commit it deploys has passed: it waits for one still going. After any later
failure it starts the old binary again.

Logs for the detached daemon go to `<state dir>/bridge.log`
(`~/.local/state/herdr/plugins/y011d4.yoicks`, or `$HERDR_PLUGIN_STATE_DIR` inside plugin
commands).

## Releasing {#releasing}


Maintainers, from a clean checkout of the commit to release:

```bash
scripts/release.sh 0.2.0    # builds dist/release/* in a temporary worktree with the pinned Go
                            # toolchain; writes release/checksums.txt and the manifest version
git add herdr-plugin.toml release/checksums.txt && git commit -m "release v0.2.0" && git tag v0.2.0
git push origin main v0.2.0
gh release create v0.2.0 dist/release/* --title v0.2.0 --notes "…"
```

The binaries are uploaded as built, uncompressed: their checksums are the ones committed with the
tag, which `scripts/plugin-build.sh` checks on install. Name the verified herdr and Claude Code
versions in the release notes.
