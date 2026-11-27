package bridge

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// A TUI orchestrator's files must not change by a byte unless meant to: a changed rules.md
// or settings.json changes what the running orchestrators get on their next start (and
// wants a Clear). The golden was written from the code before headless mode existed;
// rewrite it (go test -run TestTUIOrchestratorGolden -update) only for an intended change.
func TestTUIOrchestratorGolden(t *testing.T) {
	root := filepath.Join("..", "..")
	rules, err := os.ReadFile(filepath.Join(root, "orchestrator", "rules.md"))
	if err != nil {
		t.Fatal(err)
	}
	def := OrchestratorDef{Name: "personal", Label: "Personal", Dir: "/home/u/.local/share/herdr-yoicks/orchestrators/personal",
		Env: map[string]string{}}
	files := orchestratorFiles(def, string(rules), "/home/u/herdr-yoicks/bin/yoicks")
	if len(files) != 3 {
		t.Fatalf("files %d, want 3", len(files))
	}
	for rel, got := range files {
		path := filepath.Join(root, "testdata", "orchestrator-golden", filepath.Base(rel))
		if *update {
			if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(want, []byte(got)) {
			t.Errorf("%s differs from %s", rel, path)
		}
	}
}
