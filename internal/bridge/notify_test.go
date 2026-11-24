package bridge

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func notifyTestState() *State {
	return &State{Workspaces: []*WorkspaceNode{{
		WorkspaceID: "w0", Label: "proj",
		Tabs: []*TabNode{{TabID: "w0:t1", Label: "main", Panes: []*PaneNode{{PaneID: "w0:p1"}}}},
	}}}
}

func TestNotify(t *testing.T) {
	t.Run("buildAgentStatusMessage", func(t *testing.T) {
		state := notifyTestState()

		t.Run("emits agent as a display string with labels", func(t *testing.T) {
			change := StatusChange{PaneID: "w0:p1", From: "working", To: "blocked",
				Agent: &AgentInfo{Name: new("claude"), DisplayName: new("Claude: auth"), Status: "blocked"}}
			msg := buildAgentStatusMessage(change, state)
			if msg.Type != "agent_status" || msg.Agent == nil || *msg.Agent != "Claude: auth" ||
				msg.From != "working" || msg.To != "blocked" ||
				msg.WorkspaceLabel == nil || *msg.WorkspaceLabel != "proj" || msg.TabLabel == nil || *msg.TabLabel != "main" {
				t.Errorf("got %+v", msg)
			}
		})

		t.Run("falls back to name, then null", func(t *testing.T) {
			withName := StatusChange{PaneID: "x", From: "a", To: "b", Agent: &AgentInfo{Name: new("codex"), Status: "idle"}}
			if got := buildAgentStatusMessage(withName, state).Agent; got == nil || *got != "codex" {
				t.Errorf("got %v", got)
			}
			nullAgent := StatusChange{PaneID: "x", From: "a", To: "b"}
			if got := buildAgentStatusMessage(nullAgent, state).Agent; got != nil {
				t.Errorf("got %q", *got)
			}
		})
	})
}

// Not in the TypeScript suite: the ntfy POST, against a local httptest server.
func TestSendNtfyNotification(t *testing.T) {
	type post struct{ title, contentType, body string }
	posts := make(chan post, 8)
	var status atomic.Int32
	status.Store(http.StatusOK)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		posts <- post{r.Header.Get("Title"), r.Header.Get("Content-Type"), string(b)}
		w.WriteHeader(int(status.Load()))
	}))
	defer srv.Close()
	state := notifyTestState()
	change := StatusChange{PaneID: "w0:p1", From: "working", To: "blocked",
		Agent: &AgentInfo{Name: new("claude"), DisplayName: new("Claude 😀 é")}}

	sendNtfyNotification(change, state, &srv.URL)
	want := post{"Claude ?? ? -> blocked", "text/plain", "proj/main · pane w0:p1"}
	if got := <-posts; got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}

	// only blocked/done, and only with a notify_url
	sendNtfyNotification(StatusChange{PaneID: "w0:p1", To: "working"}, state, &srv.URL)
	sendNtfyNotification(change, state, nil)
	sendNtfyNotification(change, state, new(""))
	if len(posts) != 0 {
		t.Errorf("%d unexpected posts", len(posts))
	}

	// a non-2xx answer is a failure; a later success re-arms the log
	status.Store(http.StatusInternalServerError)
	sendNtfyNotification(StatusChange{PaneID: "zz", To: "done"}, state, &srv.URL)
	if got := <-posts; got != (post{"agent -> done", "text/plain", "pane zz"}) {
		t.Errorf("got %+v", got)
	}
	if !ntfyErrorLogged.Load() {
		t.Error("a 500 should count as a failure")
	}
	status.Store(http.StatusOK)
	sendNtfyNotification(change, state, &srv.URL)
	<-posts
	if ntfyErrorLogged.Load() {
		t.Error("a success should re-arm the failure log")
	}
}
