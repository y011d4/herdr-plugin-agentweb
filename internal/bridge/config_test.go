package bridge

// A port of server/test/config.test.ts.

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestConfig(t *testing.T) {
	const home = "/home/u"
	const data = "/home/u/.local/share/herdr-yoicks"
	fromJSON := func(t *testing.T, s string) any {
		t.Helper()
		var v any
		if err := json.Unmarshal([]byte(s), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	eq := func(t *testing.T, got, want any) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %#v, want %#v", got, want)
		}
	}

	t.Run("parseOrchestrators", func(t *testing.T) {
		t.Run("manages each entry in <data>/orchestrators/<name>, with its env (~ expanded)", func(t *testing.T) {
			eq(t, parseOrchestrators(fromJSON(t, `[
				{"name": "personal", "label": "Personal"},
				{"name": "work", "label": " Work ", "env": {"CLAUDE_CONFIG_DIR": "~/.config/claude/work", "OTHER": "/x"}}
			]`), home, data), []OrchestratorDef{
				{Name: "personal", Label: "Personal", Dir: data + "/orchestrators/personal", Env: map[string]string{}},
				{Name: "work", Label: "Work", Dir: data + "/orchestrators/work", Env: map[string]string{"CLAUDE_CONFIG_DIR": "/home/u/.config/claude/work", "OTHER": "/x"}},
			})
		})

		t.Run("labels an entry by its name, and keeps only string env vars with plain names", func(t *testing.T) {
			eq(t, parseOrchestrators(fromJSON(t, `[{"name": "w", "env": {"BAD-NAME": "x", "N": 1, "OK": "y"}}]`), home, data),
				[]OrchestratorDef{{Name: "w", Label: "w", Dir: data + "/orchestrators/w", Env: map[string]string{"OK": "y"}}})
		})

		t.Run(`"mode": "headless" makes an entry headless; anything else is tui`, func(t *testing.T) {
			eq(t, parseOrchestrators(fromJSON(t, `[{"name": "h", "mode": "headless"}, {"name": "t", "mode": "Headless"}]`), home, data),
				[]OrchestratorDef{
					{Name: "h", Label: "h", Dir: data + "/orchestrators/h", Env: map[string]string{}, Mode: "headless"},
					{Name: "t", Label: "t", Dir: data + "/orchestrators/t", Env: map[string]string{}},
				})
		})

		t.Run("drops malformed entries and repeated names", func(t *testing.T) {
			out := parseOrchestrators(fromJSON(t, `[null, "x", {"label": "no name"}, {"name": "../up"}, {"name": "a b"}, {"name": "ok"}, {"name": "ok", "label": "again"}]`),
				home, data)
			got := [][2]string{}
			for _, o := range out {
				got = append(got, [2]string{o.Name, o.Label})
			}
			eq(t, got, [][2]string{{"ok", "ok"}})
		})

		t.Run("with nothing configured or left over, is one orchestrator named default", func(t *testing.T) {
			def := []OrchestratorDef{{Name: "default", Label: "", Dir: data + "/orchestrators/default", Env: map[string]string{}}}
			eq(t, parseOrchestrators(nil, home, data), def)
			eq(t, parseOrchestrators(fromJSON(t, `[{"name": "bad/name"}]`), home, data), def)
		})
	})
}

// Remote access is Tailscale's job: with nothing configured the bridge listens on
// loopback only (CLAUDE.md, security invariants).
func TestTheDefaultListenAddressIsLoopback(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", t.TempDir()) // no config.json
	t.Setenv("HERDR_YOICKS_HOST", "")
	t.Setenv("HERDR_YOICKS_PORT", "")
	if c := loadConfig(); c.Host != "127.0.0.1" || c.Port != 8390 {
		t.Errorf("default listen address %s:%d, want 127.0.0.1:8390", c.Host, c.Port)
	}
}

func TestDataDir(t *testing.T) {
	t.Setenv("XDG_DATA_HOME", "/xdg")
	if got, want := dataDir("/home/u"), "/xdg/herdr-yoicks"; got != want {
		t.Errorf("XDG_DATA_HOME: %s, want %s", got, want)
	}
	t.Setenv("XDG_DATA_HOME", "")
	if got, want := dataDir("/home/u"), "/home/u/.local/share/herdr-yoicks"; got != want {
		t.Errorf("no XDG_DATA_HOME: %s, want %s", got, want)
	}
}
