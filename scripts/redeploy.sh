#!/bin/sh
# Deploys or rolls back the running bridge: the binary of the checkout herdr links.
#
#   sh scripts/redeploy.sh main    fast-forward main to origin/main, rebuild, restart
#   sh scripts/redeploy.sh <ref>   switch to <ref> (detached), rebuild, restart: a rollback
#
# Run it in the linked checkout (it refuses anywhere else). It refuses before touching
# the bridge when the tree isn't clean, when herdr-plugin.toml would change (herdr
# caches the linked manifest: that switch is manual, the steps are printed), or when
# local main has commits origin/main lacks. Any failure after the stop restores and
# starts the old binary, then exits non-zero: the bridge is never left down.
#
# A commit from before this script existed: run main's copy,
#   t=$(mktemp) && git show main:scripts/redeploy.sh > "$t" && sh "$t" main
#
# REDEPLOY_HERDR (the herdr command), REDEPLOY_HEALTHZ (the bridge's /healthz URL,
# default http://127.0.0.1:8390/healthz) and REDEPLOY_HEALTHZ_WAIT (seconds, default 60)
# exist for testing (scripts/redeploy_test.go) and a non-default port.
set -eu

# Run from a copy: git switch must not rewrite the running script.
if [ -z "${REDEPLOY_COPY:-}" ]; then
	if [ -f "$(dirname "$0")/../herdr-plugin.toml" ]; then cd "$(dirname "$0")/.."; fi
	copy=$(mktemp)
	cp "$0" "$copy"
	REDEPLOY_COPY=$copy exec sh "$copy" "$@"
fi

herdr=${REDEPLOY_HERDR:-herdr}
healthz=${REDEPLOY_HEALTHZ:-http://127.0.0.1:8390/healthz}
healthz_wait=${REDEPLOY_HEALTHZ_WAIT:-60}
say() { echo "redeploy: $*" >&2; }
die() {
	say "$*"
	exit 1
}

stopped= # set once the stop is invoked: from then on, a failure restarts the old binary
backup=  # the old bin/yoicks, kept until the new one is healthy
on_exit() {
	code=$?
	rm -f "$REDEPLOY_COPY"
	trap - EXIT
	if [ -n "$stopped" ]; then
		say "failed after stopping the bridge: starting the old binary again"
		# the new binary may be up but unhealthy: stop it before putting the old one back
		action stop || true
		if [ -n "$backup" ] && [ -f "$backup" ]; then mv -f "$backup" bin/yoicks; fi
		if action start && healthy; then
			say "the old binary is running again (healthz ok); the checkout is at $(git rev-parse --short HEAD)"
		else
			say "the old binary did not come back: check $healthz and herdr plugin log list --plugin $id"
		fi
		exit 1
	fi
	[ -z "$backup" ] || rm -f "$backup"
	exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

[ $# -eq 1 ] || die "usage: sh scripts/redeploy.sh <main|commit>"
ref=$1
for tool in git jq curl "$herdr"; do
	command -v "$tool" >/dev/null 2>&1 || die "needs $tool"
done
root=$(git rev-parse --show-toplevel 2>/dev/null) || die "run it in the plugin's checkout"
cd "$root"
id=$(awk -F'"' '/^\[/ { exit } /^id = / { print $2 }' herdr-plugin.toml) # the top-level id
[ -n "$id" ] || die "no plugin id in herdr-plugin.toml"

# Only the checkout herdr links: a worktree or another clone has no bridge to redeploy.
linked=$("$herdr" plugin list --json --plugin "$id" |
	jq -r --arg id "$id" '.result.plugins[]? | select(.plugin_id == $id and .source.kind == "local") | .plugin_root') || linked=
if [ -z "$linked" ] || [ "$(cd "$linked" 2>/dev/null && pwd -P)" != "$(pwd -P)" ]; then
	die "herdr links $id to ${linked:-no local checkout}, not this checkout ($(pwd -P)): run it there"
fi
[ -x bin/yoicks ] || die "no bin/yoicks to fall back to: build it first (sh scripts/plugin-build.sh)"

# A clean tree first: nothing uncommitted may end up in the build. git status leaves out
# ignored files, so build output passes, but a changed or new .gitignore doesn't (nor one
# that ignores itself, listed separately): the cleanup below goes by the .gitignore files,
# and one of those could make it take someone's file for build output.
changes=$(git status --porcelain && git ls-files --others -- ':(glob)**/.gitignore')
[ -z "$changes" ] || die "the checkout has uncommitted or untracked files (a .gitignore too): commit or remove them first
$changes"
# Then the build output goes: what the .gitignore files ignore among web/*.js (tsc's
# output, before Vite) and web/dist (since); not a personal ignore (core.excludesFile,
# .git/info/exclude).
git ls-files -z --others --ignored --exclude-per-directory=.gitignore --directory -- ':(glob)web/*.js' web/dist |
	xargs -0 rm -rf --

if [ "$ref" = main ]; then
	git fetch -q origin
	target=$(git rev-parse --verify --quiet 'origin/main^{commit}') || die "no origin/main"
	if git show-ref --verify --quiet refs/heads/main && ! git merge-base --is-ancestor refs/heads/main origin/main; then
		die "local main has commits origin/main lacks: it can't fast-forward"
	fi
	switch="git switch main && git merge --ff-only origin/main"
else
	target=$(git rev-parse --verify --quiet "$ref^{commit}") || die "can't resolve $ref (git fetch first?)"
	switch="git switch --detach $target"
fi

if ! git diff --quiet HEAD "$target" -- herdr-plugin.toml; then
	die "herdr-plugin.toml differs between HEAD and $ref. herdr caches the linked manifest, so this
switch is by hand, in this order:
  herdr plugin action invoke $id.stop      # wait until it has finished
  $switch
  sh scripts/plugin-build.sh source
  herdr plugin link .
  herdr plugin action invoke <the new id>.start
  curl -s $healthz                         # expect {\"ok\":true,\"herdrConnected\":true}
When the plugin id changes, so do its state dir and token
(~/.local/state/herdr/plugins/<id>): log the phone in again from bin/yoicks qr (the connect pane)."
fi

# action <stop|start> invokes it and waits (≤120s) for its log to finish; true if it succeeded.
action() {
	log=$("$herdr" plugin action invoke "$id.$1" | jq -r '[.. | objects | .log_id? | strings][0] // empty') || return 1
	[ -n "$log" ] || return 1
	i=0
	while [ $i -lt 120 ]; do
		status=$("$herdr" plugin log list --plugin "$id" |
			jq -r --arg l "$log" '.result.logs[]? | select(.log_id == $l) | .status') || status=
		case $status in
		running | "") ;;
		succeeded) return 0 ;;
		*)
			say "$id.$1 ended $status"
			return 1
			;;
		esac
		sleep 1
		i=$((i + 1))
	done
	say "$id.$1 still running after 120s"
	return 1
}

# healthy polls /healthz (≤REDEPLOY_HEALTHZ_WAIT, 60s) until the bridge is up and connected to herdr.
healthy() {
	i=0
	while [ $i -lt "$healthz_wait" ]; do
		if curl -fsS --max-time 2 "$healthz" 2>/dev/null | jq -e '.ok == true and .herdrConnected == true' >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
		i=$((i + 1))
	done
	return 1
}

backup=$(mktemp bin/.yoicks.old.XXXXXX)
cp -p bin/yoicks "$backup"
stopped=1
say "stopping $id"
action stop
say "switching to $ref ($(git rev-parse --short "$target"))"
sh -c "$switch"
npm_config_prefer_offline=true sh scripts/plugin-build.sh source
say "starting $id"
action start
healthy || die "$healthz not ok within ${healthz_wait}s"
stopped=

if [ -f web/dist/sw.js ]; then
	build=$(basename web/dist/assets/index-*.js .js)
	build=${build#index-}
	cache=$(sed -n 's/^const CACHE_VERSION = "\([^"]*\)";$/\1/p' web/dist/sw.js)
else # before the Vite build: hand-bumped constants
	build=$(sed -n "s/^const BUILD = '\([^']*\)';$/\1/p" web/src/app.ts)
	cache=$(sed -n "s/^const CACHE_VERSION = '\([^']*\)';$/\1/p" web/src/sw.ts)
fi
say "running $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
echo "BUILD $build"
echo "CACHE $cache"
