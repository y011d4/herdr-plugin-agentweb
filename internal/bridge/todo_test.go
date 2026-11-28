package bridge

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

var tokyo = time.FixedZone("JST", 9*3600)

func TestNewTodo(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, tokyo).UnixMilli()
	ok := func(a todoAdd) todoEntry {
		t.Helper()
		e, err := newTodo(a, now, tokyo)
		if err != nil {
			t.Fatalf("%+v: %v", a, err)
		}
		return e
	}
	if e := ok(todoAdd{Text: "  merge\tPR #108\n\x1b[31m now  "}); e.Text != "merge PR #108 [31m now" || e.Agent != nil || e.URL != nil || e.Due != nil || e.CreatedAt != now {
		t.Errorf("%+v", e)
	}
	e := ok(todoAdd{Text: "x", Agent: " w-foo ", URL: "https://github.com/y011d4/herdr-yoicks/pull/108", Due: "2026-11-28"})
	if *e.Agent != "w-foo" || *e.URL != "https://github.com/y011d4/herdr-yoicks/pull/108" ||
		*e.Due != time.Date(2026, 11, 28, 9, 0, 0, 0, tokyo).UnixMilli() || e.Notified {
		t.Errorf("%+v", e)
	}
	if e := ok(todoAdd{Text: "x", URL: "http://127.0.0.1:8390/x", Due: "2026-11-27T18:30:00+09:00"}); *e.Due != time.Date(2026, 11, 27, 18, 30, 0, 0, tokyo).UnixMilli() {
		t.Errorf("%+v", e)
	}
	// already due: the chat that adds it tells the user, so no reminder
	if e := ok(todoAdd{Text: "x", Due: "2026-11-27"}); !e.Notified {
		t.Error("a due in the past is reminded")
	}
	for _, a := range []todoAdd{
		{Text: " \n "}, {Text: strings.Repeat("あ", todoMaxText+1)},
		{Text: "x", Agent: "W-Foo"}, {Text: "x", Agent: "w foo"},
		{Text: "x", URL: "javascript:alert(1)"}, {Text: "x", URL: "ftp://h/x"}, {Text: "x", URL: "https:///x"},
		{Text: "x", URL: "https://h/a b"}, {Text: "x", URL: "/relative"}, {Text: "x", URL: "https://h/" + strings.Repeat("a", todoMaxURL)},
		{Text: "x", Due: "tomorrow"}, {Text: "x", Due: "2026-13-01"}, {Text: "x", Due: "2026-11-28T09:00:00"},
	} {
		if _, err := newTodo(a, now, tokyo); err == nil {
			t.Errorf("%+v: no error", a)
		}
	}
	if _, err := newTodo(todoAdd{Text: strings.Repeat("あ", todoMaxText)}, now, tokyo); err != nil {
		t.Error(err)
	}
}

func TestTodoStore(t *testing.T) {
	state := t.TempDir()
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, tokyo).UnixMilli()
	changes := 0
	open := func() *todoStore {
		s := newTodoStore(state, []string{"a", "b"})
		s.loc, s.onChange = tokyo, func() { changes++ }
		return s
	}
	s := open()
	if items := s.Items("a"); items == nil || len(items) != 0 {
		t.Fatalf("%v", items)
	}
	items, gone, err := s.Apply("a", []todoAdd{{Text: "merge PR #108", Due: "2026-11-28"}, {Text: "run /login"}, {Text: "merge PR #108"}}, nil, now)
	if err != nil || gone != nil || len(items) != 2 || items[0].Text != "merge PR #108" || items[1].Text != "run /login" ||
		!todoIDRe.MatchString(items[0].ID) || items[0].ID == items[1].ID || changes != 1 {
		t.Fatalf("%v %v %v %d", items, gone, err, changes)
	}
	// the same text again: not added twice, nothing changed
	if again, _, _ := s.Apply("a", []todoAdd{{Text: "run /login"}}, nil, now); len(again) != 2 || changes != 1 {
		t.Errorf("%v %d", again, changes)
	}
	// an invalid item changes nothing, the done ones included
	if _, _, err := s.Apply("a", []todoAdd{{Text: ""}}, []string{items[0].ID}, now); err == nil || len(s.Items("a")) != 2 {
		t.Errorf("%v %v", err, s.Items("a"))
	}
	// saved 0600 in a 0700 dir; another Home's list apart
	if st, err := os.Stat(filepath.Join(state, "todos", "a.json")); err != nil || st.Mode().Perm() != 0o600 {
		t.Errorf("%v %v", st, err)
	}
	if st, err := os.Stat(filepath.Join(state, "todos")); err != nil || st.Mode().Perm() != 0o700 {
		t.Errorf("%v %v", st, err)
	}
	if len(s.Items("b")) != 0 {
		t.Error("b has a's items")
	}
	// a restart reads it back; the user ticks one off, the orchestrator's done for it is gone
	s = open()
	if !reflect.DeepEqual(s.Items("a"), items) {
		t.Fatalf("%v", s.Items("a"))
	}
	done := func(name, id string) bool {
		t.Helper()
		item, err := s.Done(name, id)
		if err != nil {
			t.Fatal(err)
		}
		return item != nil && item.ID == id
	}
	if !done("a", items[1].ID) || done("a", items[1].ID) || done("b", items[0].ID) || changes != 2 {
		t.Errorf("Done %d", changes)
	}
	left, gone, err := s.Apply("a", nil, []string{items[1].ID}, now)
	if err != nil || !slices.Equal(gone, []string{items[1].ID}) || len(left) != 1 || changes != 2 {
		t.Errorf("%v %v %v %d", left, gone, err, changes)
	}
	// the reminder goes out once, at its due, and stays sent across a restart
	due := *items[0].Due
	if got := s.TakeDue(due - 1); len(got) != 0 {
		t.Errorf("early: %v", got)
	}
	if got := s.TakeDue(due); len(got["a"]) != 1 || got["a"][0].ID != items[0].ID {
		t.Errorf("%v", got)
	}
	if got := open().TakeDue(due + 1); len(got) != 0 {
		t.Errorf("twice: %v", got)
	}
	// a full list takes no more
	var many []todoAdd
	for i := range todoMaxItems {
		many = append(many, todoAdd{Text: "item " + string(rune('a'+i))})
	}
	if _, _, err := s.Apply("b", many, nil, now); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply("b", []todoAdd{{Text: "one more"}}, nil, now); err == nil || len(s.Items("b")) != todoMaxItems {
		t.Errorf("%v %d", err, len(s.Items("b")))
	}
	// a list that can't be saved stays as it was: a restart would bring the old one back
	s.dir = filepath.Join(state, "todos", "a.json", "x") // under a file: MkdirAll fails
	before := s.Items("a")
	if _, _, err := s.Apply("a", []todoAdd{{Text: "lost"}}, nil, now); err == nil || !reflect.DeepEqual(s.Items("a"), before) {
		t.Errorf("%v %v", err, s.Items("a"))
	}
	if item, err := s.Done("a", before[0].ID); item != nil || err == nil || !reflect.DeepEqual(s.Items("a"), before) {
		t.Errorf("%v %v %v", item, err, s.Items("a"))
	}
	if changes != 3 {
		t.Errorf("%d changes", changes)
	}
	// a file that can't be parsed shows an empty list that takes no change: a write would replace it
	broken := filepath.Join(state, "todos", "a.json")
	os.WriteFile(broken, []byte("{"), 0o600)
	s = open()
	if items, _, err := s.Apply("a", []todoAdd{{Text: "new"}}, nil, now); len(s.Items("a")) != 0 || err == nil || !strings.Contains(err.Error(), "fix or remove it") {
		t.Errorf("%v %v", items, err)
	}
	// a read or a done-only call names the file too, rather than "empty" or "already gone"
	for _, done := range [][]string{nil, {"0a0b0c"}} {
		if _, _, err := s.Apply("a", nil, done, now); err == nil || !strings.Contains(err.Error(), broken) {
			t.Errorf("done %v: %v", done, err)
		}
	}
	if item, err := s.Done("a", "0a0b0c"); item != nil || err == nil {
		t.Errorf("Done: %v %v", item, err)
	}
	if got, _ := os.ReadFile(broken); string(got) != "{" {
		t.Errorf("written over: %s", got)
	}
	if _, _, err := s.Apply("b", []todoAdd{{Text: "new"}}, []string{s.Items("b")[0].ID}, now); err != nil {
		t.Errorf("b: %v", err)
	}
}

func TestTodoText(t *testing.T) {
	due := time.Date(2026, 11, 28, 9, 0, 0, 0, tokyo).UnixMilli()
	items := []TodoItem{{ID: "a1b2c3", Text: "merge PR #108", Agent: new("w-foo"), URL: new("https://github.com/o/r/pull/108"), Due: &due}, {ID: "d4e5f6", Text: "run /login"}}
	want := "already gone (the user ticked them off or dismissed them): 0a0b0c\nthe user's to-do list (2):\n" +
		"- a1b2c3: merge PR #108 (agent w-foo, https://github.com/o/r/pull/108, due 2026-11-28 09:00)\n- d4e5f6: run /login"
	if got := todoText(items, []string{"0a0b0c"}, tokyo); got != want {
		t.Errorf("%q", got)
	}
	if got := todoText(nil, nil, tokyo); got != "the user's to-do list is empty" {
		t.Errorf("%q", got)
	}
}

// Through the bridge: the orchestrator's tool writes its Home's list, the state shows it, the
// user ticks an item off, and an item come due is reminded once (WS, the PC).
func TestHeadlessTodo(t *testing.T) {
	state := t.TempDir()
	b := startHeadless(t, state, nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	cs, err := mcpClient(t, b.srv.headless["h1"].mcpURL, bearer(b.srv.headless["h1"]))
	if err != nil {
		t.Fatal(err)
	}
	call := func(args map[string]any) (string, bool) {
		t.Helper()
		res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "todo", Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		return res.Content[0].(*mcp.TextContent).Text, res.IsError
	}
	due := time.Now().Add(time.Hour).Format(time.RFC3339)
	text, isErr := call(map[string]any{"add": []any{
		map[string]any{"text": "merge PR #108", "url": "https://github.com/o/r/pull/108", "agent": "w-foo"},
		map[string]any{"text": "delete ~/backup.tgz", "due": due},
		map[string]any{"text": "rotate the key", "due": due}}})
	ids := regexp.MustCompile(`(?m)^- ([0-9a-f]{6}): `).FindAllStringSubmatch(text, -1)
	if isErr || len(ids) != 3 || !strings.Contains(text, "agent w-foo, https://github.com/o/r/pull/108") {
		t.Fatalf("%v %q", isErr, text)
	}
	if text, isErr := call(map[string]any{"add": []any{map[string]any{"text": "x", "url": "javascript:alert(1)"}}}); !isErr || !strings.Contains(text, "url") {
		t.Errorf("%v %q", isErr, text)
	}
	v := b.waitFor(t, "the items", func(v OrchestratorView) bool { return len(v.Todos) == 3 })
	if v.Todos[0].ID != ids[0][1] || v.Todos[0].Agent == nil || *v.Todos[0].Agent != "w-foo" || v.Todos[1].Due == nil {
		t.Errorf("%+v", v.Todos)
	}

	// the user ticks the first off; again, or another Home's, is a 404
	path := "/api/orchestrators/h1/todos/" + ids[0][1]
	if status, body, _ := b.do(t, "DELETE", path, b.token, nil); status != 200 || body != `{"ok":true}` {
		t.Errorf("%d %s", status, body)
	}
	for _, p := range []string{path, "/api/orchestrators/nope/todos/" + ids[1][1]} {
		if status, _, _ := b.do(t, "DELETE", p, b.token, nil); status != 404 {
			t.Errorf("%s: %d", p, status)
		}
	}
	if text, _ := call(map[string]any{"done": []any{ids[0][1]}}); !strings.HasPrefix(text, "already gone (the user ticked them off or dismissed them): "+ids[0][1]+"\n") {
		t.Errorf("%q", text)
	}

	// come due: reminded once, to the clients and the PC
	c, _, err := b.dial(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	readUntil(t, c, "state") // registered: Dial returns before the server adds the client
	at := time.Now().Add(2 * time.Hour).UnixMilli()
	b.srv.remindTodos(at)
	b.srv.remindTodos(at)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatal("no todo alert:", err)
		}
		var m WsOrchestratorAlertMessage
		if json.Unmarshal(data, &m) == nil && m.Type == "orchestrator_alert" && m.Kind == "todo" {
			if m.Name != "h1" || m.Message != "2 items: delete ~/backup.tgz · rotate the key" {
				t.Errorf("%+v", m)
			}
			break
		}
	}
	b.srv.bg.Wait()
	var shown []string
	for _, n := range b.world.Notifications() {
		if n["title"] == "H1: todo" {
			shown = append(shown, n["body"].(string))
		}
	}
	if !slices.Equal(shown, []string{"2 items: delete ~/backup.tgz · rotate the key"}) {
		t.Errorf("%v", shown)
	}

	// Stop and a restart of the bridge keep the list
	b.post(t, "stop", "")
	b = startHeadless(t, state, nil, nil)
	if v := b.view(t); len(v.Todos) != 2 || v.Todos[0].ID != ids[1][1] {
		t.Errorf("%+v", v.Todos)
	}
}

// The user ticking items off or dismissing them wakes the Home: those within wakeCoalesce in one
// message, one line each, a dismissed one's its own (no next step follows it); while it is stopped,
// never (not at its next start either). The PR watch's removal and the orchestrator's own done
// wake nothing of this kind; a dismiss that isn't 1 removes nothing.
func TestHeadlessTodoTickWake(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	items, _, err := b.srv.todos.Apply(b.name, []todoAdd{
		{Text: "add the ui-change label to #157", Agent: "w-vrt", URL: "https://github.com/o/r/pull/157"},
		{Text: "run /login"}, {Text: "while stopped"}, {Text: "after the start"}, {Text: "done by the orchestrator"},
		{Text: "merge #158", Agent: "w-vrt", URL: "https://github.com/o/r/pull/158"},
	}, nil, nowMs())
	if err != nil {
		t.Fatal(err)
	}
	del := func(i int, query string, want int) {
		t.Helper()
		if status, body, _ := b.do(t, "DELETE", "/api/orchestrators/"+b.name+"/todos/"+items[i].ID+query, b.token, nil); status != want {
			t.Fatalf("%s: %d %s", query, status, body)
		}
	}
	tick := func(i int) { t.Helper(); del(i, "", 200) }
	const prefix, dismissed = "[yoicks] to-do done by the user: ", "[yoicks] to-do dismissed by the user: "
	// the messages written to the child that carry such a line
	tickMessages := func() []string {
		_, stdin := b.runs(t)
		var out []string
		for _, l := range stdin {
			var m struct{ Message struct{ Content string } }
			json.Unmarshal([]byte(l), &m)
			if strings.Contains(m.Message.Content, "[yoicks] to-do ") {
				out = append(out, m.Message.Content)
			}
		}
		return out
	}
	waitTicks := func(n int) []string {
		t.Helper()
		var got []string
		waitUntil(t, 10*time.Second, "the tick wake-ups", func() bool {
			b.clock.Advance(wakeCoalesce)
			got = tickMessages()
			return len(got) >= n
		})
		return got
	}

	for _, q := range []string{"?dismiss=yes", "?dismiss=", "?dismiss", "?dismiss=1&dismiss=1", "?dismiss=1;x=1", "?dismiss=%zz"} {
		del(5, q, 400)
	}
	tick(0)
	del(5, "?dismiss=1", 200)
	tick(1)
	want := prefix + "add the ui-change label to #157 (w-vrt, https://github.com/o/r/pull/157)\n" +
		dismissed + "merge #158 (w-vrt, https://github.com/o/r/pull/158)\n" + prefix + "run /login"
	if got := waitTicks(1); !slices.Equal(got, []string{want}) {
		t.Errorf("%q", got)
	}
	if _, _, err := b.srv.todos.Apply(b.name, nil, []string{items[4].ID}, nowMs()); err != nil {
		t.Fatal(err)
	}

	b.post(t, "stop", "")
	b.waitStatus(t, "stopped")
	tick(2)
	b.start(t)
	b.waitStatus(t, "idle")
	tick(3)
	if got := waitTicks(2); len(got) != 2 || got[1] != prefix+"after the start" {
		t.Errorf("%q", got)
	}
	b.clock.Advance(wakeCoalesce + time.Second)
	if got := tickMessages(); len(got) != 2 {
		t.Errorf("%q", got)
	}
}
