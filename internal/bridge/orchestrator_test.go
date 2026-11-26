package bridge

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func testOrchestratorDef(over func(*OrchestratorDef)) OrchestratorDef {
	d := OrchestratorDef{Name: "work", Label: "Work", Dir: "/data/orchestrators/work", Env: map[string]string{}, Managed: true}
	if over != nil {
		over(&d)
	}
	return d
}

func TestOrchestratorFiles(t *testing.T) {
	t.Run("orchestratorFiles", func(t *testing.T) {
		files := orchestratorFiles(testOrchestratorDef(nil), "run {{yoicks}} overview; {{yoicks}} agent get x", "node /p/yoicks.js")

		t.Run("CLAUDE.md names the orchestrator and imports the rules, then local.md", func(t *testing.T) {
			md := files["CLAUDE.md"]
			if !strings.Contains(md, "# Orchestrator: Work") {
				t.Errorf("no title in %q", md)
			}
			if !(strings.Index(md, "@rules.md") < strings.Index(md, "@local.md")) {
				t.Errorf("rules.md not imported before local.md: %q", md)
			}
		})

		t.Run("fills the real yoicks command into the rules", func(t *testing.T) {
			if got := files["rules.md"]; got != "run node /p/yoicks.js overview; node /p/yoicks.js agent get x" {
				t.Errorf("got %q", got)
			}
		})

		t.Run("settings allow only that command (overview, agent, worktree remove) and refuse anything else unasked", func(t *testing.T) {
			var s struct{ Permissions map[string]any }
			if err := json.Unmarshal([]byte(files[".claude/settings.json"]), &s); err != nil {
				t.Fatal(err)
			}
			p := s.Permissions
			if p["defaultMode"] != "dontAsk" {
				t.Errorf("defaultMode %v", p["defaultMode"])
			}
			allow, _ := p["allow"].([]any)
			if want := []any{"Bash(node /p/yoicks.js overview)", "Bash(node /p/yoicks.js agent *)", "Bash(node /p/yoicks.js worktree remove *)"}; !slices.Equal(allow, want) {
				t.Errorf("allow %v", allow)
			}
			deny, _ := p["deny"].([]any)
			if !slices.Contains(deny, any("Bash(herdr *)")) || !slices.Contains(deny, any("Read(~/.config/claude/**)")) {
				t.Errorf("deny %v", deny)
			}
			// listers dontAsk would run on any dir
			for _, lister := range []string{"tree", "du", "fd", "fdfind", "lsof"} {
				if !slices.Contains(deny, any("Bash("+lister+" *)")) {
					t.Errorf("%s not denied", lister)
				}
			}
			// it refuses yoicks itself: its path and the --cwd/worktree paths are outside the dir
			if _, ok := p["blockReadsOutsideWorkingDirectories"]; ok {
				t.Error("blockReadsOutsideWorkingDirectories is set")
			}
		})
	})
}

func TestShellWord(t *testing.T) {
	t.Run("shellWord", func(t *testing.T) {
		t.Run("leaves a plain path alone and single-quotes one with spaces or quotes", func(t *testing.T) {
			for in, want := range map[string]string{
				"/home/u/plugin/dist/bin/yoicks.js": "/home/u/plugin/dist/bin/yoicks.js",
				"/home/u/my plugin/x.js":            "'/home/u/my plugin/x.js'",
				"/it's/x.js":                        `'/it'\''s/x.js'`,
			} {
				if got := shellWord(in); got != want {
					t.Errorf("shellWord(%q) = %q, want %q", in, got, want)
				}
			}
		})
	})
}

func TestEnsureOrchestratorDir(t *testing.T) {
	t.Run("ensureOrchestratorDir", func(t *testing.T) {
		t.Run("writes the dir, and creates local.md once without ever overwriting it", func(t *testing.T) {
			rules, err := os.ReadFile("../../orchestrator/rules.md")
			if err != nil {
				t.Fatal(err)
			}
			def := testOrchestratorDef(func(d *OrchestratorDef) { d.Dir = filepath.Join(t.TempDir(), "work") })
			if err := ensureOrchestratorDir(def, string(rules)); err != nil {
				t.Fatal(err)
			}
			for _, f := range []string{"CLAUDE.md", "rules.md", ".claude/settings.json", "local.md"} {
				if _, err := os.Stat(filepath.Join(def.Dir, f)); err != nil {
					t.Error(err)
				}
			}
			if b, _ := os.ReadFile(filepath.Join(def.Dir, "rules.md")); strings.Contains(string(b), "{{yoicks}}") {
				t.Error("rules.md still has {{yoicks}}")
			}
			mine := "answer in Japanese\n"
			os.WriteFile(filepath.Join(def.Dir, "local.md"), []byte(mine), 0o666) // the user's own edit
			if err := ensureOrchestratorDir(def, string(rules)); err != nil {
				t.Fatal(err)
			}
			if b, _ := os.ReadFile(filepath.Join(def.Dir, "local.md")); string(b) != mine {
				t.Errorf("local.md overwritten: %q", b)
			}
		})
	})
}

func TestStartOrchestrator(t *testing.T) {
	t.Run("startOrchestrator", func(t *testing.T) {
		rpcWith := func(agents string, calls *[]string) Rpc {
			return func(method string, _ map[string]any) (json.RawMessage, error) {
				*calls = append(*calls, method)
				if method == "agent.list" {
					return json.RawMessage(`{"agents":` + agents + `}`), nil
				}
				return json.RawMessage(`{}`), nil
			}
		}
		lifecycleError := func(t *testing.T, err error, status int) *LifecycleError {
			t.Helper()
			var le *LifecycleError
			if !errors.As(err, &le) || le.Status != status {
				t.Fatalf("got %v, want a %d LifecycleError", err, status)
			}
			return le
		}

		t.Run("refuses when one already runs in its dir (or below), and starts nothing", func(t *testing.T) {
			var calls []string
			_, _, err := startOrchestrator(rpcWith(`[{"pane_id":"p9","cwd":"/data/orchestrators/work/sub"}]`, &calls), testOrchestratorDef(nil), "")
			if le := lifecycleError(t, err, 409); !regexp.MustCompile(`already runs \(pane p9\)`).MatchString(le.Message) {
				t.Errorf("message %q", le.Message)
			}
			if !slices.Equal(calls, []string{"agent.list"}) {
				t.Errorf("calls %v", calls)
			}
		})

		t.Run("refuses a legacy (unmanaged) dir that does not exist, without writing anything", func(t *testing.T) {
			var calls []string
			_, _, err := startOrchestrator(rpcWith(`[]`, &calls), testOrchestratorDef(func(d *OrchestratorDef) {
				d.Managed, d.Dir = false, "/nonexistent/orch"
			}), "")
			lifecycleError(t, err, 404)
		})
	})
}

func TestExpectedAccount(t *testing.T) {
	// its env's config dir decides, whatever its dir says
	def := testOrchestratorDef(func(d *OrchestratorDef) { d.Env["CLAUDE_CONFIG_DIR"] = "/cfg/work" })
	checkEq(t, expectedAccount(def), accountForConfigDir("/cfg/work", ""))
	// without one, a dir nothing can be read from (direnv fails on it) is the default account
	def = testOrchestratorDef(func(d *OrchestratorDef) { d.Dir = filepath.Join(t.TempDir(), "missing") })
	checkEq(t, expectedAccount(def), accountForConfigDir("", ""))
}
