package bridge

// A port of server/test/state.test.ts: subtest paths are its describe › it names.

import (
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// makeSnapshot is a minimal snapshot matching the real herdr API shape observed in
// live testing. Tests change fields on the copy it returns (the TS overrides).
func makeSnapshot() RawSnapshot {
	return RawSnapshot{
		Version:            "0.7.3",
		Protocol:           16,
		FocusedWorkspaceID: "w0",
		FocusedTabID:       "w0:t1",
		FocusedPaneID:      "w0:p1",
		Workspaces:         []RawWorkspace{{WorkspaceID: "w0", Label: "herdr", ActiveTabID: "w0:t1"}},
		Tabs:               []RawTab{{TabID: "w0:t1", WorkspaceID: "w0", Label: json.RawMessage(`"1"`)}},
		Panes: []RawPane{
			{
				PaneID: "w0:p1", WorkspaceID: "w0", TabID: "w0:t1", Focused: true,
				Agent: "claude", AgentStatus: "working",
				Cwd: "/home/user/proj", ForegroundCwd: "/home/user/proj",
			},
			{
				PaneID: "w0:p2", WorkspaceID: "w0", TabID: "w0:t1", Focused: false,
				AgentStatus: "unknown",
				Cwd:         "/home/user/proj", ForegroundCwd: "/home/user/proj",
			},
		},
	}
}

func checkEq[T comparable](t *testing.T, got, want T) {
	t.Helper()
	if got != want {
		t.Errorf("got %v, want %v", got, want)
	}
}

// valOf is *p, or the zero value for nil.
func valOf[T any](p *T) (v T) {
	if p != nil {
		v = *p
	}
	return v
}

func int64p(v int64) *int64 { return &v }

// jsonOf is v as the web UI receives it.
func jsonOf(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// deepCopyState copies s and every node reachable from it, indexes included (all
// their fields are JSON fields), for reflect.DeepEqual to show what a call modified.
func deepCopyState(t *testing.T, s *State) *State {
	t.Helper()
	var c State
	for _, f := range []struct{ from, to any }{
		{s, &c}, {s.paneByID, &c.paneByID}, {s.paneOrder, &c.paneOrder}, {s.tabByID, &c.tabByID},
	} {
		if err := json.Unmarshal([]byte(jsonOf(t, f.from)), f.to); err != nil {
			t.Fatal(err)
		}
	}
	return &c
}

func paneIn(panes []*PaneNode, id string) *PaneNode {
	for _, p := range panes {
		if p.PaneID == id {
			return p
		}
	}
	return nil
}

func TestCreateState(t *testing.T) {
	t.Run("createState", func(t *testing.T) {
		t.Run("sets connected=true and copies herdr version/protocol", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			checkEq(t, state.Connected, true)
			checkEq(t, valOf(state.Herdr.Version), "0.7.3")
			checkEq(t, valOf(state.Herdr.Protocol), 16)
		})

		t.Run("sets focused ids from snapshot", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			checkEq(t, valOf(state.Focused.WorkspaceID), "w0")
			checkEq(t, valOf(state.Focused.TabID), "w0:t1")
			checkEq(t, valOf(state.Focused.PaneID), "w0:p1")
		})

		t.Run("builds workspace > tab > pane hierarchy", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			checkEq(t, len(state.Workspaces), 1)
			checkEq(t, state.Workspaces[0].WorkspaceID, "w0")
			checkEq(t, len(state.Workspaces[0].Tabs), 1)
			checkEq(t, state.Workspaces[0].Tabs[0].TabID, "w0:t1")
			checkEq(t, len(state.Workspaces[0].Tabs[0].Panes), 2)
		})

		t.Run("normalizes pane with agent info", func(t *testing.T) {
			state := createState(makeSnapshot(), 1000, nil)
			pane := state.Workspaces[0].Tabs[0].Panes[0]
			checkEq(t, pane.PaneID, "w0:p1")
			checkEq(t, pane.Focused, true)
			checkEq(t, valOf(pane.Agent.Name), "claude")
			checkEq(t, pane.Agent.Status, "working")
			checkEq(t, pane.Agent.SinceUnixMs, 1000)
		})

		t.Run("sets agent=null for panes without an agent field", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			pane := state.Workspaces[0].Tabs[0].Panes[1]
			checkEq(t, pane.PaneID, "w0:p2")
			checkEq(t, pane.Agent, nil)
		})

		t.Run("tolerates missing optional fields in snapshot", func(t *testing.T) {
			minimal := RawSnapshot{Panes: []RawPane{}, Tabs: []RawTab{}, Workspaces: []RawWorkspace{}}
			state := createState(minimal, nowMs(), nil)
			checkEq(t, state.Connected, true)
			checkEq(t, len(state.Workspaces), 0)
			if state.Workspaces == nil {
				t.Error("workspaces is null, want []") // TS's .length needs an array
			}
		})

		t.Run("returns all pane ids via getPaneIds", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			ids := state.PaneIDs()
			slices.Sort(ids)
			if !slices.Equal(ids, []string{"w0:p1", "w0:p2"}) {
				t.Errorf("got %v", ids)
			}
		})
	})
}

func TestCreateStateWorktree(t *testing.T) {
	t.Run("createState - worktree", func(t *testing.T) {
		wtMain := RawWorktree{
			RepoKey:          "/home/u/repo/.git",
			RepoName:         "repo",
			RepoRoot:         "/home/u/repo",
			CheckoutPath:     "/home/u/repo",
			IsLinkedWorktree: new(bool),
		}

		t.Run("maps the worktree object into normalized WorkspaceNode.worktree", func(t *testing.T) {
			snap := makeSnapshot()
			snap.Workspaces = []RawWorkspace{{WorkspaceID: "w0", Label: "repo", ActiveTabID: "w0:t1", Worktree: &wtMain}}
			state := createState(snap, nowMs(), nil)
			want := &WorktreeInfo{
				RepoKey:          "/home/u/repo/.git",
				RepoName:         "repo",
				RepoRoot:         "/home/u/repo",
				CheckoutPath:     "/home/u/repo",
				IsLinkedWorktree: false,
				Branch:           nil,
			}
			if got := state.Workspaces[0].Worktree; !reflect.DeepEqual(got, want) {
				t.Errorf("got %+v, want %+v", got, want)
			}
		})

		t.Run("flags a linked worktree", func(t *testing.T) {
			wt := wtMain
			wt.CheckoutPath = "/home/u/.herdr/worktrees/repo/feat-x"
			linked := true
			wt.IsLinkedWorktree = &linked
			snap := makeSnapshot()
			snap.Workspaces = []RawWorkspace{{WorkspaceID: "w0", Label: "feat-x", ActiveTabID: "w0:t1", Worktree: &wt}}
			state := createState(snap, nowMs(), nil)
			checkEq(t, state.Workspaces[0].Worktree.IsLinkedWorktree, true)
			checkEq(t, state.Workspaces[0].Worktree.RepoKey, "/home/u/repo/.git")
		})

		t.Run("sets worktree=null when the workspace has no worktree field", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			checkEq(t, state.Workspaces[0].Worktree, nil)
		})

		t.Run("sets worktree=null when worktree is present but repo_key is missing", func(t *testing.T) {
			snap := makeSnapshot()
			snap.Workspaces = []RawWorkspace{{WorkspaceID: "w0", Label: "repo", ActiveTabID: "w0:t1", Worktree: &RawWorktree{RepoName: "repo"}}}
			state := createState(snap, nowMs(), nil)
			checkEq(t, state.Workspaces[0].Worktree, nil)
		})

		t.Run("preserves worktree across workspace_renamed", func(t *testing.T) {
			snap := makeSnapshot()
			snap.Workspaces = []RawWorkspace{{WorkspaceID: "w0", Label: "repo", ActiveTabID: "w0:t1", Worktree: &wtMain}}
			state := createState(snap, nowMs(), nil)
			next, _ := applyEvent(state, "workspace_renamed", map[string]any{"workspace_id": "w0", "label": "renamed"}, nowMs())
			checkEq(t, next.Workspaces[0].Label, "renamed")
			checkEq(t, next.Workspaces[0].Worktree.RepoKey, "/home/u/repo/.git")
		})
	})
}

// onlyChange is the single change in changes.
func onlyChange(t *testing.T, changes []StatusChange) StatusChange {
	t.Helper()
	if len(changes) != 1 {
		t.Fatalf("got %d changes, want 1", len(changes))
	}
	return changes[0]
}

func TestApplyEventPaneAgentStatusChanged(t *testing.T) {
	t.Run("applyEvent - pane_agent_status_changed", func(t *testing.T) {
		t.Run("updates agent status and returns a change record", func(t *testing.T) {
			state := createState(makeSnapshot(), 1000, nil)
			next, changes := applyEvent(state, "pane_agent_status_changed",
				map[string]any{"pane_id": "w0:p1", "agent_status": "idle"}, 2000)
			c := onlyChange(t, changes)
			checkEq(t, c.PaneID, "w0:p1")
			checkEq(t, c.From, "working")
			checkEq(t, c.To, "idle")
			checkEq(t, c.Agent.SinceUnixMs, 2000)

			pane := next.Workspaces[0].Tabs[0].Panes[0]
			checkEq(t, pane.Agent.Status, "idle")
		})

		t.Run("returns no changes when status is unchanged", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			_, changes := applyEvent(state, "pane_agent_status_changed",
				map[string]any{"pane_id": "w0:p1", "agent_status": "working"}, nowMs())
			checkEq(t, len(changes), 0)
		})

		t.Run("is a no-op for unknown pane id", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			_, changes := applyEvent(state, "pane_agent_status_changed",
				map[string]any{"pane_id": "w99:p99", "agent_status": "idle"}, nowMs())
			checkEq(t, len(changes), 0)
		})

		t.Run("handles pane with no prior agent field", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			next, changes := applyEvent(state, "pane_agent_status_changed",
				map[string]any{"pane_id": "w0:p2", "agent_status": "working"}, 3000)
			c := onlyChange(t, changes)
			checkEq(t, c.From, "unknown")
			checkEq(t, c.To, "working")
			pane := next.Workspaces[0].Tabs[0].Panes[1]
			checkEq(t, pane.Agent.Status, "working")
		})

		t.Run("merges agent/display_agent/custom_status/title from event payload", func(t *testing.T) {
			state := createState(makeSnapshot(), 1000, nil)
			next, changes := applyEvent(state, "pane_agent_status_changed", map[string]any{
				"pane_id":       "w0:p1",
				"agent_status":  "idle",
				"agent":         "codex",
				"display_agent": "Codex: auth",
				"custom_status": "waiting",
				"title":         "new title",
			}, 4000)
			agent := onlyChange(t, changes).Agent
			checkEq(t, valOf(agent.Name), "codex")
			checkEq(t, valOf(agent.DisplayName), "Codex: auth")
			checkEq(t, valOf(agent.CustomStatus), "waiting")
			checkEq(t, agent.Status, "idle")
			checkEq(t, agent.SinceUnixMs, 4000)
			pane := next.Workspaces[0].Tabs[0].Panes[0]
			checkEq(t, valOf(pane.Title), "new title")
		})

		t.Run("falls back to agent field when display_agent absent", func(t *testing.T) {
			state := createState(makeSnapshot(), 1000, nil)
			_, changes := applyEvent(state, "pane_agent_status_changed",
				map[string]any{"pane_id": "w0:p1", "agent_status": "idle", "agent": "codex"}, 5000)
			agent := onlyChange(t, changes).Agent
			checkEq(t, valOf(agent.Name), "codex")
			checkEq(t, valOf(agent.DisplayName), "codex")
		})

		t.Run("preserves existing name/displayName when event omits agent fields", func(t *testing.T) {
			state := createState(makeSnapshot(), 1000, nil)
			// first event sets the name
			s2, _ := applyEvent(state, "pane_agent_status_changed",
				map[string]any{"pane_id": "w0:p1", "agent_status": "idle", "agent": "codex", "display_agent": "Codex: auth"}, 2000)
			// second event only changes status, no agent fields
			_, changes := applyEvent(s2, "pane_agent_status_changed",
				map[string]any{"pane_id": "w0:p1", "agent_status": "working"}, 3000)
			agent := onlyChange(t, changes).Agent
			checkEq(t, valOf(agent.Name), "codex")
			checkEq(t, valOf(agent.DisplayName), "Codex: auth")
		})
	})
}

func TestApplyEventPaneFocused(t *testing.T) {
	t.Run("applyEvent - pane_focused", func(t *testing.T) {
		t.Run("updates focused flag and focused pane id", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			next, _ := applyEvent(state, "pane_focused", map[string]any{"pane_id": "w0:p2"}, nowMs())
			checkEq(t, valOf(next.Focused.PaneID), "w0:p2")
			panes := next.Workspaces[0].Tabs[0].Panes
			checkEq(t, paneIn(panes, "w0:p1").Focused, false)
			checkEq(t, paneIn(panes, "w0:p2").Focused, true)
		})
	})
}

func TestApplyEventWorkspaceRenamed(t *testing.T) {
	t.Run("applyEvent - workspace_renamed", func(t *testing.T) {
		t.Run("updates workspace label", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			next, _ := applyEvent(state, "workspace_renamed", map[string]any{"workspace_id": "w0", "label": "renamed"}, nowMs())
			checkEq(t, next.Workspaces[0].Label, "renamed")
		})
	})
}

func TestApplyEventUnknownEvents(t *testing.T) {
	t.Run("applyEvent - unknown events", func(t *testing.T) {
		t.Run("is a no-op for completely unknown event", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			_, changes := applyEvent(state, "some_future_event", map[string]any{}, nowMs())
			checkEq(t, len(changes), 0)
		})
	})
}

func TestToClientState(t *testing.T) {
	t.Run("toClientState", func(t *testing.T) {
		t.Run("strips internal index fields", func(t *testing.T) {
			state := createState(makeSnapshot(), 1000, nil)
			// the client state is the State's JSON (its indexes are unexported)
			got := jsonOf(t, state)
			var client map[string]any
			if err := json.Unmarshal([]byte(got), &client); err != nil {
				t.Fatal(err)
			}
			for _, k := range []string{"_paneById", "_tabById", "paneByID", "paneOrder", "tabByID"} {
				if _, ok := client[k]; ok {
					t.Errorf("client state has %s", k)
				}
			}
			checkEq(t, client["connected"], any(true))
			// beyond the TS test: the whole JSON, as server/state.ts serializes this state
			checkEq(t, got, `{"connected":true,"herdr":{"version":"0.7.3","protocol":16},`+
				`"focused":{"workspaceId":"w0","tabId":"w0:t1","paneId":"w0:p1"},`+
				`"workspaces":[{"workspaceId":"w0","label":"herdr","cwd":"/home/user/proj","worktree":null,`+
				`"tabs":[{"tabId":"w0:t1","label":"1","panes":[`+
				`{"paneId":"w0:p1","focused":true,"cwd":"/home/user/proj","launchCwd":"/home/user/proj","title":null,`+
				`"agent":{"name":"claude","displayName":"claude","status":"working","customStatus":null,"message":null,`+
				`"sinceUnixMs":1000,"completionSeq":null,"stateChangeSeq":null,"herdrName":null}},`+
				`{"paneId":"w0:p2","focused":false,"cwd":"/home/user/proj","launchCwd":"/home/user/proj","title":null,"agent":null}]}]}]}`)
		})
	})
}

func TestFindOrchestrators(t *testing.T) {
	t.Run("findOrchestrators", func(t *testing.T) {
		// one is the pane id (JSON: a string or null) of a single orchestrator in dir
		one := func(t *testing.T, state *State, dir string) string {
			return jsonOf(t, findOrchestrators(state, []OrchestratorDef{{Name: "o", Label: "", Dir: dir}}, nil)[0].PaneID)
		}

		t.Run("is the agent pane running in the orchestrator dir (or below it)", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			checkEq(t, one(t, state, "/home/user/proj"), `"w0:p1"`)
			checkEq(t, one(t, state, "/home/user"), `"w0:p1"`)
		})

		t.Run("ignores non-agent panes, sibling dirs that share a prefix, and a missing dir", func(t *testing.T) {
			state := createState(makeSnapshot(), nowMs(), nil)
			checkEq(t, one(t, state, "/home/user/pro"), "null") // not /home/user/proj
			checkEq(t, one(t, state, "/elsewhere"), "null")
			snap := makeSnapshot()
			snap.Panes = []RawPane{{PaneID: "w0:p2", WorkspaceID: "w0", TabID: "w0:t1", Focused: false, AgentStatus: "unknown", Cwd: "/home/user/proj"}}
			noAgent := createState(snap, nowMs(), nil)
			checkEq(t, one(t, noAgent, "/home/user/proj"), "null")
		})

		t.Run("finds each orchestrator in config order; a pane under nested dirs belongs to the deepest", func(t *testing.T) {
			pane := func(id, cwd string) RawPane {
				return RawPane{PaneID: id, WorkspaceID: "w0", TabID: "w0:t1", Focused: false, Agent: "claude", AgentStatus: "idle", Cwd: cwd}
			}
			snap := makeSnapshot()
			snap.Panes = []RawPane{pane("w0:p1", "/o/work"), pane("w0:p2", "/o"), pane("w0:p3", "/o/work/sub")}
			state := createState(snap, nowMs(), nil)
			views := findOrchestrators(state, []OrchestratorDef{
				{Name: "home", Label: "Home", Dir: "/o"},
				{Name: "work", Label: "Work", Dir: "/o/work"},
				{Name: "off", Label: "", Dir: "/off"},
			}, nil)
			checkEq(t, jsonOf(t, views), `[`+
				`{"name":"home","label":"Home","paneId":"w0:p2","agents":null,"mode":"tui","headless":null,"todos":[]},`+
				`{"name":"work","label":"Work","paneId":"w0:p1","agents":null,"mode":"tui","headless":null,"todos":[]},`+
				`{"name":"off","label":"","paneId":null,"agents":null,"mode":"tui","headless":null,"todos":[]}]`)
			// a headless one never owns a pane: one in its dir goes to the dir above
			views = findOrchestrators(state, []OrchestratorDef{{Name: "home", Dir: "/o"}, {Name: "work", Dir: "/o/work", Mode: "headless"}}, nil)
			if *views[0].PaneID != "w0:p1" || views[1].PaneID != nil || views[1].Mode != "headless" {
				t.Errorf("headless: %s", jsonOf(t, views))
			}
		})

		t.Run("lists the agents of each orchestrator's account; none when its account isn't known", func(t *testing.T) {
			pane := func(id, cwd, agent string) RawPane {
				return RawPane{PaneID: id, WorkspaceID: "w0", TabID: "w0:t1", Focused: false, Agent: agent, AgentStatus: "idle", Cwd: cwd}
			}
			snap := makeSnapshot()
			snap.Panes = []RawPane{pane("w0:p1", "/o/a", "claude"), pane("w0:p2", "/o/b", "claude"), pane("w0:p3", "/r", "claude"),
				pane("w0:p4", "/r", "codex"), pane("w0:p5", "/r", ""), pane("w0:p6", "/r", "claude")}
			state := createState(snap, nowMs(), nil)
			a, b := "A", "B"
			accounts := map[string]*string{"w0:p1": &a, "w0:p2": &b, "w0:p3": &a, "w0:p4": &b, "w0:p5": &a, "w0:p6": nil}
			views := findOrchestrators(state, []OrchestratorDef{
				{Name: "a", Label: "", Dir: "/o/a"},
				{Name: "b", Label: "", Dir: "/o/b"},
			}, accounts)
			var agents [][]string
			for _, v := range views {
				agents = append(agents, v.Agents)
			}
			checkEq(t, jsonOf(t, agents), `[["w0:p1","w0:p3"],["w0:p2","w0:p4"]]`) // p5 has no agent
			// a stopped orchestrator's Home: the agents of the account it would run under
			checkEq(t, jsonOf(t, agentsOfAccount(state, accounts, "B")), `["w0:p2","w0:p4"]`)
			checkEq(t, jsonOf(t, agentsOfAccount(state, accounts, "C")), `[]`)
			checkEq(t, jsonOf(t, findOrchestrators(state, []OrchestratorDef{{Name: "a", Label: "", Dir: "/o/a"}}, map[string]*string{})[0].Agents), "null")
		})

		t.Run("goes by the launch (shell) cwd, not the foreground cwd", func(t *testing.T) {
			snap := makeSnapshot()
			snap.Panes = []RawPane{
				// the orchestrator's foreground process moved out of its dir
				{PaneID: "w0:p1", WorkspaceID: "w0", TabID: "w0:t1", Focused: true, Agent: "claude", AgentStatus: "idle", Cwd: "/orch", ForegroundCwd: "/tmp"},
				// another agent whose foreground process moved into it
				{PaneID: "w0:p2", WorkspaceID: "w0", TabID: "w0:t1", Focused: false, Agent: "claude", AgentStatus: "idle", Cwd: "/repo", ForegroundCwd: "/orch"},
			}
			state := createState(snap, nowMs(), nil)
			checkEq(t, one(t, state, "/orch"), `"w0:p1"`)
		})
	})
}

func TestCreateStateWithPrevState(t *testing.T) {
	t.Run("createState with prevState", func(t *testing.T) {
		t.Run("carries over sinceUnixMs when agent status is unchanged", func(t *testing.T) {
			prev := createState(makeSnapshot(), 1000, nil)
			next := createState(makeSnapshot(), 5000, prev)
			pane := paneIn(next.Workspaces[0].Tabs[0].Panes, "w0:p1")
			checkEq(t, pane.Agent.SinceUnixMs, 1000)
		})

		t.Run("resets sinceUnixMs when agent status changed between snapshots", func(t *testing.T) {
			prev := createState(makeSnapshot(), 1000, nil)
			snap := makeSnapshot()
			snap.Panes[0].AgentStatus = "idle"
			next := createState(snap, 5000, prev)
			pane := paneIn(next.Workspaces[0].Tabs[0].Panes, "w0:p1")
			checkEq(t, pane.Agent.Status, "idle")
			checkEq(t, pane.Agent.SinceUnixMs, 5000)
		})

		t.Run("uses nowMs for panes not present in prevState", func(t *testing.T) {
			prev := createState(makeSnapshot(), 1000, nil)
			snap := makeSnapshot()
			snap.Panes = append(snap.Panes, RawPane{
				PaneID: "w0:p3", WorkspaceID: "w0", TabID: "w0:t1",
				Focused: false, Agent: "codex", AgentStatus: "working", Cwd: "/x",
			})
			next := createState(snap, 5000, prev)
			pane := paneIn(next.Workspaces[0].Tabs[0].Panes, "w0:p3")
			checkEq(t, pane.Agent.SinceUnixMs, 5000)
		})
	})
}

func TestApplyEventDotFormEventNames(t *testing.T) {
	t.Run("applyEvent - dot-form event names", func(t *testing.T) {
		t.Run("handles pane.agent_status_changed (dot form, as herdr sends it)", func(t *testing.T) {
			state := createState(makeSnapshot(), 1000, nil)
			_, changes := applyEvent(state, "pane.agent_status_changed",
				map[string]any{"pane_id": "w0:p1", "workspace_id": "w0", "agent_status": "blocked"}, 2000)
			c := onlyChange(t, changes)
			checkEq(t, c.From, "working")
			checkEq(t, c.To, "blocked")
		})
	})
}

func TestEventRoutingTable(t *testing.T) {
	t.Run("event routing table", func(t *testing.T) {
		// Every lifecycle event the client subscribes to must be either
		// rebuild-triggering or applied by applyEvent: anything else is silently
		// dropped and the phone view drifts.
		t.Run("every subscribed lifecycle event is rebuild-triggering or applied", func(t *testing.T) {
			// The TS test lists the events by hand; this reads what buildSubscriptions subscribes to.
			subs := buildSubscriptions(nil) // no panes: the lifecycle events only
			if len(subs) == 0 {
				t.Fatal("no subscriptions")
			}
			for _, sub := range subs {
				ev := strings.ReplaceAll(sub["type"], ".", "_")
				if !paneSetChangingEvents[ev] && !appliedEvents[ev] {
					t.Errorf("subscribed event '%s' would be silently dropped", ev)
				}
			}
		})

		t.Run("agent status events are applied, not rebuild-triggering", func(t *testing.T) {
			checkEq(t, appliedEvents["pane_agent_status_changed"], true)
			checkEq(t, paneSetChangingEvents["pane_agent_status_changed"], false)
		})
	})
}

func TestApplyEventImmutability(t *testing.T) {
	t.Run("applyEvent immutability", func(t *testing.T) {
		t.Run("does not mutate the input state", func(t *testing.T) {
			s0 := createState(makeSnapshot(), 1000, nil)
			before := deepCopyState(t, s0)
			beforeJSON := jsonOf(t, s0)
			paneBefore := s0.paneByID["w0:p1"]

			applyEvent(s0, "pane_agent_status_changed", map[string]any{"pane_id": "w0:p1", "workspace_id": "w0", "agent_status": "blocked"}, 2000)
			applyEvent(s0, "pane_focused", map[string]any{"pane_id": "w0:p2"}, 2000)
			applyEvent(s0, "tab_renamed", map[string]any{"tab_id": "w0:t1", "label": "renamed"}, 2000)

			checkEq(t, jsonOf(t, s0), beforeJSON)
			if !reflect.DeepEqual(s0, before) {
				t.Error("applyEvent modified its input state")
			}
			checkEq(t, s0.paneByID["w0:p1"], paneBefore)
			checkEq(t, s0.paneByID["w0:p1"].Agent.Status, "working")
			checkEq(t, s0.tabByID["w0:t1"].Label, "1")
		})

		t.Run("returns a state with independent indexes", func(t *testing.T) {
			s0 := createState(makeSnapshot(), 1000, nil)
			before := deepCopyState(t, s0)
			s1, _ := applyEvent(s0, "pane_agent_status_changed",
				map[string]any{"pane_id": "w0:p1", "workspace_id": "w0", "agent_status": "blocked"}, 2000)
			if reflect.ValueOf(s1.paneByID).Pointer() == reflect.ValueOf(s0.paneByID).Pointer() {
				t.Error("paneByID is shared")
			}
			if reflect.ValueOf(s1.tabByID).Pointer() == reflect.ValueOf(s0.tabByID).Pointer() {
				t.Error("tabByID is shared")
			}
			checkEq(t, s1.paneByID["w0:p1"].Agent.Status, "blocked")
			checkEq(t, s0.paneByID["w0:p1"].Agent.Status, "working")
			if !reflect.DeepEqual(s0, before) {
				t.Error("applyEvent modified the older state")
			}
		})
	})
}

func TestApplyCompletionSeqs(t *testing.T) {
	t.Run("applyCompletionSeqs (herdr agent.list completion_seq)", func(t *testing.T) {
		doneSnap := func() RawSnapshot {
			snap := makeSnapshot()
			snap.Panes = []RawPane{{PaneID: "w0:p1", WorkspaceID: "w0", TabID: "w0:t1", Focused: true, Agent: "claude", AgentStatus: "done"}}
			return snap
		}
		reply := func(seq int64, status string) []RawAgentSeqs {
			return []RawAgentSeqs{{PaneID: "w0:p1", AgentStatus: status, CompletionSeq: int64p(seq), StateChangeSeq: int64p(seq + 1)}}
		}
		const later = 2000 // agent.list was requested after the pane's last status change (at 1000)

		t.Run("fills completionSeq where herdr reports the same status, without mutating the input", func(t *testing.T) {
			s0 := createState(doneSnap(), 1000, nil)
			checkEq(t, s0.Pane("w0:p1").Agent.CompletionSeq, nil)
			before := deepCopyState(t, s0)
			s1 := applyCompletionSeqs(s0, reply(42, "done"), later)
			checkEq(t, valOf(s1.Pane("w0:p1").Agent.CompletionSeq), 42)
			checkEq(t, valOf(s1.Workspaces[0].Tabs[0].Panes[0].Agent.CompletionSeq), 42)
			checkEq(t, valOf(s1.Pane("w0:p1").Agent.StateChangeSeq), 43)
			checkEq(t, s0.Pane("w0:p1").Agent.CompletionSeq, nil)
			if !reflect.DeepEqual(s0, before) {
				t.Error("applyCompletionSeqs modified its input state")
			}
		})

		t.Run("ignores a stale reply, and returns the same state when nothing changes", func(t *testing.T) {
			s0 := createState(doneSnap(), 1000, nil)
			checkEq(t, applyCompletionSeqs(s0, reply(7, "working"), later), s0) // status differs
			checkEq(t, applyCompletionSeqs(s0, []RawAgentSeqs{{PaneID: "nope", AgentStatus: "done", CompletionSeq: int64p(7)}}, later), s0)
			// the pane changed status after the request went out (e.g. done -> working -> done):
			// the reply may describe the previous completion
			checkEq(t, applyCompletionSeqs(s0, reply(7, "done"), 1000), s0)
			checkEq(t, applyCompletionSeqs(s0, reply(7, "done"), 500), s0)
			s1 := applyCompletionSeqs(s0, reply(7, "done"), later)
			checkEq(t, applyCompletionSeqs(s1, reply(7, "done"), later), s1)
		})

		t.Run("fills the herdr name whatever the status, keeps it across a re-snapshot and a status change", func(t *testing.T) {
			s0 := createState(doneSnap(), 1000, nil)
			checkEq(t, s0.Pane("w0:p1").Agent.HerdrName, nil)
			named := []RawAgentSeqs{{PaneID: "w0:p1", Name: "w-fix", AgentStatus: "working"}} // a stale status: no seqs, the name all the same
			s1 := applyCompletionSeqs(s0, named, 500)
			checkEq(t, valOf(s1.Pane("w0:p1").Agent.HerdrName), "w-fix")
			checkEq(t, s1.Pane("w0:p1").Agent.CompletionSeq, nil)
			checkEq(t, s0.Pane("w0:p1").Agent.HerdrName, nil)
			checkEq(t, applyCompletionSeqs(s1, named, 500), s1) // the same name: nothing changed
			checkEq(t, valOf(createState(doneSnap(), 3000, s1).Pane("w0:p1").Agent.HerdrName), "w-fix")
			state, _ := applyEvent(s1, "pane_agent_status_changed", map[string]any{"pane_id": "w0:p1", "agent_status": "working"}, nowMs())
			checkEq(t, valOf(state.Pane("w0:p1").Agent.HerdrName), "w-fix")
			renamed := applyCompletionSeqs(s1, []RawAgentSeqs{{PaneID: "w0:p1", Name: "w-fix2", AgentStatus: "done"}}, later)
			checkEq(t, valOf(renamed.Pane("w0:p1").Agent.HerdrName), "w-fix2")
		})

		t.Run("survives a re-snapshot with the same status and clears on a status change", func(t *testing.T) {
			s1 := applyCompletionSeqs(createState(doneSnap(), 1000, nil), reply(42, "done"), later)
			checkEq(t, valOf(createState(doneSnap(), 3000, s1).Pane("w0:p1").Agent.CompletionSeq), 42)
			checkEq(t, valOf(createState(doneSnap(), 3000, s1).Pane("w0:p1").Agent.StateChangeSeq), 43)
			state, _ := applyEvent(s1, "pane_agent_status_changed", map[string]any{"pane_id": "w0:p1", "agent_status": "working"}, nowMs())
			checkEq(t, state.Pane("w0:p1").Agent.CompletionSeq, nil)
			checkEq(t, state.Pane("w0:p1").Agent.StateChangeSeq, nil)
		})
	})
}
