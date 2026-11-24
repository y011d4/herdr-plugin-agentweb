#!/usr/bin/env bash
# P4a of docs/go-migration-plan.md: the Go bridge on 127.0.0.1:8391 beside the
# production Node bridge (:8390), compared by shadowdiff (main.go).
#
#   tools/shadowdiff/shadow.sh start DIR    build into DIR, start the Go bridge and the watch
#   tools/shadowdiff/shadow.sh report DIR   what the comparison has found so far
#   tools/shadowdiff/shadow.sh stop DIR     stop both; DIR stays, with its findings
#
# The Go side keeps everything in DIR: a copy of the Node bridge's config (without
# notify_url, so no ntfy, and public_url; each orchestrator pinned to its current
# dir, which makes it unmanaged, so nothing is written there), its state (token,
# pidfile, bridge.log, pane-profiles.json) and its XDG_DATA_HOME. Every Go command
# here gets these explicitly: the Go CLI on the real state dir stops the Node
# bridge or drops its pidfile, and serve on the real data dir rewrites the
# orchestrators' allowlists (docs/go-migration/p3-report.md). HERDR_BIN_PATH is
# dropped, so the Go CLI posts no herdr notifications. The Node bridge is only
# read: its config, its token, GET /api/state and /ws.
set -euo pipefail

usage() {
	echo "usage: $0 start|report|stop DIR" >&2
	exit 2
}
[ $# -eq 2 ] || usage
cmd=$1
dir=$(realpath -m -- "$2")
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd)
node_config=${NODE_CONFIG:-$HOME/.config/herdr/plugins/config/y011d4.agentweb/config.json}
node_token=${NODE_TOKEN:-$HOME/.local/state/herdr/plugins/y011d4.agentweb/token}
node_data=$HOME/.local/share/herdr-agentweb # the Node bridge runs without XDG_DATA_HOME

go_env() {
	env -u HERDR_BIN_PATH \
		HERDR_PLUGIN_CONFIG_DIR="$dir/config" HERDR_PLUGIN_STATE_DIR="$dir/state" XDG_DATA_HOME="$dir/data" \
		HERDR_AGENTWEB_HOST=127.0.0.1 HERDR_AGENTWEB_PORT=8391 "$@"
}

watch_pid() { # the running watch's pid, if any
	local pid
	pid=$(cat "$dir/watch.pid" 2>/dev/null) && grep -qa shadowdiff "/proc/$pid/cmdline" 2>/dev/null && echo "$pid"
}

case $cmd in
start)
	if pid=$(watch_pid); then
		echo "already watching (pid $pid)" >&2
		exit 1
	fi
	test -r "$node_token"
	mkdir -p "$dir"/{bin,config,state,data}
	chmod 700 "$dir" "$dir/state"
	(cd "$repo" && npm run --silent build:web &&
		go build -o "$dir/bin/agentwebctl" ./cmd/agentwebctl && go build -o "$dir/bin/shadowdiff" ./tools/shadowdiff)
	jq --arg data "$node_data" '
		if (.orchestrators | type) != "array" then error("no orchestrators list: the Go bridge would manage its own") else . end
		| del(.notify_url, .public_url) | .port = 8391
		| .orchestrators |= map(.dir //= "\($data)/orchestrators/\(.name)")' "$node_config" >"$dir/config/config.json"
	go_env "$dir/bin/agentwebctl" start
	setsid -f "$dir/bin/shadowdiff" watch -dir "$dir" -node-token "$node_token" -go-token "$dir/state/token" \
		>>"$dir/watch.log" 2>&1 </dev/null
	echo "report: $dir/bin/shadowdiff report -dir $dir"
	;;
report)
	exec "$dir/bin/shadowdiff" report -dir "$dir"
	;;
stop)
	if pid=$(watch_pid); then
		kill "$pid"
		echo "watch stopped (pid $pid)"
	fi
	rm -f "$dir/watch.pid"
	go_env "$dir/bin/agentwebctl" stop
	;;
*)
	usage
	;;
esac
