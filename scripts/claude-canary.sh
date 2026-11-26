#!/bin/sh
# The periodic check of Claude Code's headless mode: runs the claudelive test (the real
# claude, haiku, a throwaway dir, the personal account) and writes the result to
# <state>/canary.json ({at, version, ok, failed}), which the bridge shows and alerts on.
#
#   sh scripts/claude-canary.sh            check, when Claude Code's version changed since the
#                                          last check or that one is 24 h old
#   sh scripts/claude-canary.sh --force    check now
#   sh scripts/claude-canary.sh install    write the hourly systemd user timer (and print how
#                                          to enable it; this never enables it)
#
# Run it from the linked checkout. config.json's "canary": false turns it off. Each check costs
# a short haiku session (about one a day, and one per Claude Code update).
set -eu

cd "$(dirname "$0")/.."
root=$(pwd -P)
plugin=y011d4.yoicks
state=${HERDR_PLUGIN_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/herdr/plugins/$plugin}
config=${HERDR_PLUGIN_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr/plugins/config/$plugin}

if [ "${1:-}" = install ]; then
	units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
	gobin=$(command -v go) || { echo "go isn't on PATH" >&2; exit 1; }
	claudebin=$(command -v claude) || { echo "claude isn't on PATH" >&2; exit 1; }
	# systemd: % starts a specifier everywhere; a double-quoted word escapes \ and "; ExecStart
	# also expands $ (WorkingDirectory takes the path as it is, unquoted)
	word() { printf '"%s"' "$(printf '%s' "$1" | sed 's/[\\"]/\\&/g; s/%/%%/g')"; }
	env="Environment=$(word "PATH=$(dirname "$gobin"):$(dirname "$claudebin"):/usr/local/bin:/usr/bin:/bin")"
	if [ -n "${HERDR_PLUGIN_STATE_DIR:-}" ]; then
		env="$env
Environment=$(word "HERDR_PLUGIN_STATE_DIR=$HERDR_PLUGIN_STATE_DIR")"
	fi
	if [ -n "${HERDR_PLUGIN_CONFIG_DIR:-}" ]; then
		env="$env
Environment=$(word "HERDR_PLUGIN_CONFIG_DIR=$HERDR_PLUGIN_CONFIG_DIR")"
	fi
	workdir=$(printf '%s' "$root" | sed 's/%/%%/g')
	script=$(word "$(printf '%s' "$root" | sed 's/\$/$$/g')/scripts/claude-canary.sh")
	mkdir -p "$units"
	cat >"$units/yoicks-claude-canary.service" <<EOF
[Unit]
Description=yoicks: check Claude Code's headless mode (scripts/claude-canary.sh)

[Service]
Type=oneshot
WorkingDirectory=$workdir
$env
ExecStart=/bin/sh $script
EOF
	cat >"$units/yoicks-claude-canary.timer" <<EOF
[Unit]
Description=yoicks: Claude Code check, hourly (it runs only for a new version or after 24 h)

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
EOF
	echo "wrote $units/yoicks-claude-canary.service and .timer; to enable them:"
	echo "systemctl --user daemon-reload && systemctl --user enable --now yoicks-claude-canary.timer"
	exit 0
fi

if grep -q '"canary"[[:space:]]*:[[:space:]]*false' "$config/config.json" 2>/dev/null; then
	echo "claude check: off (\"canary\": false in $config/config.json)"
	exit 0
fi

version=$(claude --version | cut -d' ' -f1)
now=$(date +%s)000
last=$(cat "$state/canary.json" 2>/dev/null || true)
last_at=$(printf '%s' "$last" | sed -n 's/.*"at":\([0-9]*\).*/\1/p')
last_version=$(printf '%s' "$last" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
if [ "${1:-}" != --force ] && [ "$version" = "$last_version" ] && [ -n "$last_at" ] && [ $((now - last_at)) -lt 86400000 ]; then
	echo "claude check: $version checked less than 24 h ago"
	exit 0
fi

out=$(mktemp)
tmp=
trap 'rm -f "$out" ${tmp:+"$tmp"}' EXIT
if CLAUDE_LIVE_OUT=$out go test -tags claudelive -count=1 -timeout 15m -run TestClaudeLive ./internal/bridge; then ran=0; else ran=$?; fi
result=$(cat "$out" 2>/dev/null || true)
case $ran:$result in
0:'{'* | *:'{'*'"ok":false'*) ;; # the test's own verdict
*) result="{\"version\":\"$version\",\"ok\":false,\"failed\":[\"run (go test exit $ran)\"]}" ;;
esac
# a verdict without a version (claude never started) is this claude's: the next hourly run then
# waits for a new version or 24 h like any other
result=$(printf '%s' "$result" | sed "s/\"version\":\"\"/\"version\":\"$version\"/")
umask 077
mkdir -p "$state"
tmp=$(mktemp "$state/canary.json.XXXXXX") # its own: another run (a --force beside the timer's) has another
printf '{"at":%s,%s\n' "$now" "${result#"{"}" >"$tmp"
mv "$tmp" "$state/canary.json"
tmp=
echo "claude check: $(cat "$state/canary.json")"
