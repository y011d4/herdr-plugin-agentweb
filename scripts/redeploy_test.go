package scripts

// redeploy.sh against a throwaway origin and its linked clone: a fake herdr (actions, their
// logs, the linked path, and /healthz as a file) and a stub plugin-build.sh that writes
// bin/yoicks as "built <commit>", or fails in a commit with a BROKEN file.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const fakeHerdr = `#!/bin/sh
echo "$*" >>"$FAKE/calls"
case "$1 $2" in
"plugin list") printf '{"result":{"plugins":[{"plugin_id":"t.yoicks","plugin_root":"%s","source":{"kind":"local"}}]}}' "$ROOT" ;;
"plugin log") printf '{"result":{"logs":[{"log_id":"l%s","status":"succeeded"}]}}' "$(cat "$FAKE/n")" ;;
"plugin action")
	echo $(($(cat "$FAKE/n" 2>/dev/null || echo 0) + 1)) >"$FAKE/n"
	case $4 in
	*.stop) rm -f "$FAKE/healthz"; if [ -n "${ON_STOP:-}" ]; then sh -c "$ON_STOP"; fi ;;
	*.start)
		echo "start $(cat "$ROOT/bin/yoicks")" >>"$FAKE/calls"
		if [ -e "$FAKE/unhealthy" ]; then rm "$FAKE/unhealthy"; else echo '{"ok":true,"herdrConnected":true}' >"$FAKE/healthz"; fi ;;
	esac
	printf '{"result":{"log":{"log_id":"l%s","status":"running"}}}' "$(cat "$FAKE/n")" ;;
esac
`

const stubBuild = `#!/bin/sh
set -e
cd "$(dirname "$0")/.."
if [ -e BROKEN ]; then echo "build failed" >&2; exit 1; fi
mkdir -p bin web/dist/assets
printf 'built %s' "$(git rev-parse --short HEAD)" >bin/yoicks
chmod 755 bin/yoicks
echo 'const CACHE_VERSION = "herdr-yoicks-0123abcd";' >web/dist/sw.js
: >web/dist/assets/index-AbCd1234.js
`

func TestRedeploy(t *testing.T) {
	for _, tool := range []string{"git", "jq", "curl"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("needs %s", tool)
		}
	}
	script, err := os.ReadFile("redeploy.sh")
	if err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	sh := func(t *testing.T, dir string, extra []string, name string, args ...string) (string, error) {
		t.Helper()
		cmd := exec.Command(name, args...)
		cmd.Dir, cmd.Env = dir, append(env, extra...)
		out, err := cmd.CombinedOutput()
		return string(out), err
	}
	must := func(t *testing.T, dir string, name string, args ...string) string {
		t.Helper()
		out, err := sh(t, dir, nil, name, args...)
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, out)
		}
		return strings.TrimSpace(out)
	}
	write := func(t *testing.T, path, body string) {
		t.Helper()
		os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	read := func(path string) string { b, _ := os.ReadFile(path); return string(b) }

	// world: origin (bare), seed (pushes to it), prod (the linked clone, built and "running")
	type world struct{ seed, prod, fake string }
	setup := func(t *testing.T) world {
		root := t.TempDir()
		w := world{filepath.Join(root, "seed"), filepath.Join(root, "prod"), filepath.Join(root, "fake")}
		origin := filepath.Join(root, "origin.git")
		must(t, root, "git", "init", "-q", "--bare", "-b", "main", origin)
		must(t, root, "git", "clone", "-q", origin, w.seed)
		for path, body := range map[string]string{
			"herdr-plugin.toml":       "id = \"t.yoicks\"\nversion = \"1.0.0\"\n\n[[actions]]\nid = \"start\"\n",
			"scripts/redeploy.sh":     string(script),
			"scripts/plugin-build.sh": stubBuild,
			".gitignore":              "bin/\nweb/dist/\nweb/app.js\n", // tsc output by name, as before Vite
			"web/src/app.ts":          "",
		} {
			write(t, filepath.Join(w.seed, path), body)
		}
		must(t, w.seed, "git", "add", ".")
		must(t, w.seed, "git", "commit", "-qm", "init")
		must(t, w.seed, "git", "push", "-q", "origin", "HEAD:main")
		must(t, root, "git", "clone", "-q", origin, w.prod)
		must(t, w.prod, "sh", "scripts/plugin-build.sh")
		write(t, filepath.Join(w.fake, "herdr"), fakeHerdr)
		write(t, filepath.Join(w.fake, "healthz"), `{"ok":true,"herdrConnected":true}`) // the bridge is up
		return w
	}
	push := func(t *testing.T, w world, path, body string) string { // a new commit on origin/main
		write(t, filepath.Join(w.seed, path), body)
		must(t, w.seed, "git", "add", ".")
		must(t, w.seed, "git", "commit", "-qm", "change "+path)
		must(t, w.seed, "git", "push", "-q", "origin", "HEAD:main")
		return must(t, w.seed, "git", "rev-parse", "--short", "HEAD")
	}
	redeploy := func(t *testing.T, w world, ref string, extra ...string) (string, error) {
		os.Remove(filepath.Join(w.fake, "calls"))
		return sh(t, w.prod, append([]string{"FAKE=" + w.fake, "ROOT=" + w.prod,
			"REDEPLOY_HERDR=" + filepath.Join(w.fake, "herdr"), "REDEPLOY_HEALTHZ=file://" + filepath.Join(w.fake, "healthz"),
			"REDEPLOY_HEALTHZ_WAIT=2"}, extra...), "sh", "scripts/redeploy.sh", ref)
	}
	// refused checks a run that stops nothing: an error saying want, no action invoked
	refused := func(t *testing.T, w world, out string, err error, want string) {
		t.Helper()
		if err == nil || !strings.Contains(out, want) {
			t.Errorf("err %v, want a refusal with %q:\n%s", err, want, out)
		}
		if calls := read(filepath.Join(w.fake, "calls")); strings.Contains(calls, "action invoke") {
			t.Errorf("refused, but invoked an action:\n%s", calls)
		}
	}
	// restored checks a failure after the stop: non-zero, and the old binary running again
	restored := func(t *testing.T, w world, out string, err error, old string) {
		t.Helper()
		calls := read(filepath.Join(w.fake, "calls"))
		last := "" // the last binary started
		for _, line := range strings.Split(calls, "\n") {
			if strings.HasPrefix(line, "start ") {
				last = line
			}
		}
		if err == nil || last != "start "+old {
			t.Errorf("err %v, want a failure that starts %q last:\n%s\n%s", err, old, calls, out)
		}
		if got := read(filepath.Join(w.prod, "bin/yoicks")); got != old {
			t.Errorf("bin/yoicks = %q, want the old %q", got, old)
		}
		if _, err := os.Stat(filepath.Join(w.fake, "healthz")); err != nil {
			t.Error("the bridge is left down")
		}
	}

	t.Run("deploys main", func(t *testing.T) {
		w := setup(t)
		head := push(t, w, "README", "x")
		write(t, filepath.Join(w.prod, "web/app.js"), "") // ignored build output: removed
		out, err := redeploy(t, w, "main")
		if err != nil || !strings.Contains(out, "BUILD AbCd1234\nCACHE herdr-yoicks-0123abcd") {
			t.Fatalf("err %v, want BUILD and CACHE:\n%s", err, out)
		}
		if got := read(filepath.Join(w.prod, "bin/yoicks")); got != "built "+head {
			t.Errorf("bin/yoicks = %q, want built %s", got, head)
		}
		if _, err := os.Stat(filepath.Join(w.prod, "web/app.js")); err == nil {
			t.Error("the ignored web/app.js was left")
		}
		if calls := read(filepath.Join(w.fake, "calls")); !strings.Contains(calls, "t.yoicks.stop") || !strings.Contains(calls, "start built "+head) {
			t.Errorf("calls:\n%s", calls)
		}
	})
	t.Run("refuses another checkout", func(t *testing.T) {
		w := setup(t)
		out, err := redeploy(t, w, "main", "ROOT="+w.seed)
		refused(t, w, out, err, "not this checkout")
	})
	t.Run("refuses a manifest change", func(t *testing.T) {
		w := setup(t)
		push(t, w, "herdr-plugin.toml", "id = \"t.yoicks\"\nversion = \"2.0.0\"\n")
		out, err := redeploy(t, w, "main")
		refused(t, w, out, err, "herdr-plugin.toml differs")
	})
	t.Run("refuses a dirty tree", func(t *testing.T) {
		w := setup(t)
		push(t, w, ".gitignore", "bin/\nweb/dist/\n") // a commit since Vite: web/app.js isn't ignored
		must(t, w.prod, "git", "pull", "-q", "--ff-only")
		write(t, filepath.Join(w.prod, "web/app.js"), "mine") // beside web/src/app.ts, yet not build output
		out, err := redeploy(t, w, "main")
		refused(t, w, out, err, "?? web/app.js")
		if read(filepath.Join(w.prod, "web/app.js")) != "mine" {
			t.Error("web/app.js was deleted")
		}
	})
	t.Run("refuses an ignore file changed locally", func(t *testing.T) {
		for change, ignore := range map[string]struct{ path, body string }{
			"M .gitignore":      {".gitignore", "bin/\nweb/dist/\nweb/app.js\nweb/mine.js\n"},
			"?? web/.gitignore": {"web/.gitignore", "*.js\n"},
			"web/.gitignore":    {"web/.gitignore", "*\n"}, // ignores itself: git status shows nothing
		} {
			w := setup(t)
			write(t, filepath.Join(w.prod, ignore.path), ignore.body)
			write(t, filepath.Join(w.prod, "web/mine.js"), "mine") // ignored only by that change
			out, err := redeploy(t, w, "main")
			refused(t, w, out, err, change)
			if read(filepath.Join(w.prod, "web/mine.js")) != "mine" {
				t.Errorf("%s: web/mine.js was deleted", change)
			}
		}
	})
	t.Run("refuses a main that can't fast-forward, before the stop", func(t *testing.T) {
		w := setup(t)
		push(t, w, "README", "x")
		must(t, w.prod, "git", "commit", "-q", "--allow-empty", "-m", "local")
		out, err := redeploy(t, w, "main")
		refused(t, w, out, err, "can't fast-forward")
	})
	t.Run("restarts the old binary when the build fails", func(t *testing.T) {
		w := setup(t)
		old := read(filepath.Join(w.prod, "bin/yoicks"))
		push(t, w, "BROKEN", "")
		out, err := redeploy(t, w, "main")
		restored(t, w, out, err, old)
	})
	t.Run("restarts the old binary when main moves during the stop", func(t *testing.T) {
		w := setup(t)
		old := read(filepath.Join(w.prod, "bin/yoicks"))
		push(t, w, "README", "x")
		out, err := redeploy(t, w, "main", "ON_STOP=git -C '"+w.prod+"' commit -q --allow-empty -m race")
		restored(t, w, out, err, old)
	})
	t.Run("restores the old binary when the new one isn't healthy", func(t *testing.T) {
		w := setup(t)
		old := read(filepath.Join(w.prod, "bin/yoicks"))
		head := push(t, w, "README", "x")
		write(t, filepath.Join(w.fake, "unhealthy"), "") // the next start never gets healthy
		out, err := redeploy(t, w, "main")
		restored(t, w, out, err, old)
		if calls := read(filepath.Join(w.fake, "calls")); !strings.Contains(calls, "start built "+head) {
			t.Errorf("the new binary never started:\n%s", calls)
		}
	})
}
