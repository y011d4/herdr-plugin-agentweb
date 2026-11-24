package bridge

// The CLI (cli.go) beyond what the wire recordings compare with the TypeScript
// (tools/fakeherdr/cmd/record-wire): its own choices, D2 and the X7 bridge check.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/y011d4/herdr-plugin-agentweb/tools/fakeherdr"
)

// Only a bridge gets a SIGTERM through a pidfile: agentwebctl serve|run wherever it is
// installed, or (until P5 step 6) the TypeScript bridge; never another agentwebctl
// command, such as an orchestrator's background `agent wait`.
func TestIsBridgeArgv(t *testing.T) {
	for argv, want := range map[string]bool{
		"./bin/agentwebctl serve":                                      true,
		"/home/u/.config/herdr/plugins/x/checkout/bin/agentwebctl run": true,
		"agentwebctl serve --extra":                                    true,
		"/usr/bin/node /home/u/repo/dist/server/main.js":               true,
		"node server/main.ts":                                          true,
		"/x/agentwebctl agent wait p1 --status done":                   false,
		"/x/agentwebctl overview":                                      false,
		"/x/agentwebctl-old serve":                                     false,
		"sleep 600":                                                    false,
		"node /x/server/other.js":                                      false,
		"/x/main.js serve":                                             false,
		"":                                                             false,
	} {
		if got := isBridgeArgv(strings.Fields(argv)); got != want {
			t.Errorf("isBridgeArgv(%q) = %v, want %v", argv, got, want)
		}
	}
}

// Outside herdr the state dir is herdr's own for the plugin (D2), unless only the TS
// default (~/.local/state/herdr-agentweb) holds a token: a paired phone keeps working.
func TestDefaultStateDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_STATE_HOME", "")
	herdrDir := filepath.Join(home, ".local", "state", "herdr", "plugins", "y011d4.agentweb")
	legacy := filepath.Join(home, ".local", "state", "herdr-agentweb")
	token := func(dir string) {
		os.MkdirAll(dir, 0o700)
		os.WriteFile(filepath.Join(dir, "token"), []byte("0123456789abcdef0123456789abcdef"), 0o600)
	}
	if got := defaultStateDir(); got != herdrDir {
		t.Errorf("no token anywhere: %s, want herdr's %s", got, herdrDir)
	}
	token(legacy)
	if got := defaultStateDir(); got != legacy {
		t.Errorf("a token only in the TS default: %s, want %s", got, legacy)
	}
	token(herdrDir)
	if got := defaultStateDir(); got != herdrDir {
		t.Errorf("tokens in both: %s, want herdr's %s", got, herdrDir)
	}
	xdg := t.TempDir()
	t.Setenv("XDG_STATE_HOME", xdg)
	if got, want := defaultStateDir(), filepath.Join(xdg, "herdr", "plugins", "y011d4.agentweb"); got != legacy {
		// herdr's dir under XDG_STATE_HOME has no token yet, so the TS one still wins
		t.Errorf("XDG_STATE_HOME without a token there: %s, want %s (not %s)", got, legacy, want)
	}
	os.RemoveAll(legacy)
	if got, want := defaultStateDir(), filepath.Join(xdg, "herdr", "plugins", "y011d4.agentweb"); got != want {
		t.Errorf("XDG_STATE_HOME: %s, want %s", got, want)
	}
}

// The CLI's herdr errors read like bin/agentwebctl.ts's: they reach the orchestrator.
func TestCliRPCErrors(t *testing.T) {
	dir, _ := os.MkdirTemp("", "fh")
	defer os.RemoveAll(dir)
	srv, err := fakeherdr.Start(filepath.Join(dir, "h.sock"), func(method string, _ json.RawMessage) fakeherdr.Reply {
		switch method {
		case "pane.read":
			return fakeherdr.Reply{Close: true}
		case "agent.wait":
			return fakeherdr.Reply{Hang: true}
		case "agent.get":
			return fakeherdr.Reply{Code: "not_found"}
		}
		return fakeherdr.Reply{Result: map[string]any{"ok": true}}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	t.Setenv("HERDR_SOCKET_PATH", srv.Path)
	for method, want := range map[string]string{
		"pane.read":  "pane.read: connection closed",
		"agent.wait": "agent.wait: timeout",
		"agent.get":  "agent.get failed",
	} {
		if _, err := cliRPC(method, nil, 300*time.Millisecond); err == nil || err.Error() != want {
			t.Errorf("%s: %v, want %q", method, err, want)
		}
	}
	if _, err := cliRPC("agent.get", nil, time.Second); herdrCode(err) != "not_found" {
		t.Errorf("herdr's code is lost: %v", err)
	}
	if res, err := cliRPC("agent.list", nil, time.Second); err != nil || string(res) != `{"ok":true}` {
		t.Errorf("agent.list: %s %v", res, err)
	}
	if got := srv.Requests(); len(got) == 0 || string(got[0].Params) != "{}" {
		t.Errorf("params sent: %+v, want {}", got)
	}
}

// The port as `Number(env || config.port || 8390)` reads it.
func TestCLIPort(t *testing.T) {
	t.Setenv("HERDR_AGENTWEB_PORT", "")
	for cfg, want := range map[string]string{`{}`: "8390", `{"port":8391}`: "8391", `{"port":"8392"}`: "8392", `{"port":0}`: "8390", `{"port":"x"}`: "NaN"} {
		var m map[string]any
		json.Unmarshal([]byte(cfg), &m)
		if got := port(m); got != want {
			t.Errorf("config %s: %s, want %s", cfg, got, want)
		}
	}
	t.Setenv("HERDR_AGENTWEB_PORT", " 8393 ")
	if got := port(map[string]any{"port": 8391.0}); got != "8393" {
		t.Errorf("the environment wins: %s", got)
	}
}
