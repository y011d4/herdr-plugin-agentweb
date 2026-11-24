package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// testdata/vectors/injected-turns.json (tools/vectors/injected-turns.ts) is the web home
// chat's rule for which user turns Claude Code writes itself; isTaskTurn must agree.
func TestInjectedTurnVectors(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "vectors", "injected-turns.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Text     string `json:"text"`
		Injected bool   `json:"injected"`
	}
	if err := json.Unmarshal(b, &vectors); err != nil || len(vectors) == 0 {
		t.Fatalf("vectors: %v (%d)", err, len(vectors))
	}
	for _, v := range vectors {
		if got := isTaskTurn(TimelineItem{Kind: "user", Text: v.Text}); got == v.Injected {
			t.Errorf("isTaskTurn(%q) = %v, want %v", v.Text, got, !v.Injected)
		}
	}
}
