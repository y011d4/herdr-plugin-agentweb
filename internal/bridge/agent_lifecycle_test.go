package bridge

// A port of server/test/agent-lifecycle.test.ts.

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// lifecycleFake is a fake herdr rpc: it records every call, with its params as herdr
// gets them (through JSON), and answers from a canned table: an error is returned, a
// func(params) is called, anything else is the result. Other methods answer {}.
type lifecycleFake struct {
	responses map[string]any
	calls     []lifecycleCall
}

type lifecycleCall struct {
	method string
	params map[string]any
}

func (f *lifecycleFake) rpc(method string, params map[string]any) (json.RawMessage, error) {
	b, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	var wire map[string]any
	json.Unmarshal(b, &wire)
	f.calls = append(f.calls, lifecycleCall{method, wire})
	r, ok := f.responses[method]
	if !ok {
		return json.RawMessage(`{}`), nil
	}
	switch v := r.(type) {
	case error:
		return nil, v
	case func(map[string]any) (any, error):
		if r, err = v(wire); err != nil {
			return nil, err
		}
	}
	return json.Marshal(r)
}

func (f *lifecycleFake) methods() []string {
	out := []string{}
	for _, c := range f.calls {
		out = append(out, c.method)
	}
	return out
}

// find is the params of the first call of method, or nil.
func (f *lifecycleFake) find(method string) map[string]any {
	for _, c := range f.calls {
		if c.method == method {
			return c.params
		}
	}
	return nil
}

func (f *lifecycleFake) count(method string) int {
	n := 0
	for _, c := range f.calls {
		if c.method == method {
			n++
		}
	}
	return n
}

func TestAgentLifecycle(t *testing.T) {
	type obj = map[string]any
	fake := func(responses ...obj) *lifecycleFake {
		f := &lifecycleFake{responses: obj{}}
		for _, r := range responses {
			maps.Copy(f.responses, r)
		}
		return f
	}
	eq := func(t *testing.T, got, want any) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %#v, want %#v", got, want)
		}
	}
	jsonEq := func(t *testing.T, v any, want string) {
		t.Helper()
		if b, _ := json.Marshal(v); string(b) != want {
			t.Errorf("got %s, want %s", b, want)
		}
	}
	isStatus := func(err error, status int) bool {
		var le *LifecycleError
		return errors.As(err, &le) && le.Status == status
	}
	wantStatus := func(t *testing.T, err error, status int) {
		t.Helper()
		if !isStatus(err, status) {
			t.Errorf("want a LifecycleError with status %d, got %#v", status, err)
		}
	}
	wantErr := func(t *testing.T, err error, pattern string) {
		t.Helper()
		if err == nil || !regexp.MustCompile(pattern).MatchString(err.Error()) {
			t.Errorf("want an error matching %q, got %v", pattern, err)
		}
	}
	fromJSON := func(t *testing.T, s string) any {
		t.Helper()
		var v any
		if err := json.Unmarshal([]byte(s), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	herdrError := func(code string) error { return &HerdrError{Code: code, Message: code} }
	profiles := defaultLaunchProfiles

	// ── parseLaunchProfiles ──────────────────────────────────────────────────

	t.Run("parseLaunchProfiles: undefined/invalid returns the defaults", func(t *testing.T) {
		// undefined and null are both nil here
		for _, raw := range []any{nil, "nope", []any{1.0, 2.0}} {
			eq(t, parseLaunchProfiles(raw), defaultLaunchProfiles)
		}
	})

	t.Run("parseLaunchProfiles: adds new profiles and keeps the defaults", func(t *testing.T) {
		p := parseLaunchProfiles(fromJSON(t, `{"claude-danger": {"argv": ["claude", "--dangerously-skip-permissions"], "label": "Claude (yolo)"}}`))
		eq(t, p["claude-danger"], LaunchProfile{Argv: []string{"claude", "--dangerously-skip-permissions"}}) // its label is ignored
		eq(t, p["claude"], defaultLaunchProfiles["claude"])                                                  // defaults preserved
	})

	t.Run("parseLaunchProfiles: overrides a default argv", func(t *testing.T) {
		p := parseLaunchProfiles(fromJSON(t, `{"codex": {"argv": ["codex", "--full-auto"]}}`))
		eq(t, p["codex"].Argv, []string{"codex", "--full-auto"})
	})

	t.Run(`parseLaunchProfiles: a "__proto__" key does not corrupt the map or pollute Object.prototype`, func(t *testing.T) {
		// Go has no prototype to pollute; what's left is that the key (an own key, as
		// JSON.parse of config.json makes it) is not added as a profile
		p := parseLaunchProfiles(fromJSON(t, `{"__proto__": {"argv": ["evil"], "label": "x"}}`))
		if _, ok := p["__proto__"]; ok {
			t.Error("__proto__ is not added as a profile")
		}
		if _, ok := p["claude"]; !ok {
			t.Error("defaults intact")
		}
	})

	t.Run("parseLaunchProfiles: malformed entries are ignored (graceful)", func(t *testing.T) {
		p := parseLaunchProfiles(fromJSON(t, `{
			"a": {"argv": "claude"},
			"b": {"argv": []},
			"c": {"argv": ["ok", 1]},
			"d": {},
			"e": "string",
			"good": {"argv": ["ok"]}
		}`))
		for _, bad := range []string{"a", "b", "c", "d", "e"} {
			if _, ok := p[bad]; ok {
				t.Errorf("%s should be dropped", bad)
			}
		}
		eq(t, p["good"], LaunchProfile{Argv: []string{"ok"}})
		if _, ok := p["claude"]; !ok {
			t.Error("defaults still present")
		}
	})

	// ── startAgent ───────────────────────────────────────────────────────────

	// herdr >= 0.8: tab.create opens the shell pane, agent.start launches into it.
	startResponse := func(paneID, agent string) obj {
		return obj{
			"tab.create": obj{"type": "tab_created", "tab": obj{"tab_id": "w1:t1"}, "root_pane": obj{"pane_id": paneID}},
			"agent.start": func(p obj) (any, error) {
				return obj{"type": "agent_started", "agent": obj{"pane_id": p["pane_id"], "name": p["name"], "agent": agent},
					"argv": append([]any{p["kind"]}, p["args"].([]any)...)}, nil
			},
			"agent.get": obj{"type": "agent_info", "agent": obj{"pane_id": paneID, "interactive_ready": true}},
		}
	}
	// Mirrors herdr's real worktree_created shape (the checkout dir is worktree.path).
	worktreeCreateResponse := func(checkoutPath, wsID, branch, paneID string) obj {
		return obj{"worktree.create": obj{
			"type":      "worktree_created",
			"worktree":  obj{"path": checkoutPath, "branch": branch, "open_workspace_id": wsID},
			"workspace": obj{"workspace_id": wsID, "worktree": obj{"checkout_path": checkoutPath}},
			"root_pane": obj{"pane_id": paneID},
		}}
	}

	t.Run("agentName: fits herdr's ^[a-z][a-z0-9_-]{0,31}$ rule", func(t *testing.T) {
		eq(t, agentName("My Agent!"), "my-agent")
		eq(t, agentName("  Review_2 "), "review_2")
		eq(t, agentName("2nd try"), "nd-try")
		eq(t, agentName(strings.Repeat("a", 40)), strings.Repeat("a", 32))
		for _, bad := range []any{"", "   ", "123", "日本", 5.0, nil} {
			if got := agentName(bad); got != "" {
				t.Errorf("agentName(%v) = %q, want none", bad, got)
			}
		}
	})

	t.Run("startAgent: unknown / missing profile is a 400 LifecycleError, no rpc fired", func(t *testing.T) {
		f := fake()
		_, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "ghost"}, StartAgentOptions{})
		wantStatus(t, err, 400)
		_, err = startAgent(f.rpc, profiles, StartAgentInput{}, StartAgentOptions{})
		wantStatus(t, err, 400)
		eq(t, len(f.calls), 0) // no rpc on validation failure
	})

	t.Run("startAgent: inherited Object.prototype names are NOT valid profiles (in-operator hazard)", func(t *testing.T) {
		f := fake(startResponse("w1:t1:p1", "claude"))
		for _, bad := range []string{"toString", "constructor", "__proto__", "hasOwnProperty"} {
			_, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: bad}, StartAgentOptions{})
			if !isStatus(err, 400) {
				t.Errorf("profile %q must be rejected", bad)
			}
		}
		eq(t, len(f.calls), 0) // no rpc fired for a bogus profile
	})

	t.Run("startAgent: opens a tab at cwd in the workspace, then agent.start launches the profile kind into it", func(t *testing.T) {
		profiles := parseLaunchProfiles(fromJSON(t, `{"yolo": {"argv": ["claude", "--dangerously-skip-permissions"]}}`))
		f := fake(startResponse("w9:t9:p9", "claude"))
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "yolo", Name: "My Agent", Cwd: "/home/u/proj", Workspace: "ws-7"}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, f.methods(), []string{"tab.create", "agent.start"})
		eq(t, f.calls[0].params, obj{"label": "my-agent", "focus": false, "cwd": "/home/u/proj", "workspace_id": "ws-7"})
		eq(t, f.calls[1].params, obj{"name": "my-agent", "kind": "claude", "pane_id": "w9:t9:p9", "args": []any{"--dangerously-skip-permissions"}})
		jsonEq(t, out, `{"paneId":"w9:t9:p9","name":"my-agent","agent":"claude"}`)
	})

	t.Run("startAgent: auto-generates a valid name from the profile when none is given, omits cwd/workspace when absent", func(t *testing.T) {
		f := fake(startResponse("w1:t1:p1", "claude"))
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "codex", Name: "  "}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if !regexp.MustCompile(`^codex-[a-z0-9]+$`).MatchString(out.Name) {
			t.Errorf("name %q", out.Name)
		}
		if _, ok := f.calls[0].params["cwd"]; ok {
			t.Error("cwd should be omitted")
		}
		if _, ok := f.calls[0].params["workspace_id"]; ok {
			t.Error("workspace_id should be omitted")
		}
		eq(t, f.calls[1].params["kind"], "codex")
	})

	t.Run("startAgent: retries agent.start while the new pane's shell is still starting (agent_pane_busy)", func(t *testing.T) {
		tries := 0
		base := startResponse("P:new", "claude")
		baseStart := base["agent.start"].(func(obj) (any, error))
		f := fake(base, obj{"agent.start": func(p obj) (any, error) {
			if tries++; tries < 3 {
				return nil, herdrError("agent_pane_busy")
			}
			return baseStart(p)
		}})
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude"}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, tries, 3)
		eq(t, out.PaneID, "P:new")
	})

	t.Run("startAgent: a failed agent start closes the tab it opened", func(t *testing.T) {
		f := fake(startResponse("P:new", "claude"), obj{"agent.start": herdrError("unsupported_agent_kind")})
		_, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude"}, StartAgentOptions{})
		wantErr(t, err, `unsupported_agent_kind`)
		eq(t, f.count("agent.start"), 1) // only agent_pane_busy is retried
		eq(t, f.find("pane.close"), obj{"pane_id": "P:new"})
	})

	t.Run("startAgent: no pane from tab.create is a 502 and nothing is started", func(t *testing.T) {
		f := fake(startResponse("w1:t1:p1", "claude"), obj{"tab.create": obj{}})
		_, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude"}, StartAgentOptions{})
		wantStatus(t, err, 502)
		eq(t, f.count("agent.start"), 0)
	})

	t.Run("startAgent: with no workspace at all, opens a workspace instead of a tab", func(t *testing.T) {
		f := fake(startResponse("w1:t1:p1", "claude"), obj{
			"tab.create":       herdrError("workspace_not_found"),
			"workspace.create": obj{"type": "workspace_created", "root_pane": obj{"pane_id": "wN:p1"}},
		})
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude", Name: "a", Cwd: "/p"}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, f.find("workspace.create"), obj{"label": "a", "focus": false, "cwd": "/p"})
		eq(t, out.PaneID, "wN:p1")
		// an explicit workspace that is gone is an error, not a silent new workspace
		strict := fake(startResponse("w1:t1:p1", "claude"), obj{"tab.create": herdrError("workspace_not_found")})
		_, err = startAgent(strict.rpc, profiles, StartAgentInput{Profile: "claude", Workspace: "gone"}, StartAgentOptions{})
		wantErr(t, err, `workspace_not_found`)
		eq(t, strict.count("workspace.create"), 0)
	})

	t.Run("startAgent: a long profile key is trimmed, never the timestamp that keeps auto names unique", func(t *testing.T) {
		key := "claude-skip-permissions-mode-extra-long"
		profiles := parseLaunchProfiles(obj{key: obj{"argv": []any{"claude"}}})
		before := time.Now().UnixMilli()
		f := fake(startResponse("w1:t1:p1", "claude"))
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: key}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if !regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`).MatchString(out.Name) {
			t.Errorf("name %q", out.Name)
		}
		if ts, _ := strconv.ParseInt(out.Name[strings.LastIndex(out.Name, "-")+1:], 36, 64); ts < before {
			t.Errorf("timestamp kept in %s", out.Name)
		}
	})

	t.Run("startAgent: an agent blocked on a startup dialog gets no task, without waiting out the timeout", func(t *testing.T) {
		f := fake(startResponse("w1:t1:p1", "claude"), obj{"agent.get": obj{"agent": obj{"agent_status": "blocked", "interactive_ready": false}}})
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude", Task: "hi"}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, out.TaskDelivered, new(bool))
		eq(t, f.count("agent.prompt"), 0)
	})

	t.Run("startAgent: waits for the agent to be interactive, then delivers the task via agent.prompt to its pane id", func(t *testing.T) {
		polls := 0
		f := fake(startResponse("w5:t5:p5", "claude"), obj{"agent.get": func(obj) (any, error) {
			polls++
			return obj{"agent": obj{"pane_id": "w5:t5:p5", "interactive_ready": polls >= 2}}, nil
		}})
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude", Name: "a", Task: "do the thing"}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, polls, 2) // polled until interactive_ready
		eq(t, f.find("agent.prompt"), obj{"target": "w5:t5:p5", "text": "do the thing"})
		eq(t, out.TaskDelivered != nil && *out.TaskDelivered, true)
	})

	t.Run("startAgent: an empty task is skipped but still reports taskDelivered:false (not omitted)", func(t *testing.T) {
		f := fake(startResponse("w1:t1:p1", "claude"))
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude", Name: "a", Task: ""}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, f.count("agent.prompt"), 0) // no prompt for an empty task
		eq(t, out.TaskDelivered, new(bool))
		jsonEq(t, out, `{"paneId":"w1:t1:p1","name":"a","agent":"claude","taskDelivered":false}`)
	})

	t.Run("startAgent: a failed task prompt is non-fatal — the agent still started", func(t *testing.T) {
		f := fake(startResponse("P:started", "claude"), obj{"agent.prompt": herdrError("agent_not_ready")})
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude", Name: "a", Task: "hi"}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, out.PaneID, "P:started")
		eq(t, out.TaskDelivered, new(bool))
	})

	t.Run("startAgent: rejects malformed cwd/task/workspace/name with a 400, before opening anything", func(t *testing.T) {
		f := fake(startResponse("w1:t1:p1", "claude"))
		for _, bad := range []StartAgentInput{{Cwd: 5.0}, {Task: 5.0}, {Workspace: 5.0}, {Name: 5.0}, {Cwd: ""}, {Name: "日本"}} {
			bad.Profile = "claude"
			_, err := startAgent(f.rpc, profiles, bad, StartAgentOptions{})
			wantStatus(t, err, 400)
		}
		eq(t, len(f.calls), 0)
	})

	t.Run("startAgent: a worktree spec creates the worktree first, then launches the agent in its root pane", func(t *testing.T) {
		f := fake(startResponse("w1:t1:p1", "claude"), worktreeCreateResponse("/wt/new", "wNEW", "feat/x", "wNEW:p1"))
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude", Name: "a", Worktree: &CreateWorktreeInput{Repo: "/proj", Branch: "feat/x"}}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, f.methods(), []string{"worktree.create", "agent.start"}) // no extra tab
		eq(t, f.calls[1].params["pane_id"], "wNEW:p1")
		eq(t, out.PaneID, "wNEW:p1")
	})

	t.Run("startAgent: a failed agent start rolls the just-created worktree back", func(t *testing.T) {
		f := fake(worktreeCreateResponse("/wt/new", "wNEW", "feat/x", "w9:p1"), obj{"agent.start": errors.New("boom")})
		_, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude", Worktree: &CreateWorktreeInput{Repo: "/proj"}}, StartAgentOptions{})
		wantErr(t, err, `boom`)
		eq(t, f.find("worktree.remove"), obj{"workspace_id": "wNEW", "force": true})
		eq(t, f.count("pane.close"), 0)
	})

	t.Run("startAgent: env goes to the new tab or workspace (the agent's shell)", func(t *testing.T) {
		env := map[string]string{"CLAUDE_CONFIG_DIR": "/c/work"}
		tab := fake(startResponse("w1:t1:p1", "claude"))
		if _, err := startAgent(tab.rpc, profiles, StartAgentInput{Profile: "claude", Name: "a", Cwd: "/p", Workspace: "w1", Env: env}, StartAgentOptions{}); err != nil {
			t.Fatal(err)
		}
		eq(t, tab.calls[0].params["env"], obj{"CLAUDE_CONFIG_DIR": "/c/work"})
		ws := fake(startResponse("w1:t1:p1", "claude"), obj{"workspace.create": obj{"root_pane": obj{"pane_id": "wN:p1"}}})
		if _, err := startAgent(ws.rpc, profiles, StartAgentInput{Profile: "claude", Name: "a", Cwd: "/p", NewWorkspace: true, Env: env}, StartAgentOptions{}); err != nil {
			t.Fatal(err)
		}
		eq(t, ws.calls[0].params, obj{"cwd": "/p", "env": obj{"CLAUDE_CONFIG_DIR": "/c/work"}, "focus": false})
	})

	t.Run("startAgent: newWorkspace opens a workspace at cwd (herdr names it), not a tab", func(t *testing.T) {
		f := fake(startResponse("w1:t1:p1", "claude"), obj{"workspace.create": obj{"root_pane": obj{"pane_id": "wN:p1"}}})
		out, err := startAgent(f.rpc, profiles, StartAgentInput{Profile: "claude", Name: "a", Cwd: "/p", NewWorkspace: true}, StartAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, f.methods(), []string{"workspace.create", "agent.start"})
		// TS asserts `env: undefined`, which JSON drops: herdr gets no env key
		eq(t, f.calls[0].params, obj{"cwd": "/p", "focus": false})
		eq(t, out.PaneID, "wN:p1")
	})

	t.Run("startAgent: a failing verify rolls the started agent back (its tab, or its worktree) and rethrows", func(t *testing.T) {
		verify := StartAgentOptions{Verify: func(paneID string) error { return fmt.Errorf("wrong account: %s", paneID) }}
		tab := fake(startResponse("P:new", "claude"))
		_, err := startAgent(tab.rpc, profiles, StartAgentInput{Profile: "claude", Cwd: "/p"}, verify)
		wantErr(t, err, `wrong account: P:new: it was stopped`)
		eq(t, tab.find("pane.close"), obj{"pane_id": "P:new"})

		// a failed close is reported, not swallowed: the agent may still be running
		stuck := fake(startResponse("P:new", "claude"), obj{"pane.close": herdrError("pane_not_found")})
		_, err = startAgent(stuck.rpc, profiles, StartAgentInput{Profile: "claude", Cwd: "/p"}, verify)
		wantErr(t, err, `wrong account: P:new: its pane P:new could not be closed \(pane_not_found\), so it may still be running`)

		// the agent has run by then and may have written to its worktree: it is stopped,
		// the checkout kept (never removed, forced or not), and the error says where
		wt := fake(startResponse("w1:t1:p1", "claude"), worktreeCreateResponse("/wt/new", "wNEW", "feat/x", "wNEW:p1"))
		_, err = startAgent(wt.rpc, profiles, StartAgentInput{Profile: "claude", Worktree: &CreateWorktreeInput{Repo: "/proj"}}, verify)
		wantStatus(t, err, 409)
		wantErr(t, err, `wrong account: wNEW:p1: it was stopped; its worktree /wt/new was kept`)
		eq(t, wt.find("pane.close"), obj{"pane_id": "wNEW:p1"})
		eq(t, wt.count("worktree.remove"), 0)

		ok := fake(startResponse("P:ok", "claude"))
		checked := ""
		if _, err := startAgent(ok.rpc, profiles, StartAgentInput{Profile: "claude"}, StartAgentOptions{Verify: func(id string) error { checked = id; return nil }}); err != nil {
			t.Fatal(err)
		}
		eq(t, checked, "P:ok")
		eq(t, ok.count("pane.close"), 0)
	})

	// ── stopAgent ────────────────────────────────────────────────────────────

	t.Run("stopAgent: closes the pane", func(t *testing.T) {
		f := fake()
		out, err := stopAgent(f.rpc, "w:t:p")
		if err != nil {
			t.Fatal(err)
		}
		eq(t, f.calls, []lifecycleCall{{"pane.close", obj{"pane_id": "w:t:p"}}})
		jsonEq(t, out, `{"paneId":"w:t:p"}`)
	})

	// ── renameAgent ──────────────────────────────────────────────────────────

	t.Run("renameAgent: renames via agent.rename with target + a herdr-valid name", func(t *testing.T) {
		f := fake()
		out, err := renameAgent(f.rpc, "w:t:p", "  New name  ")
		if err != nil {
			t.Fatal(err)
		}
		eq(t, f.calls, []lifecycleCall{{"agent.rename", obj{"target": "w:t:p", "name": "new-name"}}})
		jsonEq(t, out, `{"name":"new-name"}`)
	})

	t.Run("renameAgent: an empty, non-string or letterless name is a 400", func(t *testing.T) {
		f := fake()
		for _, bad := range []any{"", "   ", 5.0, nil, "日本"} {
			_, err := renameAgent(f.rpc, "w:t:p", bad)
			wantStatus(t, err, 400)
		}
		eq(t, len(f.calls), 0)
	})

	// ── clearAgent ───────────────────────────────────────────────────────────

	agentGetResponse := func(agent, paneID, cwd, wsID string) obj {
		return obj{"agent.get": obj{"agent": obj{"pane_id": paneID, "name": "orig", "agent": agent, "cwd": cwd, "foreground_cwd": cwd, "workspace_id": wsID}}}
	}
	// The replacement's shell is a split of the old pane; agent.start launches into it.
	replacement := func(paneID string) obj {
		return obj{
			"pane.split": obj{"type": "pane_info", "pane": obj{"pane_id": paneID}},
			"agent.start": func(p obj) (any, error) {
				return obj{"type": "agent_started", "agent": obj{"pane_id": p["pane_id"], "name": p["name"], "agent": p["kind"]},
					"argv": append([]any{p["kind"]}, p["args"].([]any)...)}, nil
			},
		}
	}

	t.Run("clearAgent: splits the old pane at its cwd, starts the replacement there, then closes the old pane", func(t *testing.T) {
		f := fake(agentGetResponse("claude", "old:pane", "/home/u/proj", "wOLD"), replacement("new:pane"))
		out, err := clearAgent(f.rpc, profiles, "old:pane", nil, ClearAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, f.methods(), []string{"agent.get", "pane.split", "agent.start", "pane.close"})
		eq(t, f.calls[1].params, obj{"target_pane_id": "old:pane", "direction": "right", "focus": false, "cwd": "/home/u/proj"})
		eq(t, f.calls[2].params["kind"], "claude")
		eq(t, f.calls[2].params["pane_id"], "new:pane")
		eq(t, f.calls[3].params, obj{"pane_id": "old:pane"})
		eq(t, out.PaneID, "new:pane")
		eq(t, out.ClosedOld, true)
	})

	t.Run("clearAgent: the replacement pane gets the env envFor gives for the old pane (none when it gives none)", func(t *testing.T) {
		clear := func(t *testing.T, env map[string]string) obj {
			f := fake(obj{
				"agent.get":   obj{"agent": obj{"pane_id": "P:old", "agent": "claude", "cwd": "/orch"}},
				"pane.split":  obj{"pane": obj{"pane_id": "P:new"}},
				"agent.start": obj{"agent": obj{"pane_id": "P:new"}},
			})
			asked := ""
			if _, err := clearAgent(f.rpc, profiles, "orch", nil, ClearAgentOptions{EnvFor: func(p string) (map[string]string, error) { asked = p; return env, nil }}); err != nil {
				t.Fatal(err)
			}
			eq(t, asked, "P:old")
			return f.find("pane.split")
		}
		eq(t, clear(t, map[string]string{"CLAUDE_CONFIG_DIR": "/c/work"})["env"], obj{"CLAUDE_CONFIG_DIR": "/c/work"})
		if _, ok := clear(t, nil)["env"]; ok {
			t.Error("no env when envFor gives none")
		}
	})

	t.Run("clearAgent: an envFor that throws refuses the clear before anything opens; a failing verify keeps the old agent", func(t *testing.T) {
		responses := obj{
			"agent.get":   obj{"agent": obj{"pane_id": "P:old", "agent": "claude", "cwd": "/orch"}},
			"pane.split":  obj{"pane": obj{"pane_id": "P:new"}},
			"agent.start": obj{"agent": obj{"pane_id": "P:new"}},
		}
		refused := fake(responses)
		_, err := clearAgent(refused.rpc, profiles, "orch", nil, ClearAgentOptions{EnvFor: func(string) (map[string]string, error) { return nil, errors.New("account unknown") }})
		wantErr(t, err, `account unknown`)
		eq(t, refused.methods(), []string{"agent.get"})

		wrongAccount := ClearAgentOptions{Verify: func(string) error { return errors.New("wrong account") }}
		kept := fake(responses)
		_, err = clearAgent(kept.rpc, profiles, "orch", nil, wrongAccount)
		wantErr(t, err, `wrong account; the old agent was kept \(the new one: it was stopped\)`)
		closed := []any{}
		for _, c := range kept.calls {
			if c.method == "pane.close" {
				closed = append(closed, c.params["pane_id"])
			}
		}
		eq(t, closed, []any{"P:new"})

		// a replacement that can't be stopped is reported, not swallowed
		stuck := fake(responses, obj{"pane.close": herdrError("pane_not_found")})
		_, err = clearAgent(stuck.rpc, profiles, "orch", nil, wrongAccount)
		wantErr(t, err, `its pane P:new could not be closed \(pane_not_found\), so it may still be running`)
	})

	t.Run("clearAgent: relaunches in the launch cwd, not a wandered foreground cwd", func(t *testing.T) {
		f := fake(obj{
			"agent.get": obj{"agent": obj{"pane_id": "old:pane", "name": "orig", "agent": "claude", "cwd": "/home/u/orch", "foreground_cwd": "/tmp", "workspace_id": "wOLD"}},
		}, replacement("new:pane"))
		if _, err := clearAgent(f.rpc, profiles, "old:pane", nil, ClearAgentOptions{}); err != nil {
			t.Fatal(err)
		}
		eq(t, f.find("pane.split")["cwd"], "/home/u/orch")
	})

	t.Run("clearAgent: an agent whose type matches no profile is a LifecycleError, nothing opened", func(t *testing.T) {
		f := fake(agentGetResponse("some-unknown-agent", "old:pane", "/home/u/proj", "wOLD"))
		_, err := clearAgent(f.rpc, profiles, "old:pane", nil, ClearAgentOptions{})
		var le *LifecycleError
		if !errors.As(err, &le) {
			t.Errorf("want a LifecycleError, got %#v", err)
		}
		eq(t, f.methods(), []string{"agent.get"}) // must not open or start a replacement
	})

	t.Run("clearAgent: a failed replacement start closes the split, and keeps the old pane", func(t *testing.T) {
		f := fake(agentGetResponse("claude", "old:pane", "/home/u/proj", "wOLD"), replacement("new:pane"), obj{"agent.start": errors.New("boom")})
		_, err := clearAgent(f.rpc, profiles, "old:pane", nil, ClearAgentOptions{})
		wantErr(t, err, `boom`)
		closes := []map[string]any{}
		for _, c := range f.calls {
			if c.method == "pane.close" {
				closes = append(closes, c.params)
			}
		}
		eq(t, closes, []map[string]any{{"pane_id": "new:pane"}})
	})

	t.Run("clearAgent: a failed old-pane close is non-fatal but reported", func(t *testing.T) {
		f := fake(agentGetResponse("claude", "old:pane", "/home/u/proj", "wOLD"), replacement("new:pane"), obj{"pane.close": errors.New("gone")})
		out, err := clearAgent(f.rpc, profiles, "old:pane", nil, ClearAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, out.PaneID, "new:pane")
		eq(t, out.ClosedOld, false)
	})

	t.Run("clearAgent: a recorded preferred profile is reused over type inference (keeps a custom variant's args)", func(t *testing.T) {
		// herdr detects the agent type as "claude", but it was started from a custom
		// variant: inference would drop the extra flag; the preferred profile must win.
		profiles := parseLaunchProfiles(fromJSON(t, `{"claude-yolo": {"argv": ["claude", "--dangerously-skip-permissions"], "label": "yolo"}}`))
		f := fake(agentGetResponse("claude", "old:pane", "/home/u/proj", "wOLD"), replacement("new:pane"))
		out, err := clearAgent(f.rpc, profiles, "old:pane", func(pid string) string {
			if pid == "old:pane" {
				return "claude-yolo"
			}
			return ""
		}, ClearAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		start := f.find("agent.start")
		eq(t, start["kind"], "claude")
		eq(t, start["args"], []any{"--dangerously-skip-permissions"})
		eq(t, out.Profile, "claude-yolo")
		eq(t, out.OldPaneID, "old:pane")
	})

	t.Run("clearAgent: an unknown preferred profile falls back to type inference", func(t *testing.T) {
		f := fake(agentGetResponse("claude", "old:pane", "/home/u/proj", "wOLD"), replacement("new:pane"))
		out, err := clearAgent(f.rpc, profiles, "old:pane", func(string) string { return "ghost-profile" }, ClearAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, out.Profile, "claude") // inferred from the detected type
	})

	t.Run("clearAgent: looks up the profile + reports oldPaneId by the RESOLVED pane id when target is a name", func(t *testing.T) {
		profiles := parseLaunchProfiles(fromJSON(t, `{"claude-yolo": {"argv": ["claude", "--danger"], "label": "y"}}`))
		// target is an agent NAME; agent.get resolves it to a different pane id.
		f := fake(obj{
			"agent.get": obj{"agent": obj{"pane_id": "resolved:pane", "name": "myagent", "agent": "claude", "cwd": "/w", "foreground_cwd": "/w"}},
		}, replacement("new:pane"))
		seen := []string{}
		out, err := clearAgent(f.rpc, profiles, "myagent", func(pid string) string {
			seen = append(seen, pid)
			if pid == "resolved:pane" {
				return "claude-yolo"
			}
			return ""
		}, ClearAgentOptions{})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, seen, []string{"resolved:pane"}) // keyed by the resolved pane id, not the "myagent" target
		eq(t, out.OldPaneID, "resolved:pane")
		eq(t, f.find("pane.split")["target_pane_id"], "resolved:pane")
		eq(t, f.find("agent.start")["args"], []any{"--danger"})
		eq(t, f.find("pane.close"), obj{"pane_id": "resolved:pane"})
	})

	// ── createWorktree ───────────────────────────────────────────────────────

	t.Run("createWorktree: requires a repo (cwd) or workspace, else 400", func(t *testing.T) {
		f := fake(worktreeCreateResponse("/home/u/.herdr/wt/x", "w9", "feat/x", "w9:p1"))
		for _, bad := range []CreateWorktreeInput{{}, {Repo: 5.0}, {Repo: "/r", Branch: 5.0}} {
			_, err := createWorktree(f.rpc, bad)
			wantStatus(t, err, 400)
		}
		eq(t, len(f.calls), 0)
	})

	t.Run("createWorktree: builds worktree.create with cwd/branch/base and returns the new worktree", func(t *testing.T) {
		f := fake(worktreeCreateResponse("/home/u/.herdr/wt/feat", "wNEW", "feat/task", "wNEW:p1"))
		out, err := createWorktree(f.rpc, CreateWorktreeInput{Repo: "/home/u/proj", Branch: "  feat/task  ", Base: "origin/main"})
		if err != nil {
			t.Fatal(err)
		}
		eq(t, f.calls[0].method, "worktree.create")
		eq(t, f.calls[0].params, obj{"focus": false, "cwd": "/home/u/proj", "branch": "feat/task", "base": "origin/main"})
		jsonEq(t, out, `{"workspaceId":"wNEW","checkoutPath":"/home/u/.herdr/wt/feat","branch":"feat/task","paneId":"wNEW:p1"}`)
	})

	t.Run("checkoutInUse: an agent in the worktree's workspace, or in its checkout from another workspace", func(t *testing.T) {
		dir := "/src/repo-wt-x"
		pane := func(workspaceID, cwd, agent, foregroundCwd string) RawPane {
			return RawPane{WorkspaceID: workspaceID, Cwd: cwd, Agent: agent, ForegroundCwd: foregroundCwd}
		}
		eq(t, checkoutInUse([]RawPane{pane("wWT", "/elsewhere", "claude", "")}, "wWT", dir), true)                         // its own workspace, whatever the cwd
		eq(t, checkoutInUse([]RawPane{pane("wO", dir, "claude", "")}, "wWT", dir), true)                                   // launched in it from another workspace
		eq(t, checkoutInUse([]RawPane{pane("wO", "/src/repo", "claude", dir+"/sub")}, "wWT", dir), true)                   // wandered into it
		eq(t, checkoutInUse([]RawPane{pane("wO", dir, "", ""), pane("wWT", dir, "", "")}, "wWT", dir), false)              // shells only
		eq(t, checkoutInUse([]RawPane{pane("wO", "/src/repo-wt-xy", "claude", ""), pane("wO", "/src/repo", "claude", "")}, // a sibling sharing the prefix, the main checkout
			"wWT", dir), false)
	})

	t.Run("createWorktree: passes a checkout path through, and rejects a blank one", func(t *testing.T) {
		f := fake(worktreeCreateResponse("/home/u/.herdr/wt/x", "w9", "feat/x", "w9:p1"))
		if _, err := createWorktree(f.rpc, CreateWorktreeInput{Repo: "/src/org/repo", Branch: "feat/x", Path: "/src/org/repo-wt-feat-x"}); err != nil {
			t.Fatal(err)
		}
		eq(t, f.calls[0].params["path"], "/src/org/repo-wt-feat-x")
		_, err := createWorktree(f.rpc, CreateWorktreeInput{Repo: "/r", Path: ""})
		wantStatus(t, err, 400)
	})

	t.Run("createWorktree: a blank branch/base is omitted (herdr auto-generates)", func(t *testing.T) {
		f := fake(worktreeCreateResponse("/home/u/.herdr/wt/x", "w9", "feat/x", "w9:p1"))
		if _, err := createWorktree(f.rpc, CreateWorktreeInput{Workspace: "w7", Branch: "   ", Base: ""}); err != nil {
			t.Fatal(err)
		}
		eq(t, f.calls[0].params, obj{"focus": false, "workspace_id": "w7"})
	})

	t.Run("createWorktree: a missing checkout path is a 502", func(t *testing.T) {
		f := fake(obj{"worktree.create": obj{"type": "worktree_created", "worktree": obj{}, "workspace": obj{"workspace_id": "w9"}}})
		_, err := createWorktree(f.rpc, CreateWorktreeInput{Repo: "/r"})
		wantStatus(t, err, 502)
	})
}
