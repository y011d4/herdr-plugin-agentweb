package main

import (
	"bytes"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/y011d4/herdr-yoicks/tools/fakeherdr"
)

// The commands herdr's actions and panes run (start, status, stop, run), on the Go
// binary with throwaway dirs and a free port: they work, neither their output (herdr
// keeps action output in its plugin logs) nor the bridge's (its pane, bridge.log:
// workers read them) ever carries the token, and a pidfile
// whose PID now belongs to another process never gets it signalled.
func TestGoLifecycleCommands(t *testing.T) {
	if testing.Short() {
		t.Skip("starts and stops real bridges")
	}
	t.Parallel()
	// a copy of its own: serving tells this test's bridges by their binary's path, and
	// TestGoMatchesWireRecordings runs a bridge of the shared one meanwhile
	bin := filepath.Join(t.TempDir(), "yoicks")
	if b, err := os.ReadFile(buildYoicks(t)); err != nil || os.WriteFile(bin, b, 0o755) != nil {
		t.Fatal("copying the binary:", err)
	}
	dir := t.TempDir()
	sockDir, err := os.MkdirTemp("", "fh") // unix socket paths must stay short
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(sockDir)
	fake, err := fakeherdr.Start(filepath.Join(sockDir, "h.sock"), fakeherdr.NewWorld().Handler())
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	for _, d := range []string{"home", "config", "data", "web"} {
		os.MkdirAll(filepath.Join(dir, d), 0o755)
	}
	os.WriteFile(filepath.Join(dir, "web", "index.html"), nil, 0o644) // a web UI, so the bridge starts
	// herdr's own state dir for the plugin (HOME is ours): the old plugin's bridge is
	// looked for only from there
	state, port := filepath.Join(dir, "home", ".local", "state", "herdr", "plugins", "y011d4.yoicks"), freePort(t)
	env := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + filepath.Join(dir, "home"),
		"HERDR_PLUGIN_STATE_DIR=" + state, "HERDR_PLUGIN_CONFIG_DIR=" + filepath.Join(dir, "config"),
		"XDG_DATA_HOME=" + filepath.Join(dir, "data"), "HERDR_YOICKS_PORT=" + port, "HERDR_SOCKET_PATH=" + fake.Path,
		"YOICKS_WEB_DIR=" + filepath.Join(dir, "web")}
	var printed []string // everything the action commands printed
	ctl := func(args ...string) (int, string) {
		t.Helper()
		cmd := exec.Command(bin, args...)
		cmd.Env = env
		out, err := cmd.CombinedOutput()
		code := 0
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else if err != nil {
			t.Fatal(err)
		}
		printed = append(printed, string(out))
		return code, string(out)
	}
	expect := func(args []string, wantCode int, wantOut string) {
		t.Helper()
		if code, out := ctl(args...); code != wantCode || !strings.Contains(out, wantOut) {
			t.Errorf("yoicks %v: exit %d, %q; want exit %d with %q", args, code, out, wantCode, wantOut)
		}
	}
	healthy := func() bool {
		res, err := http.Get("http://127.0.0.1:" + port + "/healthz")
		if err == nil {
			res.Body.Close()
		}
		return err == nil && res.StatusCode == 200
	}
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for end := time.Now().Add(5 * time.Second); !ok(); time.Sleep(20 * time.Millisecond) {
			if time.Now().After(end) {
				t.Fatalf("timed out waiting until %s", what)
			}
		}
	}
	t.Cleanup(func() {
		// with env, never the inherited one: without HERDR_PLUGIN_STATE_DIR this would
		// stop whatever bridge the real state dir names
		stop := exec.Command(bin, "stop")
		stop.Env = env
		stop.Run()
	})

	expect([]string{"status"}, 0, "bridge is not running")
	code, out := ctl("start")
	m := regexp.MustCompile(`bridge started \(pid (\d+)\)`).FindStringSubmatch(out)
	if code != 0 || m == nil {
		t.Fatalf("start: exit %d, %q", code, out)
	}
	pid := m[1]
	for _, want := range []string{"url: http://127.0.0.1:" + port + "/", "token file: " + filepath.Join(state, "token"), "log: " + filepath.Join(state, "bridge.log")} {
		if !strings.Contains(out, want) {
			t.Errorf("start printed %q, missing %q", out, want)
		}
	}
	waitFor("the bridge answers", healthy)
	tok, err := os.ReadFile(filepath.Join(state, "token"))
	token := strings.TrimSpace(string(tok))
	if err != nil || len(token) < 32 {
		t.Fatalf("token: %v", err)
	}
	// the token in query strings, as the phone's first load and its /ws carry it, right or wrong
	for _, p := range []string{"/?token=", "/ws?token=", "/api/state?token=", "/api/nope?token=", "/api/state?x=y&token=x"} {
		if res, err := http.Get("http://127.0.0.1:" + port + p + token); err == nil {
			res.Body.Close()
		}
	}
	expect([]string{"start"}, 0, "bridge already running (pid "+pid+")")
	expect([]string{"status"}, 0, "bridge running (pid "+pid+")")
	expect([]string{"run"}, 1, "bridge already running (pid "+pid+"); stop it first")
	expect([]string{"stop"}, 0, "bridge stopped (pid "+pid+")")
	if healthy() {
		t.Error("the bridge still answers after stop")
	}
	if _, err := os.Stat(filepath.Join(state, "bridge.pid")); err == nil {
		t.Error("stop left bridge.pid")
	}
	expect([]string{"stop"}, 0, "bridge is not running")

	// the token is only in its file: never in what the commands print, nor in the log
	for _, out := range printed {
		if strings.Contains(out, token) {
			t.Errorf("an action printed the token: %q", out)
		}
	}
	logPath := filepath.Join(state, "bridge.log")
	if st, err := os.Stat(logPath); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("bridge.log: %v %v, want mode 0600", st, err)
	}
	if b, _ := os.ReadFile(logPath); strings.Contains(string(b), token) || !strings.Contains(string(b), "connect: http://127.0.0.1:"+port+" (") {
		t.Errorf("bridge.log: %q, want its connect line, without the token", b)
	}
	// a log an older bridge wrote the token to: start takes it out, in the same file (a
	// `tail -f` of it goes on)
	f, _ := os.OpenFile(logPath, os.O_WRONLY|os.O_APPEND, 0)
	f.WriteString("connect: http://127.0.0.1:" + port + "?token=" + token + "\n")
	f.Close()
	before, _ := os.Stat(logPath)
	if code, out := ctl("start"); code != 0 {
		t.Fatalf("start over an old log: exit %d, %q", code, out)
	}
	waitFor("the bridge answers", healthy)
	if code, out := ctl("stop"); code != 0 {
		t.Fatalf("stop: exit %d, %q", code, out)
	}
	if b, _ := os.ReadFile(logPath); strings.Contains(string(b), token) || !strings.Contains(string(b), "?token="+strings.Repeat("*", len(token))+"\n") {
		t.Errorf("bridge.log after a start: %q, want the old line's token redacted", b)
	}
	if after, _ := os.Stat(logPath); before == nil || after == nil || !os.SameFile(before, after) {
		t.Error("start replaced bridge.log instead of redacting it in place")
	}

	// a pidfile whose PID was reused by an unrelated process
	other := exec.Command("sleep", "30")
	if err := other.Start(); err != nil {
		t.Fatal(err)
	}
	defer other.Process.Kill()
	os.WriteFile(filepath.Join(state, "bridge.pid"), []byte(strconv.Itoa(other.Process.Pid)), 0o600)
	expect([]string{"status"}, 0, "bridge is not running")
	if _, err := os.Stat(filepath.Join(state, "bridge.pid")); err == nil {
		t.Error("status kept a pidfile naming another process")
	}
	os.WriteFile(filepath.Join(state, "bridge.pid"), []byte(strconv.Itoa(other.Process.Pid)), 0o600)
	expect([]string{"stop"}, 0, "bridge is not running")
	if syscall.Kill(other.Process.Pid, 0) != nil {
		t.Error("stop signalled a process that isn't a bridge")
	}

	// run: the bridge in the foreground, in the same process
	fg := exec.Command(bin, "run")
	fg.Env = env
	var pane bytes.Buffer // what herdr's server pane shows
	fg.Stdout, fg.Stderr = &pane, &pane
	if err := fg.Start(); err != nil {
		t.Fatal(err)
	}
	// reaped at once, as herdr reaps its pane: stop waits for the pid to be gone
	exited := make(chan error, 1)
	go func() { exited <- fg.Wait() }()
	waitFor("run answers", healthy)
	runPid := strconv.Itoa(fg.Process.Pid)
	if b, _ := os.ReadFile(filepath.Join(state, "bridge-run.pid")); string(b) != runPid {
		t.Errorf("bridge-run.pid: %q, want run's own pid %s", b, runPid)
	}
	expect([]string{"status"}, 0, "bridge running (pid "+runPid+", foreground pane)")
	expect([]string{"stop"}, 0, "bridge stopped (pid "+runPid+")")
	select {
	case err := <-exited:
		if err != nil {
			t.Errorf("run after stop: %v, want exit 0", err)
		}
	case <-time.After(10 * time.Second):
		fg.Process.Kill()
		<-exited
		t.Fatal("run didn't exit after stop")
	}
	if _, err := os.Stat(filepath.Join(state, "bridge-run.pid")); err == nil {
		t.Error("run left bridge-run.pid")
	}
	if out := pane.String(); strings.Contains(out, token) || !strings.Contains(out, "connect: ") {
		t.Errorf("run printed %q, want its connect line, without the token", out)
	}

	// start refuses when it can't make the log, which gets the token, private: here a
	// log that is a symlink to /dev/null, whose mode we can't change (as root we could)
	if os.Geteuid() != 0 {
		os.Rename(logPath, logPath+".kept")
		os.Symlink("/dev/null", logPath)
		expect([]string{"start"}, 1, "operation not permitted")
		if healthy() {
			t.Error("start served although the log couldn't be made private")
		}
		os.Remove(logPath)
		os.Rename(logPath+".kept", logPath)
	}
	// a pidfile that can't be written: start stops what it launched, run doesn't serve
	for _, c := range []struct{ file, cmd string }{{"bridge.pid", "start"}, {"bridge-run.pid", "run"}} {
		os.Mkdir(filepath.Join(state, c.file), 0o700)
		expect([]string{c.cmd}, 1, "is a directory")
		// the launched child itself is gone, not just not serving yet (start waited for it)
		if pids := serving(t, bin); len(pids) > 0 {
			t.Errorf("a failed %s left %s serve running: %v", c.cmd, bin, pids)
		}
		if healthy() {
			t.Errorf("a failed %s left a bridge serving", c.cmd)
		}
		os.Remove(filepath.Join(state, c.file))
	}

	if runtime.GOOS != "linux" {
		return // a renamed binary is recognized through /proc only
	}
	// the same binary under another name is still known by its executable
	renamed := filepath.Join(dir, "awc")
	if b, err := os.ReadFile(bin); err != nil || os.WriteFile(renamed, b, 0o755) != nil {
		t.Fatal("copying the binary:", err)
	}
	bin = renamed
	code, out = ctl("start")
	if code != 0 {
		t.Fatalf("start (renamed): exit %d, %q", code, out)
	}
	pid = regexp.MustCompile(`pid (\d+)`).FindStringSubmatch(out)[1]
	t.Cleanup(func() { // if status or stop lost it: only this test's bridge
		if b, _ := os.ReadFile("/proc/" + pid + "/cmdline"); strings.HasPrefix(string(b), renamed+"\x00serve") {
			n, _ := strconv.Atoi(pid)
			syscall.Kill(n, syscall.SIGTERM)
		}
	})
	waitFor("the renamed bridge answers", healthy)
	expect([]string{"status"}, 0, "bridge running (pid "+pid+")")
	expect([]string{"stop"}, 0, "bridge stopped (pid "+pid+")")
}

// serving is the pids of `<bin> serve` processes, from ps (Linux and macOS alike).
func serving(t *testing.T, bin string) []string {
	t.Helper()
	out, err := exec.Command("ps", "-A", "-o", "pid=,args=").Output()
	if err != nil {
		t.Fatalf("listing processes: %v", err)
	}
	var pids []string
	for _, line := range strings.Split(string(out), "\n") {
		if pid, args, ok := strings.Cut(strings.TrimSpace(line), " "); ok && strings.TrimSpace(args) == bin+" serve" {
			pids = append(pids, pid)
		}
	}
	return pids
}
