package bridge

import (
	"context"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestCheckPurpose(t *testing.T) {
	for in, want := range map[string]string{
		"  ログイン後の\nリダイレクトを直す\t": "ログイン後の リダイレクトを直す",
		"a\x00b":                "a b",
		"":                      "",
		" \n ":                  "",
		strings.Repeat("あ", 60): strings.Repeat("あ", 60),
	} {
		if got, err := checkPurpose(in); err != nil || got != want {
			t.Errorf("%q: %q %v, want %q", in, got, err, want)
		}
	}
	if _, err := checkPurpose(strings.Repeat("あ", 61)); err == nil || !strings.Contains(err.Error(), "at most 60") {
		t.Errorf("61 characters: %v", err)
	}
}

// A purpose stays while its pane hasn't been seen with an agent (the State lags the start), and
// goes once a pane seen with one has none, or is gone; a restart keeps the rest.
func TestPurposeStore(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-purposes.json")
	s := newPurposeStore(path)
	changes := 0
	s.onChange = func() { changes++ }
	state := func(connected bool, panes ...RawPane) *State {
		return createState(RawSnapshot{Workspaces: []RawWorkspace{{WorkspaceID: "w1"}}, Tabs: []RawTab{{TabID: "t1", WorkspaceID: "w1"}}, Panes: panes}, 0, nil).withConnected(connected)
	}
	agent := func(id string) RawPane {
		return RawPane{PaneID: id, TabID: "t1", WorkspaceID: "w1", Agent: "claude", AgentStatus: "idle"}
	}
	shell := func(id string) RawPane { return RawPane{PaneID: id, TabID: "t1", WorkspaceID: "w1"} }

	s.Set("p1", "テストを直す")
	s.Set("p2", "docs")
	s.Set("p3", "gone")
	s.Set("p3", "") // none: removed
	if changes != 4 {
		t.Errorf("%d changes", changes)
	}
	s.Prune(state(true)) // nothing seen yet: all kept
	s.Prune(state(true, agent("p1"), agent("p2")))
	s.Prune(state(false)) // disconnected: tells nothing
	if got := s.Purposes(); !maps.Equal(got, map[string]string{"p1": "テストを直す", "p2": "docs"}) {
		t.Fatalf("%v", got)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the file: %v %v", info, err)
	}
	s.Prune(state(true, shell("p1"), agent("p2"))) // p1's agent exited
	if got := newPurposeStore(path).Purposes(); !maps.Equal(got, map[string]string{"p2": "docs"}) {
		t.Fatalf("after a restart: %v", got)
	}
	s.Prune(state(true))
	if got := s.Purposes(); len(got) != 0 {
		t.Errorf("p2's pane is gone: %v", got)
	}
	os.WriteFile(path, []byte("{oops"), 0o600)
	if got := newPurposeStore(path).Purposes(); got == nil || len(got) != 0 {
		t.Errorf("a malformed file: %v", got)
	}
}

// agent_prompt sets a re-tasked worker's purpose (a bad one is refused before anything is sent),
// and the state carries it.
func TestHeadlessPromptPurpose(t *testing.T) {
	needsAccounts(t)
	b := startHeadless(t, t.TempDir(), nil, nil)
	worker(t, b, "idle", nil)
	b.start(t)
	b.waitStatus(t, "idle")
	h := b.srv.headless["h1"]
	cs, err := mcpClient(t, h.mcpURL, bearer(h))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	call := func(args map[string]any) *mcp.CallToolResult { // its answer waits for the delivery window
		n := len(b.world.Prompts())
		done := make(chan *mcp.CallToolResult, 1)
		go func() {
			res, _ := cs.CallTool(ctx, &mcp.CallToolParams{Name: "agent_prompt", Arguments: args})
			done <- res
		}()
		for {
			select {
			case res := <-done:
				if res == nil {
					t.Fatal("no answer")
				}
				return res
			case <-time.After(10 * time.Millisecond):
				if len(b.world.Prompts()) > n {
					b.clock.Advance(deliveryWindow)
				}
			}
		}
	}
	if res := call(map[string]any{"name": "w1", "text": "do it", "purpose": strings.Repeat("x", 61)}); !res.IsError || len(b.world.Prompts()) != 0 {
		t.Fatalf("a long purpose: %+v, %d prompts", res, len(b.world.Prompts()))
	}
	call(map[string]any{"name": "w1", "text": "do it", "purpose": "READMEを\n直す"})
	call(map[string]any{"name": "w1", "text": "and this"}) // none: it keeps its purpose
	b.world.Set("w1p", "blocked")
	if res := call(map[string]any{"name": "w1", "text": "other work", "purpose": "別の仕事"}); !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "task not sent") {
		t.Fatalf("a blocked worker: %+v", res)
	} // not taken: it keeps the work it has
	if got := b.srv.clientState(b.srv.client.State()).Purposes; !maps.Equal(got, map[string]string{"w1p": "READMEを 直す"}) {
		t.Errorf("purposes %v", got)
	}
}
