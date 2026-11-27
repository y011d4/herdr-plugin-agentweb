package bridge

// What each worker is for: one short line in the user's language that its orchestrator gives at
// agent_start (or agent_prompt, re-tasking it), which the agents list, the PC sidebar and the
// drawer show over the worker's name (state `purposes`, by pane id). Kept in
// <state>/agent-purposes.json, so a bridge restart keeps them; an entry goes once its pane, seen
// with an agent, has none (the agent exited) or is gone.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
)

const purposeMax = 60 // characters

type purposeEntry struct {
	Purpose string `json:"purpose"`
	Seen    bool   `json:"seen,omitempty"` // its pane has been seen with an agent
}

type purposeStore struct {
	path     string
	mu       sync.Mutex
	m        map[string]purposeEntry // by pane id
	onChange func()
}

// newPurposeStore loads path; no file yet, unreadable or malformed = empty.
func newPurposeStore(path string) *purposeStore {
	s := &purposeStore{path: path, m: map[string]purposeEntry{}, onChange: func() {}}
	var m map[string]purposeEntry
	if b, err := os.ReadFile(path); err == nil && json.Unmarshal(b, &m) == nil && m != nil {
		s.m = m
	}
	return s
}

// oneLine is s with control characters as spaces and every run of spaces as one, trimmed.
func oneLine(s string) string {
	return strings.Join(strings.FieldsFunc(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s), isJSSpace), " ")
}

// checkPurpose is p as one line ("": none); the error says what to fix.
func checkPurpose(p string) (string, error) {
	p = oneLine(p)
	if n := len([]rune(p)); n > purposeMax {
		return "", fmt.Errorf("purpose: one short line, at most %d characters (%d)", purposeMax, n)
	}
	return p, nil
}

// Set makes purpose (checkPurpose's) the agent in paneID's; "" removes it.
func (s *purposeStore) Set(paneID, purpose string) {
	s.mu.Lock()
	if purpose == "" {
		delete(s.m, paneID)
	} else {
		s.m[paneID] = purposeEntry{Purpose: purpose}
	}
	s.persist()
	s.mu.Unlock()
	s.onChange()
}

// Purposes is each agent's purpose, by pane id (a copy).
func (s *purposeStore) Purposes() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]string, len(s.m))
	for id, e := range s.m {
		out[id] = e.Purpose
	}
	return out
}

// Prune drops the purposes of agents gone, as st (a connected State) shows them. A pane not
// seen with an agent yet is kept: the State can lag behind the agent_start that set it.
// ponytail: an agent replaced in its pane while the bridge was down keeps the old purpose, and a
// pane closed before the bridge ever saw it leaves its entry; compare herdr names if that shows up.
func (s *purposeStore) Prune(st *State) {
	if !st.Connected {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for id, e := range s.m {
		p := st.Pane(id)
		switch live := p != nil && p.Agent != nil; {
		case live && !e.Seen:
			e.Seen = true
			s.m[id] = e
			changed = true
		case !live && e.Seen:
			delete(s.m, id)
			changed = true
		}
	}
	if changed {
		s.persist()
	}
}

// persist writes the map (s.mu held); best-effort: a failed write costs only durability.
func (s *purposeStore) persist() {
	b, _ := json.Marshal(s.m)
	if os.MkdirAll(filepath.Dir(s.path), 0o700) == nil {
		writeFile0600(s.path, b)
	}
}
