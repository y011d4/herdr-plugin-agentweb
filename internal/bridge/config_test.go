package bridge

// A port of server/test/config.test.ts.

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestConfig(t *testing.T) {
	const home = "/home/u"
	const data = "/home/u/.local/share/herdr-agentweb"
	none := func(string) bool { return false }
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
			]`), nil, home, data, none), []OrchestratorDef{
				{Name: "personal", Label: "Personal", Dir: data + "/orchestrators/personal", Env: map[string]string{}, Managed: true},
				{Name: "work", Label: "Work", Dir: data + "/orchestrators/work", Env: map[string]string{"CLAUDE_CONFIG_DIR": "/home/u/.config/claude/work", "OTHER": "/x"}, Managed: true},
			})
		})

		t.Run("keeps an entry in the earlier format (with its own dir) as that unmanaged dir", func(t *testing.T) {
			eq(t, parseOrchestrators(fromJSON(t, `[{"name": "work", "label": "WORK", "dir": "~/orch-work/"}]`), nil, home, data, none),
				[]OrchestratorDef{{Name: "work", Label: "WORK", Dir: "/home/u/orch-work", Env: map[string]string{}, Managed: false}})
		})

		t.Run("labels an entry by its name, and keeps only string env vars with plain names", func(t *testing.T) {
			eq(t, parseOrchestrators(fromJSON(t, `[{"name": "w", "env": {"BAD-NAME": "x", "N": 1, "OK": "y"}}]`), nil, home, data, none),
				[]OrchestratorDef{{Name: "w", Label: "w", Dir: data + "/orchestrators/w", Env: map[string]string{"OK": "y"}, Managed: true}})
		})

		t.Run("drops malformed entries and repeated names", func(t *testing.T) {
			out := parseOrchestrators(fromJSON(t, `[null, "x", {"label": "no name"}, {"name": "../up"}, {"name": "a b"}, {"name": "ok"}, {"name": "ok", "label": "again"}]`),
				nil, home, data, none)
			got := [][2]string{}
			for _, o := range out {
				got = append(got, [2]string{o.Name, o.Label})
			}
			eq(t, got, [][2]string{{"ok", "ok"}})
		})

		t.Run("without orchestrators keeps the older setup: orchestrator_dir, else the old default dir if present, unmanaged", func(t *testing.T) {
			legacy := func(dir string) []OrchestratorDef {
				return []OrchestratorDef{{Name: "default", Label: "", Dir: dir, Env: map[string]string{}, Managed: false}}
			}
			eq(t, parseOrchestrators(nil, "~/orch/", home, data, none), legacy("/home/u/orch"))
			eq(t, parseOrchestrators([]any{}, nil, home, data, func(p string) bool { return p == data+"/dispatcher" }), legacy(data+"/dispatcher"))
			// a valid list wins over both
			eq(t, parseOrchestrators(fromJSON(t, `[{"name": "a"}]`), "/legacy", home, data, func(string) bool { return true })[0].Dir, data+"/orchestrators/a")
		})

		t.Run("with nothing configured or left over, is one managed orchestrator named default", func(t *testing.T) {
			eq(t, parseOrchestrators(fromJSON(t, `[{"name": "bad/name"}]`), " ", home, data, none),
				[]OrchestratorDef{{Name: "default", Label: "", Dir: data + "/orchestrators/default", Env: map[string]string{}, Managed: true}})
		})
	})
}

// Remote access is Tailscale's job: with nothing configured the bridge listens on
// loopback only (CLAUDE.md, security invariants).
func TestTheDefaultListenAddressIsLoopback(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_CONFIG_DIR", t.TempDir()) // no config.json
	t.Setenv("HERDR_AGENTWEB_HOST", "")
	t.Setenv("HERDR_AGENTWEB_PORT", "")
	if c := loadConfig(); c.Host != "127.0.0.1" || c.Port != 8390 {
		t.Errorf("default listen address %s:%d, want 127.0.0.1:8390", c.Host, c.Port)
	}
}
