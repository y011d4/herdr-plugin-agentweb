package bridge

// A port of server/pane-profile-store.ts.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// PaneProfileStore is a durable pane_id → launch-profile map so `clear` can relaunch
// the exact profile an agent was started with — even across a bridge restart. herdr
// keeps panes alive across the bridge's reconnect but only reports the *detected*
// agent type ("claude"), which can't distinguish a custom "claude-yolo" variant;
// without this the profile would be forgotten on restart and clear would drop the variant.
//
// Backed by a small JSON file in the state dir (0600). Entries are removed when an
// agent is stopped or cleared; a pane closed outside the bridge leaves one small
// residual string until its id is reused or the file is cleared — bounded and cheap.
// Writes are best-effort: an unwritable state dir just costs durability, never a request.
type PaneProfileStore struct {
	path string
	mu   sync.Mutex
	m    map[string]string
}

// createPaneProfileStore loads filePath; no file yet, unreadable or malformed = empty.
// A "__proto__" key is skipped as in the TypeScript (where it could have hit the
// prototype); a Go map has none, but the same file loads the same entries.
func createPaneProfileStore(filePath string) *PaneProfileStore {
	s := &PaneProfileStore{path: filePath, m: map[string]string{}}
	var parsed map[string]any
	if b, err := os.ReadFile(filePath); err == nil && json.Unmarshal(b, &parsed) == nil {
		for k, v := range parsed {
			if v, ok := v.(string); ok && k != "__proto__" {
				s.m[k] = v
			}
		}
	}
	return s
}

func (s *PaneProfileStore) Get(paneID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.m[paneID]
	return p, ok
}

func (s *PaneProfileStore) Set(paneID, profile string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[paneID] = profile
	s.persist()
}

func (s *PaneProfileStore) Delete(paneID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.m[paneID]; ok {
		delete(s.m, paneID)
		s.persist()
	}
}

// persist writes the map; best-effort, losing durability must not fail a request.
// Called with s.mu held.
func (s *PaneProfileStore) persist() {
	b, _ := json.Marshal(s.m)
	if os.MkdirAll(filepath.Dir(s.path), 0o777) != nil || os.WriteFile(s.path, b, 0o600) != nil {
		return
	}
	// WriteFile's mode only applies when the file is created; enforce 0600 on every
	// write so an existing looser-permissioned file is tightened too.
	os.Chmod(s.path, 0o600)
}
