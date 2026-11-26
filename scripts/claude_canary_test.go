package scripts

// claude-canary.sh with a fake claude (its version from $FAKE_VERSION) and a fake go (the
// live test's verdict from $FAKE_RESULT, written to $CLAUDE_LIVE_OUT): when it checks, what
// it writes, and the timer it installs. No real Claude.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fakeClaude = `#!/bin/sh
echo "$FAKE_VERSION (Claude Code)"
`

const fakeGo = `#!/bin/sh
echo "$*" >>"$FAKE/goruns"
case $FAKE_RESULT in
ok) echo "{\"version\":\"$FAKE_VERSION\",\"ok\":true,\"failed\":[]}" >"$CLAUDE_LIVE_OUT" ;;
fail) echo "{\"version\":\"$FAKE_VERSION\",\"ok\":false,\"failed\":[\"resume\"]}" >"$CLAUDE_LIVE_OUT"; exit 1 ;;
noversion) echo "{\"version\":\"\",\"ok\":false,\"failed\":[\"start\"]}" >"$CLAUDE_LIVE_OUT"; exit 1 ;;
*) exit 2 ;;
esac
`

func TestClaudeCanary(t *testing.T) {
	script, err := os.ReadFile("claude-canary.sh")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	repo, bin, state, config := filepath.Join(dir, "my repo%1"), filepath.Join(dir, "bin"), filepath.Join(dir, "state"), filepath.Join(dir, "config")
	for path, body := range map[string]string{filepath.Join(repo, "scripts", "claude-canary.sh"): string(script),
		filepath.Join(bin, "claude"): fakeClaude, filepath.Join(bin, "go"): fakeGo, filepath.Join(bin, "systemctl"): "#!/bin/sh\necho systemctl >>\"$FAKE/goruns\"\n"} {
		os.MkdirAll(filepath.Dir(path), 0o755)
		if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	command := func(version, result string, args ...string) *exec.Cmd {
		cmd := exec.Command("sh", append([]string{filepath.Join(repo, "scripts", "claude-canary.sh")}, args...)...)
		cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "FAKE="+dir, "FAKE_VERSION="+version, "FAKE_RESULT="+result,
			"HERDR_PLUGIN_STATE_DIR="+state, "HERDR_PLUGIN_CONFIG_DIR="+config, "HOME="+dir, "XDG_CONFIG_HOME="+filepath.Join(dir, "xdg"))
		return cmd
	}
	run := func(t *testing.T, version, result string, args ...string) string {
		t.Helper()
		out, err := command(version, result, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	runs := func() int { b, _ := os.ReadFile(filepath.Join(dir, "goruns")); return strings.Count(string(b), "\n") }
	type check struct {
		At      int64    `json:"at"`
		Version string   `json:"version"`
		OK      bool     `json:"ok"`
		Failed  []string `json:"failed"`
	}
	saved := func(t *testing.T) check {
		t.Helper()
		path := filepath.Join(state, "canary.json")
		b, err := os.ReadFile(path)
		var c check
		if err != nil || json.Unmarshal(b, &c) != nil {
			t.Fatalf("canary.json: %v %s", err, b)
		}
		if st, _ := os.Stat(path); st.Mode().Perm() != 0o600 {
			t.Errorf("mode %v", st.Mode().Perm())
		}
		return c
	}
	saveAt := func(at time.Time, version string) {
		os.WriteFile(filepath.Join(state, "canary.json"), fmt.Appendf(nil, `{"at":%d,"version":"%s","ok":true,"failed":[]}`, at.UnixMilli(), version), 0o600)
	}

	// no check yet: it runs the live test, and writes its verdict with the time
	before := time.Now().Unix() * 1000 // (whole seconds)
	run(t, "2.1.322", "ok")
	if c := saved(t); runs() != 1 || !c.OK || c.Version != "2.1.322" || len(c.Failed) != 0 || c.At < before || c.At > time.Now().UnixMilli() {
		t.Fatalf("first check: %d runs, %+v", runs(), c)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "goruns")); string(b) != "test -tags claudelive -count=1 -timeout 15m -run TestClaudeLive ./internal/bridge\n" {
		t.Errorf("go %s", b)
	}
	// fresh and the same version: nothing
	if out := run(t, "2.1.322", "ok"); runs() != 1 || !strings.Contains(out, "less than 24 h ago") {
		t.Errorf("a fresh check ran again: %s", out)
	}
	// --force, a new version, a check 24 h old: each runs
	run(t, "2.1.322", "ok", "--force")
	run(t, "2.1.330", "ok")
	if c := saved(t); runs() != 3 || c.Version != "2.1.330" {
		t.Errorf("--force and a new version: %d runs, %+v", runs(), c)
	}
	saveAt(time.Now().Add(-24*time.Hour-time.Minute), "2.1.330")
	run(t, "2.1.330", "ok")
	saveAt(time.Now().Add(-23*time.Hour), "2.1.330")
	run(t, "2.1.330", "ok")
	if runs() != 4 {
		t.Errorf("24 h: %d runs", runs())
	}
	// a failed check: its items; a test that never wrote one: the run itself
	run(t, "2.1.330", "fail", "--force")
	if c := saved(t); c.OK || strings.Join(c.Failed, ",") != "resume" {
		t.Errorf("failed: %+v", c)
	}
	run(t, "2.1.330", "crash", "--force")
	if c := saved(t); c.OK || strings.Join(c.Failed, ",") != "run (go test exit 2)" || c.Version != "2.1.330" {
		t.Errorf("crashed: %+v", c)
	}
	// a verdict without a version (claude never started): this claude's, so the gate holds
	run(t, "2.1.330", "noversion", "--force")
	if c := saved(t); c.OK || c.Version != "2.1.330" || strings.Join(c.Failed, ",") != "start" {
		t.Errorf("no version: %+v", c)
	}
	// two runs at once (a --force beside the timer's) write through temp files of their own: an
	// mv held for a second makes them overlap
	mv, _ := exec.LookPath("mv")
	slow := filepath.Join(dir, "slow")
	os.MkdirAll(slow, 0o755)
	os.WriteFile(filepath.Join(slow, "mv"), []byte("#!/bin/sh\nsleep 1\nexec '"+mv+"' \"$@\"\n"), 0o755)
	var both [2]*exec.Cmd
	var outs [2]strings.Builder
	for i := range both {
		both[i] = command("2.1.330", "ok", "--force")
		both[i].Env = append(both[i].Env, "PATH="+slow+":"+bin+":"+os.Getenv("PATH"))
		both[i].Stdout, both[i].Stderr = &outs[i], &outs[i]
		if err := both[i].Start(); err != nil {
			t.Fatal(err)
		}
	}
	for i, cmd := range both {
		if err := cmd.Wait(); err != nil {
			t.Errorf("run %d at once: %v\n%s", i, err, outs[i].String())
		}
	}
	left, _ := filepath.Glob(filepath.Join(state, "canary.json.*"))
	if c := saved(t); !c.OK || len(left) != 0 {
		t.Errorf("after two at once: %+v, left %v", c, left)
	}
	// "canary": false: never, not even forced
	os.MkdirAll(config, 0o755)
	os.WriteFile(filepath.Join(config, "config.json"), []byte(`{"port": 8390, "canary" : false}`), 0o600)
	n := runs()
	if out := run(t, "2.1.340", "ok", "--force"); runs() != n || !strings.Contains(out, "off") {
		t.Errorf("canary false: %s", out)
	}
	// install: the hourly timer over this checkout (its path escaped for systemd: a space, a %),
	// the plugin's dirs as set now, printed, never enabled
	out := run(t, "2.1.340", "ok", "install")
	real, _ := filepath.EvalSymlinks(repo)
	escaped := strings.ReplaceAll(real, "%", "%%")
	service, _ := os.ReadFile(filepath.Join(dir, "xdg", "systemd", "user", "yoicks-claude-canary.service"))
	timer, _ := os.ReadFile(filepath.Join(dir, "xdg", "systemd", "user", "yoicks-claude-canary.timer"))
	for _, line := range []string{"\nWorkingDirectory=" + escaped + "\n", "\nExecStart=/bin/sh \"" + escaped + "/scripts/claude-canary.sh\"\n",
		"\nEnvironment=\"PATH=" + bin + ":" + bin + ":", "\nEnvironment=\"HERDR_PLUGIN_STATE_DIR=" + state + "\"\n",
		"\nEnvironment=\"HERDR_PLUGIN_CONFIG_DIR=" + config + "\"\n"} {
		if !strings.Contains(string(service), line) {
			t.Errorf("no %q in\n%s", line, service)
		}
	}
	if !strings.Contains(string(timer), "OnCalendar=hourly") || !strings.Contains(string(timer), "Persistent=true") {
		t.Errorf("timer:\n%s", timer)
	}
	if !strings.Contains(out, "systemctl --user daemon-reload && systemctl --user enable --now yoicks-claude-canary.timer") || runs() != n {
		t.Errorf("install: %s (%d runs)", out, runs())
	}
}
