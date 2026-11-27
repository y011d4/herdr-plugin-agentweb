package bridge

// The user's to-do list, one per Home: what only the user can do and nothing else shows (merge a
// PR, a login, a step on the PC, a later cleanup). Its orchestrator writes it (the headless child's
// `todo` tool, mcp.go); the user ticks items off (DELETE /api/orchestrators/:name/todos/:id). Kept in
// <state>/todos/<name>.json, apart from the session: Stop, Clear and a bridge restart keep it. A
// blocked worker and the Home's own question are not items: the web shows those from the State.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	todoMaxItems = 30
	todoMaxText  = 200 // characters
	todoMaxURL   = 500
)

var (
	todoIDRe    = regexp.MustCompile(`^[0-9a-f]{6}$`)
	todoAgentRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`) // herdr's agent names
	todoDateRe  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// TodoItem is one thing for the user to do, as sent to clients.
type TodoItem struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	// the worker it concerns (its herdr name); null: none
	Agent *string `json:"agent"`
	// an http(s) link for it (a PR, say); null: none
	URL *string `json:"url"`
	// when it is for (ms): the user is reminded once then; null: now
	Due       *int64 `json:"due"`
	CreatedAt int64  `json:"createdAt"`
}

// todoEntry is an item as saved: plus whether its due reminder went out.
type todoEntry struct {
	TodoItem
	Notified bool `json:"notified,omitempty"`
}

// todoAdd is an item to add, as the orchestrator writes it.
type todoAdd struct {
	Text  string `json:"text" jsonschema:"what the user should do: one short line, in the user's language"`
	Agent string `json:"agent,omitempty" jsonschema:"the worker it concerns (its name), if any"`
	URL   string `json:"url,omitempty" jsonschema:"a link for it (http or https), e.g. the PR"`
	Due   string `json:"due,omitempty" jsonschema:"when it is for, if later: RFC 3339 (2026-11-28T18:00:00+09:00) or a date (2026-11-28, meaning 09:00 local); the user is reminded once then"`
}

// newTodo checks a and makes it an item (id left empty); the error says what to fix.
func newTodo(a todoAdd, now int64, loc *time.Location) (todoEntry, error) {
	var e todoEntry
	e.Text = strings.Join(strings.FieldsFunc(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, a.Text), isJSSpace), " ")
	switch n := len([]rune(e.Text)); {
	case n == 0:
		return e, fmt.Errorf("an item needs a text")
	case n > todoMaxText:
		return e, fmt.Errorf("text: at most %d characters (%d)", todoMaxText, n)
	}
	if a.Agent = strings.TrimSpace(a.Agent); a.Agent != "" {
		if !todoAgentRe.MatchString(a.Agent) {
			return e, fmt.Errorf("agent %q: a worker's name, as agent_start took it", a.Agent)
		}
		e.Agent = &a.Agent
	}
	if a.URL = strings.TrimSpace(a.URL); a.URL != "" {
		u, err := url.Parse(a.URL)
		if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" || len(a.URL) > todoMaxURL ||
			strings.ContainsFunc(a.URL, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
			return e, fmt.Errorf("url %q: an http or https link, at most %d characters", a.URL, todoMaxURL)
		}
		e.URL = &a.URL
	}
	if a.Due = strings.TrimSpace(a.Due); a.Due != "" {
		var t time.Time
		var err error
		if todoDateRe.MatchString(a.Due) {
			t, err = time.ParseInLocation("2006-01-02 15:04", a.Due+" 09:00", loc)
		} else {
			t, err = time.Parse(time.RFC3339, a.Due)
		}
		if err != nil {
			return e, fmt.Errorf("due %q: RFC 3339 (2026-11-28T18:00:00+09:00) or a date (2026-11-28)", a.Due)
		}
		ms := t.UnixMilli()
		e.Due = &ms
		e.Notified = ms <= now // already due: the chat that adds it tells the user
	}
	e.CreatedAt = now
	return e, nil
}

// todoStore holds every Home's list.
type todoStore struct {
	dir   string // <state>/todos
	mu    sync.Mutex
	lists map[string][]todoEntry // by orchestrator name
	// the lists whose file is there but couldn't be read: they take no change, which would replace it
	broken   map[string]error
	onChange func()
	loc      *time.Location // a date's due is 09:00 here (tests: a fixed one)
}

// newTodoStore reads the lists of the named orchestrators. One whose file is there but can't be
// read or parsed shows empty and takes no change until the file is fixed or removed and the bridge
// restarted: a write would replace it.
func newTodoStore(stateDir string, names []string) *todoStore {
	s := &todoStore{dir: filepath.Join(stateDir, "todos"), lists: map[string][]todoEntry{}, broken: map[string]error{}, onChange: func() {}, loc: time.Local}
	for _, name := range names {
		var list []todoEntry
		b, err := os.ReadFile(s.path(name))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err == nil {
			err = json.Unmarshal(b, &list)
		}
		if err != nil {
			s.broken[name] = fmt.Errorf("%s could not be read (%v): fix or remove it, then restart the bridge", s.path(name), err)
			logf("[todo] %s", s.broken[name])
			continue
		}
		s.lists[name] = slices.DeleteFunc(list, func(e todoEntry) bool { return !todoIDRe.MatchString(e.ID) || e.Text == "" })
	}
	return s
}

func (s *todoStore) path(name string) string { return filepath.Join(s.dir, name+".json") }

// Items is name's list, oldest first (never nil).
func (s *todoStore) Items(name string) []TodoItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.items(name)
}

func (s *todoStore) items(name string) []TodoItem {
	out := []TodoItem{}
	for _, e := range s.lists[name] {
		out = append(out, e.TodoItem)
	}
	return out
}

// Apply adds and removes items of name's list in one go and returns the list; an invalid item
// or a full list changes nothing. An item whose text is already there isn't added twice, and an
// id that isn't there (the user ticked it off already) is reported in gone.
func (s *todoStore) Apply(name string, add []todoAdd, done []string, now int64) (items []TodoItem, gone []string, err error) {
	var added []todoEntry
	for _, a := range add {
		e, err := newTodo(a, now, s.loc)
		if err != nil {
			return nil, nil, err
		}
		added = append(added, e)
	}
	s.mu.Lock()
	if err := s.broken[name]; err != nil { // a read too: "empty" would be a lie
		s.mu.Unlock()
		return nil, nil, err
	}
	list := slices.Clone(s.lists[name])
	changed := false
	for _, id := range done {
		if i := slices.IndexFunc(list, func(e todoEntry) bool { return e.ID == id }); i >= 0 {
			list, changed = slices.Delete(list, i, i+1), true
		} else {
			gone = append(gone, id)
		}
	}
	for _, e := range added {
		if slices.ContainsFunc(list, func(o todoEntry) bool { return o.Text == e.Text }) {
			continue
		}
		if len(list) >= todoMaxItems {
			s.mu.Unlock()
			return nil, nil, fmt.Errorf("the list has %d items already: mark some done first", todoMaxItems)
		}
		for e.ID == "" || slices.ContainsFunc(list, func(o todoEntry) bool { return o.ID == e.ID }) {
			b := make([]byte, 3)
			rand.Read(b)
			e.ID = hex.EncodeToString(b)
		}
		list, changed = append(list, e), true
	}
	if changed {
		if err := s.save(name, list); err != nil {
			s.mu.Unlock()
			return nil, nil, err
		}
	}
	items = s.items(name)
	s.mu.Unlock()
	if changed {
		s.onChange() // broadcastState reads the lists: never under s.mu
	}
	return items, gone, nil
}

// Done removes name's item id (the user ticked it off); found false: there is none. An error
// (it couldn't be saved, or its file read) leaves the item there.
func (s *todoStore) Done(name, id string) (found bool, err error) {
	s.mu.Lock()
	if err := s.broken[name]; err != nil {
		s.mu.Unlock()
		return false, err
	}
	list := s.lists[name]
	i := slices.IndexFunc(list, func(e todoEntry) bool { return e.ID == id })
	if i >= 0 {
		err = s.save(name, slices.Delete(slices.Clone(list), i, i+1))
	}
	s.mu.Unlock()
	if i >= 0 && err == nil {
		s.onChange()
	}
	return i >= 0, err
}

// TakeDue marks each item due by now and not reminded yet as reminded, and returns them by name
// (the clients see no change: reminded isn't sent).
func (s *todoStore) TakeDue(now int64) map[string][]TodoItem {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := map[string][]TodoItem{}
	for name, list := range s.lists {
		var next []todoEntry
		for i, e := range list {
			if e.Due == nil || e.Notified || *e.Due > now {
				continue
			}
			if next == nil {
				next = slices.Clone(list)
			}
			next[i].Notified = true
			out[name] = append(out[name], e.TodoItem)
		}
		if next != nil {
			// unsaved, it is still reminded once while this bridge runs
			if s.save(name, next) != nil {
				s.lists[name] = next
			}
		}
	}
	return out
}

// save writes list as name's and only then makes it name's list (s.mu held): a list that couldn't
// be saved (a full disk, say) would come back otherwise, after a restart.
func (s *todoStore) save(name string, list []todoEntry) error {
	b, _ := json.Marshal(list)
	err := os.MkdirAll(s.dir, 0o700)
	if err == nil {
		err = writeFile0600(s.path(name), b)
	}
	if err != nil {
		return fmt.Errorf("could not save the to-do list: %w", err)
	}
	s.lists[name] = list
	return nil
}

// todoText is the list as the orchestrator reads it.
func todoText(items []TodoItem, gone []string, loc *time.Location) string {
	var b strings.Builder
	if len(gone) > 0 {
		fmt.Fprintf(&b, "already gone (the user ticked them off): %s\n", strings.Join(gone, ", "))
	}
	if len(items) == 0 {
		b.WriteString("the user's to-do list is empty")
		return b.String()
	}
	fmt.Fprintf(&b, "the user's to-do list (%d):", len(items))
	for _, it := range items {
		var extra []string
		if it.Agent != nil {
			extra = append(extra, "agent "+*it.Agent)
		}
		if it.URL != nil {
			extra = append(extra, *it.URL)
		}
		if it.Due != nil {
			extra = append(extra, "due "+time.UnixMilli(*it.Due).In(loc).Format("2006-01-02 15:04"))
		}
		fmt.Fprintf(&b, "\n- %s: %s", it.ID, it.Text)
		if len(extra) > 0 {
			fmt.Fprintf(&b, " (%s)", strings.Join(extra, ", "))
		}
	}
	return b.String()
}
