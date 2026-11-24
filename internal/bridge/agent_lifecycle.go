package bridge

// Agent lifecycle orchestration (start / stop / rename / clear / create a worktree),
// a port of server/agent-lifecycle.ts: pure orchestration over an injected herdr
// Rpc, so it is unit-testable with a fake one.
//
// Since herdr 0.8, agent.start no longer spawns a pane: it launches an agent kind
// into an existing idle shell pane, so we open that pane first (tab.create /
// pane.split / worktree.create's root pane):
//   - tab.create  { cwd?, workspace_id?, label?, focus } → { root_pane: { pane_id } }
//   - pane.split  { target_pane_id, direction, cwd?, focus } → { pane: { pane_id } }
//   - agent.start { name, kind, pane_id, args? } → { agent: { pane_id, ... } }
//     (agent_pane_busy while the new pane's shell is still starting)
//   - pane.close  { pane_id }
//   - agent.rename{ target, name }
//   - agent.get   { target } → { agent: { pane_id, agent, cwd, interactive_ready, ... } }
//   - agent.prompt{ target, text }  (agent_not_ready until the agent is interactive)
//
// Agent names must match herdr's ^[a-z][a-z0-9_-]{0,31}$.
//
// Security: agents are launched only from a fixed profile allowlist; a caller never
// supplies raw argv. (The bearer token already grants full pane input ≈ a shell, so
// cwd is not a new privilege, but arbitrary argv would let a caller pick the program.)
//
// Inputs that arrive as decoded JSON are `any`, nil meaning absent (undefined) and
// jsNull a JSON null (read them with jsField), and are type-checked like the
// TypeScript does at runtime.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var defaultLaunchProfiles = map[string]LaunchProfile{
	"claude":   {Argv: []string{"claude"}, Label: "Claude Code"},
	"codex":    {Argv: []string{"codex"}, Label: "Codex"},
	"opencode": {Argv: []string{"opencode"}, Label: "opencode"},
}

// the order of defaultLaunchProfiles in the TypeScript object
var defaultProfileOrder = []string{"claude", "codex", "opencode"}

const (
	// how long to retry agent.start while a just-opened pane's shell is still starting
	shellReadyTimeout = 10 * time.Second
	// how long to wait for a new agent to become interactive (herdr's own `agent
	// start` default timeout)
	agentReadyTimeout = 30 * time.Second
)

const nameRule = "name must contain a letter a-z (agent names use a-z, 0-9, - and _)"

func badRequest(message string) *LifecycleError {
	return &LifecycleError{Status: 400, Code: "invalid_params", Message: message}
}

// ── JavaScript semantics ─────────────────────────────────────────────────────

// jsLower is s.toLowerCase(): Go lowercases İ to a plain i, JavaScript to i plus a
// combining dot.
func jsLower(s string) string { return strings.ToLower(strings.ReplaceAll(s, "\u0130", "i\u0307")) }

// jsNull is a JSON null in a loosely typed input field, where nil means a missing
// field (undefined): the TS checks reject null where they accept undefined.
type jsNullValue struct{}

var jsNull jsNullValue

// jsField is obj[key] for such a field: a present null is jsNull, a missing key nil.
func jsField(obj map[string]any, key string) any {
	if v, ok := obj[key]; ok && v == nil {
		return jsNull
	}
	return obj[key]
}

// jsString is String(v) for a decoded JSON value, nil being undefined.
func jsString(v any) string {
	switch v := v.(type) {
	case nil:
		return "undefined"
	case jsNullValue:
		return "null"
	case string:
		return v
	case bool:
		return strconv.FormatBool(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case []any:
		parts := make([]string, len(v))
		for i, e := range v {
			if e != nil { // null and undefined elements join as ""
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

// ── names ────────────────────────────────────────────────────────────────────

var (
	nonNameChars      = regexp.MustCompile(`[^a-z0-9_-]+`)
	leadingNonLetters = regexp.MustCompile(`^[^a-z]+`)
)

// agentName fits a name to herdr's agent-name rule (^[a-z][a-z0-9_-]{0,31}$):
// lowercase it, join words with "-", drop leading non-letters, cap at 32. It
// returns "" (TS: null) when nothing usable is left (e.g. no a-z at all).
func agentName(value any) string {
	s, ok := value.(string)
	if !ok {
		return ""
	}
	name := leadingNonLetters.ReplaceAllString(nonNameChars.ReplaceAllString(jsLower(s), "-"), "")
	if len(name) > 32 { // ASCII by now
		name = name[:32]
	}
	return strings.TrimRight(name, "-")
}

// autoName is `<profile>-<base36 time>`, trimming the profile part (never the
// unique timestamp) to fit herdr's 32-char limit, so two auto names from a long
// profile key can't collide.
func autoName(profile string) string {
	ts := strconv.FormatInt(time.Now().UnixMilli(), 36)
	base := agentName(profile)
	if base == "" {
		base = "agent"
	}
	if n := 31 - len(ts); len(base) > n {
		base = base[:n]
	}
	return strings.TrimRight(base, "-") + "-" + ts
}

// ── herdr calls ──────────────────────────────────────────────────────────────

// agentFromResult is result.agent when it is an object, else nil.
func agentFromResult(raw json.RawMessage) map[string]any {
	var r struct {
		Agent any `json:"agent"`
	}
	if json.Unmarshal(raw, &r) != nil {
		return nil
	}
	a, _ := r.Agent.(map[string]any)
	return a
}

// launchInPane launches profile into the idle shell pane paneID (agent.start). A
// pane we just opened reports agent_pane_busy until its shell is up, so retry that
// briefly, as `herdr agent start` does.
func launchInPane(rpc Rpc, paneID string, profile LaunchProfile, name string) (map[string]any, error) {
	deadline := time.Now().Add(shellReadyTimeout)
	for {
		raw, err := rpc("agent.start", map[string]any{"name": name, "kind": profile.Argv[0], "pane_id": paneID, "args": profile.Argv[1:]})
		if err == nil {
			return agentFromResult(raw), nil
		}
		if herdrCode(err) != "agent_pane_busy" || !time.Now().Before(deadline) {
			return nil, err
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// stopStarted stops a launched agent by closing its pane, and says how that went: a
// failed close must be told, since the agent may then still be running.
func stopStarted(rpc Rpc, paneID string) string {
	if _, err := rpc("pane.close", map[string]any{"pane_id": paneID}); err != nil {
		return fmt.Sprintf("its pane %s could not be closed (%s), so it may still be running", paneID, err.Error())
	}
	return "it was stopped"
}

// waitForDetectedAgent waits until herdr detects the agent in paneID. agent.start
// answers once the command is typed into the shell, so until then the pane's
// foreground is still the shell (or its fork) and its environment not yet the agent's.
func waitForDetectedAgent(rpc Rpc, paneID string) error {
	end := time.Now().Add(agentReadyTimeout)
	for {
		raw, err := rpc("agent.get", map[string]any{"target": paneID})
		if detected, _ := str(agentFromResult(raw), "agent"); err == nil && detected != "" {
			return nil
		}
		if time.Now().After(end) {
			return &LifecycleError{Status: 504, Code: "not_detected",
				Message: fmt.Sprintf("the agent did not come up within %vs", agentReadyTimeout.Seconds())}
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// closeQuietly closes a pane we opened (rollback); it never fails, so it can't mask
// the error the caller is about to see.
func closeQuietly(rpc Rpc, paneID string) {
	if paneID != "" {
		rpc("pane.close", map[string]any{"pane_id": paneID})
	}
}

// deliverTask sends a new agent its first prompt. agent.prompt refuses an agent that
// is still launching (agent_not_ready), so wait until herdr reports it interactive.
func deliverTask(rpc Rpc, paneID, text string) bool {
	deadline := time.Now().Add(agentReadyTimeout)
	for {
		raw, err := rpc("agent.get", map[string]any{"target": paneID})
		if err != nil {
			return false
		}
		agent := agentFromResult(raw)
		if agent["interactive_ready"] == true {
			break
		}
		// blocked on a startup dialog: it won't become ready without the user
		if agent["agent_status"] == "blocked" || !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(250 * time.Millisecond)
	}
	_, err := rpc("agent.prompt", map[string]any{"target": paneID, "text": text})
	return err == nil
}

// ── launch profiles ──────────────────────────────────────────────────────────

// normalizeProfile validates one config launch-profile entry.
func normalizeProfile(key string, raw any) (LaunchProfile, bool) {
	entry, ok := raw.(map[string]any)
	if !ok {
		return LaunchProfile{}, false
	}
	list, ok := entry["argv"].([]any)
	if !ok || len(list) == 0 {
		return LaunchProfile{}, false
	}
	argv := make([]string, len(list))
	for i, a := range list {
		if argv[i], ok = a.(string); !ok {
			return LaunchProfile{}, false
		}
	}
	label := key
	if s, ok := entry["label"].(string); ok && jsTrim(s) != "" {
		label = s
	}
	return LaunchProfile{Argv: argv, Label: label}, true
}

// parseLaunchProfiles merges config.json `launch_profiles` over the built-in
// defaults. A well-formed entry (non-empty string argv) is added or overrides a
// default; malformed entries are dropped, so a bad config never removes the defaults.
func parseLaunchProfiles(raw any) map[string]LaunchProfile {
	merged := make(map[string]LaunchProfile, len(defaultLaunchProfiles))
	for k, v := range defaultLaunchProfiles {
		merged[k] = v
	}
	entries, _ := raw.(map[string]any)
	for key, value := range entries {
		// prototype-chain names: TS skips them so they can't corrupt its object; skipped
		// here too so the same profiles exist
		if key == "__proto__" || key == "constructor" || key == "prototype" {
			continue
		}
		if profile, ok := normalizeProfile(key, value); ok {
			merged[key] = profile
		}
	}
	return merged
}

// ── start ────────────────────────────────────────────────────────────────────

// StartAgentInput is what to start. Profile, Cwd, Name, Workspace and Task are
// decoded JSON (nil = absent), checked like the TypeScript does.
type StartAgentInput struct {
	Profile, Cwd, Name, Workspace, Task any
	// create a worktree first and launch the agent inside it (rolled back if the agent
	// fails to start, so the client never sees a dangling worktree)
	Worktree *CreateWorktreeInput
	// open a new workspace at cwd instead of a tab in Workspace (or the focused one)
	NewWorkspace bool
	// environment for the new tab/workspace's shell, and so the agent (not for a
	// worktree); nil = none, an empty map is still sent
	Env map[string]string
}

type StartAgentOptions struct {
	// runs once the agent is up; an error stops it (closes its pane) and is returned.
	// A new worktree is kept then: the agent may already have written to it.
	Verify func(paneID string) error
}

type StartAgentResult struct {
	PaneID string  `json:"paneId"`
	Name   string  `json:"name"`
	Agent  *string `json:"agent"`
	// present only when a task field was supplied
	TaskDelivered *bool `json:"taskDelivered,omitempty"`
}

func startAgent(rpc Rpc, profiles map[string]LaunchProfile, in StartAgentInput, opts StartAgentOptions) (StartAgentResult, error) {
	key, isString := in.Profile.(string)
	profile, known := profiles[key]
	if !isString || !known {
		return StartAgentResult{}, badRequest("unknown profile: " + jsString(in.Profile))
	}
	if _, ok := in.Name.(string); in.Name != nil && !ok {
		return StartAgentResult{}, badRequest("name must be a string")
	}
	if s, ok := in.Cwd.(string); in.Cwd != nil && (!ok || s == "") {
		return StartAgentResult{}, badRequest("cwd must be a non-empty string")
	}
	if _, ok := in.Workspace.(string); in.Workspace != nil && !ok {
		return StartAgentResult{}, badRequest("workspace must be a string")
	}
	if _, ok := in.Task.(string); in.Task != nil && !ok {
		return StartAgentResult{}, badRequest("task must be a string")
	}

	name := ""
	if s, _ := in.Name.(string); jsTrim(s) != "" {
		if name = agentName(s); name == "" {
			return StartAgentResult{}, badRequest(nameRule)
		}
	}
	if name == "" {
		name = autoName(key)
	}

	// Open the shell pane the agent launches into: a worktree spec creates a fresh
	// worktree and uses its root pane; otherwise a new tab (labelled with the agent
	// name) at cwd, in the requested workspace. If the agent then fails to start we
	// undo that (best-effort), so the caller never has to clean up a dangling tab or
	// worktree, or hit "branch already exists" on retry.
	var paneID string
	// undoes what was opened; once the agent was launched (a failed verify) it says
	// what became of the agent and what was left behind, for the error ("" = nothing)
	var rollback func(launched bool) string
	if in.Worktree != nil {
		wt, err := createWorktree(rpc, *in.Worktree)
		if err != nil {
			return StartAgentResult{}, err
		}
		if wt.PaneID != nil {
			paneID = *wt.PaneID
		}
		rollback = func(launched bool) string {
			if !launched {
				rollbackWorktree(rpc, wt.WorkspaceID)
				return ""
			}
			// the agent has run and may have written files (it could still be writing
			// during any cleanliness check), so stop it and keep the checkout
			return stopStarted(rpc, paneID) + "; its worktree " + wt.CheckoutPath + " was kept"
		}
	} else {
		params := map[string]any{"label": name, "focus": false}
		if cwd, ok := in.Cwd.(string); ok {
			params["cwd"] = cwd
		}
		if in.Env != nil {
			params["env"] = in.Env
		}
		var raw json.RawMessage
		var err error
		if workspace, _ := in.Workspace.(string); in.NewWorkspace {
			// herdr labels a new workspace after its dir
			wsParams := map[string]any{"focus": false}
			for _, k := range []string{"cwd", "env"} {
				if v, ok := params[k]; ok {
					wsParams[k] = v
				}
			}
			raw, err = rpc("workspace.create", wsParams)
		} else if workspace != "" {
			params["workspace_id"] = workspace
			raw, err = rpc("tab.create", params)
		} else {
			raw, err = rpc("tab.create", params)
			// herdr has no workspace to put the tab in (all closed): open a workspace
			// instead, as agent.start itself did before herdr 0.8
			if herdrCode(err) == "workspace_not_found" {
				raw, err = rpc("workspace.create", params)
			}
		}
		if err != nil {
			return StartAgentResult{}, err
		}
		var opened struct {
			RootPane struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
		}
		json.Unmarshal(raw, &opened)
		paneID = opened.RootPane.PaneID
		rollback = func(launched bool) string {
			if launched {
				return stopStarted(rpc, paneID)
			}
			closeQuietly(rpc, paneID)
			return ""
		}
	}

	var started map[string]any
	launched := false
	err := func() (err error) {
		if paneID == "" {
			return &LifecycleError{Status: 502, Code: "error", Message: "herdr returned no pane to start the agent in"}
		}
		if started, err = launchInPane(rpc, paneID, profile, name); err != nil {
			return err
		}
		launched = true
		if opts.Verify != nil {
			return opts.Verify(paneID)
		}
		return nil
	}()
	if err != nil {
		if undone := rollback(launched); undone != "" {
			return StartAgentResult{}, &LifecycleError{Status: 409, Code: "start_undone", Message: err.Error() + ": " + undone}
		}
		return StartAgentResult{}, err
	}

	result := StartAgentResult{PaneID: paneID, Name: name}
	if agent, ok := str(started, "agent"); ok {
		result.Agent = &agent
	}

	// Best-effort initial task, to the pane id (unambiguous) rather than the name. A
	// failed delivery must not fail the (successful) start. When a task field was
	// supplied, TaskDelivered always reports the outcome (false for an empty task that
	// was skipped), so the client can tell it apart from "no task".
	if task, ok := in.Task.(string); ok {
		delivered := task != "" && deliverTask(rpc, paneID, task)
		result.TaskDelivered = &delivered
	}
	return result, nil
}

// ── stop ─────────────────────────────────────────────────────────────────────

type StopAgentResult struct {
	PaneID string `json:"paneId"`
}

func stopAgent(rpc Rpc, paneID string) (StopAgentResult, error) {
	if _, err := rpc("pane.close", map[string]any{"pane_id": paneID}); err != nil {
		return StopAgentResult{}, err
	}
	return StopAgentResult{PaneID: paneID}, nil
}

// ── rename ───────────────────────────────────────────────────────────────────

type RenameAgentResult struct {
	Name string `json:"name"`
}

func renameAgent(rpc Rpc, target string, name any) (RenameAgentResult, error) {
	clean := agentName(name)
	if clean == "" {
		return RenameAgentResult{}, badRequest(nameRule)
	}
	if _, err := rpc("agent.rename", map[string]any{"target": target, "name": clean}); err != nil {
		return RenameAgentResult{}, err
	}
	return RenameAgentResult{Name: clean}, nil
}

// ── clear (fresh session = launch a replacement, then close the old pane) ─────

type ClearAgentResult struct {
	PaneID    string `json:"paneId"`
	Name      string `json:"name"`
	ClosedOld bool   `json:"closedOld"`
	// the launch profile the replacement was started with (for the bridge to re-record)
	Profile string `json:"profile"`
	// the pane id resolved from the target and closed (the store-cleanup key)
	OldPaneID string `json:"oldPaneId"`
}

type ClearAgentOptions struct {
	// the environment the replacement needs to stay what the old agent was (its
	// Claude account, say); an error refuses the clear before anything is opened
	EnvFor func(oldPaneID string) (map[string]string, error)
	// runs once the replacement is up; an error closes it and keeps the old agent
	Verify func(paneID string) error
}

// profileForAgentType finds the profile whose command matches a herdr-detected agent
// type ("" = none). The fallback scan takes the first match in the TS object's key
// order, which a Go map doesn't keep: the defaults first, then the rest sorted (TS:
// in config.json order).
func profileForAgentType(profiles map[string]LaunchProfile, detected string) string {
	if detected == "" {
		return ""
	}
	if _, ok := profiles[detected]; ok {
		return detected
	}
	var keys, rest []string
	for _, k := range defaultProfileOrder {
		if _, ok := profiles[k]; ok {
			keys = append(keys, k)
		}
	}
	for k := range profiles {
		if _, isDefault := defaultLaunchProfiles[k]; !isDefault {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	lower := jsLower(detected)
	for _, key := range append(keys, rest...) {
		k := jsLower(key)
		if strings.Contains(lower, k) || strings.Contains(k, lower) {
			return key
		}
	}
	return ""
}

// clearAgent replaces the agent target with a fresh one of the same profile, in the
// same place. lookupProfile (may be nil) gives the profile the bridge started a pane
// with ("" = unknown).
func clearAgent(rpc Rpc, profiles map[string]LaunchProfile, target string, lookupProfile func(paneID string) string, opts ClearAgentOptions) (ClearAgentResult, error) {
	raw, err := rpc("agent.get", map[string]any{"target": target})
	if err != nil {
		return ClearAgentResult{}, err
	}
	agent := agentFromResult(raw)
	if agent == nil {
		return ClearAgentResult{}, &LifecycleError{Status: 404, Code: "not_found", Message: "agent not found"}
	}

	// target may be an agent name, not a pane id: resolve to the pane id herdr reports
	// so the profile lookup and later store cleanup key by the right thing
	oldPaneID, _ := str(agent, "pane_id")
	if oldPaneID == "" {
		return ClearAgentResult{}, &LifecycleError{Status: 502, Code: "error", Message: "agent has no pane id"}
	}

	// Prefer the profile this agent was actually started with: inferring from herdr's
	// detected type collapses a custom variant (e.g. "claude-yolo") back onto the base
	// "claude" profile and drops its argv. Fall back to inference for agents the
	// bridge didn't start.
	key := ""
	if lookupProfile != nil {
		key = lookupProfile(oldPaneID)
	}
	if _, ok := profiles[key]; key == "" || !ok {
		detected, _ := str(agent, "agent")
		if key = profileForAgentType(profiles, detected); key == "" {
			v, present := agent["agent"]
			desc := jsString(v)
			if present && v == nil {
				desc = "null"
			}
			return ClearAgentResult{}, &LifecycleError{Status: 422, Code: "no_profile", Message: "no launch profile matches agent type: " + desc}
		}
	}

	// Relaunch where the agent was launched (the shell's cwd), not where its
	// foreground process wandered: the same dir keeps its identity (e.g. the
	// orchestrator, recognized by its launch dir) and its project context.
	launchCwd, _ := str(agent, "cwd")
	foregroundCwd, _ := str(agent, "foreground_cwd")
	cwd := firstNonEmpty(launchCwd, foregroundCwd)

	// Open the replacement's shell as a split of the old pane, so it stays in the old
	// agent's tab/workspace and takes over its slot once the old pane closes.
	splitParams := map[string]any{"target_pane_id": oldPaneID, "direction": "right", "focus": false}
	if cwd != "" {
		splitParams["cwd"] = cwd
	}
	if opts.EnvFor != nil {
		env, err := opts.EnvFor(oldPaneID)
		if err != nil {
			return ClearAgentResult{}, err
		}
		if env != nil {
			splitParams["env"] = env
		}
	}
	raw, err = rpc("pane.split", splitParams)
	if err != nil {
		return ClearAgentResult{}, err
	}
	var split struct {
		Pane struct {
			PaneID string `json:"pane_id"`
		} `json:"pane"`
	}
	json.Unmarshal(raw, &split)
	paneID := split.Pane.PaneID
	name := autoName(key)
	launched := false
	err = func() error {
		if paneID == "" {
			return &LifecycleError{Status: 502, Code: "error", Message: "herdr returned no pane to start the replacement in"}
		}
		if _, err := launchInPane(rpc, paneID, profiles[key], name); err != nil {
			return err
		}
		launched = true
		if opts.Verify != nil {
			return opts.Verify(paneID)
		}
		return nil
	}()
	if err != nil {
		if !launched {
			closeQuietly(rpc, paneID)
			return ClearAgentResult{}, err
		}
		// a failed verify: say whether the replacement could be stopped (it may still run)
		return ClearAgentResult{}, &LifecycleError{Status: 409, Code: "start_undone",
			Message: err.Error() + "; the old agent was kept (the new one: " + stopStarted(rpc, paneID) + ")"}
	}

	// The replacement is up; retire the old pane. A close failure just leaves the old
	// pane around (reported), rather than failing an otherwise-successful clear.
	_, err = rpc("pane.close", map[string]any{"pane_id": oldPaneID})
	return ClearAgentResult{PaneID: paneID, Name: name, ClosedOld: err == nil, Profile: key, OldPaneID: oldPaneID}, nil
}

// ── create a git worktree (herdr worktree.create) ─────────────────────────────

// CreateWorktreeInput is a worktree to create; every field is decoded JSON (nil =
// absent), checked like the TypeScript does.
type CreateWorktreeInput struct {
	// the repo to branch from: a cwd inside it (herdr resolves the repo root)
	Repo any
	// or an existing workspace in that repo
	Workspace any
	// new branch name; herdr auto-generates a `worktree/…` name when blank
	Branch any
	// base ref for the new branch (e.g. "origin/main"); herdr's default when blank
	Base any
	// checkout dir for the worktree; herdr's worktrees dir when absent
	Path any
}

type CreateWorktreeResult struct {
	WorkspaceID  *string `json:"workspaceId"`
	CheckoutPath string  `json:"checkoutPath"`
	Branch       *string `json:"branch"`
	// the worktree's root shell pane
	PaneID *string `json:"paneId"`
}

func createWorktree(rpc Rpc, in CreateWorktreeInput) (CreateWorktreeResult, error) {
	for _, f := range []struct {
		name string
		v    any
	}{{"repo", in.Repo}, {"workspace", in.Workspace}, {"branch", in.Branch}, {"base", in.Base}} {
		if _, ok := f.v.(string); f.v != nil && !ok {
			return CreateWorktreeResult{}, badRequest(f.name + " must be a string")
		}
	}
	if s, ok := in.Path.(string); in.Path != nil && (!ok || s == "") {
		return CreateWorktreeResult{}, badRequest("path must be a non-empty string")
	}
	repo, _ := in.Repo.(string)
	workspace, _ := in.Workspace.(string)
	if repo == "" && workspace == "" {
		return CreateWorktreeResult{}, badRequest("repo (a cwd in the repo) or workspace is required")
	}

	params := map[string]any{"focus": false}
	if repo != "" {
		params["cwd"] = repo
	}
	if workspace != "" {
		params["workspace_id"] = workspace
	}
	branch, _ := in.Branch.(string)
	if branch = jsTrim(branch); branch != "" {
		params["branch"] = branch
	}
	base, _ := in.Base.(string)
	if base = jsTrim(base); base != "" {
		params["base"] = base
	}
	if path, ok := in.Path.(string); ok {
		params["path"] = path
	}

	// herdr's worktree_created result carries the git-worktree object as `worktree`
	// (its checkout dir is `path`, NOT `checkout_path`) and the opened workspace as
	// `workspace` (whose own `worktree.checkout_path` is the same dir) + a `root_pane`.
	raw, err := rpc("worktree.create", params)
	if err != nil {
		return CreateWorktreeResult{}, err
	}
	var res struct {
		Worktree struct {
			Path            string  `json:"path"`
			Branch          *string `json:"branch"`
			OpenWorkspaceID *string `json:"open_workspace_id"`
		} `json:"worktree"`
		Workspace struct {
			WorkspaceID *string `json:"workspace_id"`
			Worktree    struct {
				CheckoutPath string `json:"checkout_path"`
			} `json:"worktree"`
		} `json:"workspace"`
		RootPane struct {
			PaneID *string `json:"pane_id"`
		} `json:"root_pane"`
	}
	json.Unmarshal(raw, &res)
	checkoutPath := firstNonEmpty(res.Worktree.Path, res.Workspace.Worktree.CheckoutPath)
	if checkoutPath == "" {
		return CreateWorktreeResult{}, &LifecycleError{Status: 502, Code: "error", Message: "worktree created but herdr returned no checkout path"}
	}
	out := CreateWorktreeResult{WorkspaceID: res.Workspace.WorkspaceID, CheckoutPath: checkoutPath, Branch: res.Worktree.Branch, PaneID: res.RootPane.PaneID}
	if out.WorkspaceID == nil {
		out.WorkspaceID = res.Worktree.OpenWorkspaceID
	}
	if out.Branch == nil {
		out.Branch = strp(branch)
	}
	return out, nil
}

// rollbackWorktree removes a worktree we just created (rollback). It never fails: a
// failed rollback leaves a worktree behind, but must not mask the original
// agent-start error the caller is about to see.
func rollbackWorktree(rpc Rpc, workspaceID *string) {
	if workspaceID != nil && *workspaceID != "" {
		rpc("worktree.remove", map[string]any{"workspace_id": *workspaceID, "force": true})
	}
}

// checkoutInUse is whether an agent works in a checkout: one in its workspace, or
// one launched in or moved into dir from any other workspace. Removing the checkout
// would pull its working directory away.
func checkoutInUse(panes []RawPane, workspaceID, dir string) bool {
	inDir := func(c string) bool { return c != "" && (c == dir || strings.HasPrefix(c, dir+"/")) }
	for _, p := range panes {
		if p.Agent != "" && (p.WorkspaceID == workspaceID || inDir(p.Cwd) || inDir(p.ForegroundCwd)) {
			return true
		}
	}
	return false
}
