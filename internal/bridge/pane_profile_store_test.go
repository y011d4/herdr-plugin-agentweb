package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPaneProfileStore(t *testing.T) {
	tempFile := func(t *testing.T) string { return filepath.Join(t.TempDir(), "pane-profiles.json") }
	expect := func(t *testing.T, s *PaneProfileStore, paneID, want string) {
		t.Helper()
		got, ok := s.Get(paneID)
		if want == "" && ok || want != "" && got != want {
			t.Errorf("Get(%q) = %q, %v; want %q", paneID, got, ok, want)
		}
	}

	t.Run("set/get/delete round-trips in a single instance", func(t *testing.T) {
		store := createPaneProfileStore(tempFile(t))
		expect(t, store, "w1:p1", "")
		store.Set("w1:p1", "claude-yolo")
		expect(t, store, "w1:p1", "claude-yolo")
		store.Delete("w1:p1")
		expect(t, store, "w1:p1", "")
	})

	t.Run("persists across instances (survives a bridge restart)", func(t *testing.T) {
		file := tempFile(t)
		a := createPaneProfileStore(file)
		a.Set("w1:p1", "claude-yolo")
		a.Set("w2:p3", "codex")
		// A fresh store on the same file reloads the entries.
		b := createPaneProfileStore(file)
		expect(t, b, "w1:p1", "claude-yolo")
		expect(t, b, "w2:p3", "codex")
		b.Delete("w1:p1")
		// The deletion is durable too.
		c := createPaneProfileStore(file)
		expect(t, c, "w1:p1", "")
		expect(t, c, "w2:p3", "codex")
	})

	t.Run("the on-disk file is compact JSON, kept at 0600 even if it already existed looser", func(t *testing.T) {
		file := tempFile(t)
		// Pre-create with loose perms; the store must tighten on write, not just on create.
		if err := os.WriteFile(file, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(file, 0o644); err != nil {
			t.Fatal(err)
		}
		createPaneProfileStore(file).Set("w1:p1", "claude")
		b, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]any
		if err := json.Unmarshal(b, &got); err != nil || !reflect.DeepEqual(got, map[string]any{"w1:p1": "claude"}) {
			t.Errorf("file = %s (%v)", b, err)
		}
		st, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		if st.Mode().Perm() != 0o600 {
			t.Errorf("mode = %o", st.Mode().Perm())
		}
	})

	t.Run("a malformed or missing file starts empty rather than throwing", func(t *testing.T) {
		missing := tempFile(t) // never written
		expect(t, createPaneProfileStore(missing), "x", "")

		bad := tempFile(t)
		if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		store := createPaneProfileStore(bad)
		expect(t, store, "x", "")
		store.Set("w1:p1", "claude") // still writable afterwards
		expect(t, createPaneProfileStore(bad), "w1:p1", "claude")
	})

	t.Run(`a "__proto__" entry in the file neither loads nor pollutes Object.prototype`, func(t *testing.T) {
		file := tempFile(t)
		if err := os.WriteFile(file, []byte(`{"__proto__":"evil","w1:p1":"claude"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		store := createPaneProfileStore(file)
		expect(t, store, "w1:p1", "claude")
		expect(t, store, "__proto__", "") // not loaded, as in the TypeScript
		expect(t, store, "polluted", "")
	})
}
