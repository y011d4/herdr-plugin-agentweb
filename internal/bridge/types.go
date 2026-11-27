package bridge

// Shared types: a port of server/types.ts, plus the types other modules share
// (LaunchProfile, LifecycleError, Rpc from agent-lifecycle.ts; TimelineItem from
// transcript-normalize.ts). JSON field names and null-vs-absent follow the
// TypeScript bridge exactly: web/src/types.ts is the other side of this contract.
// A TS `T | null` field is a pointer (or a nil slice) with no omitempty.

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"unicode"
)

// ── normalized state ─────────────────────────────────────────────────────────

// AgentInfo is the agent running in a pane.
type AgentInfo struct {
	Name         *string `json:"name"`
	DisplayName  *string `json:"displayName"`
	Status       string  `json:"status"` // idle | working | blocked | done | unknown
	CustomStatus *string `json:"customStatus"`
	Message      *string `json:"message"`
	SinceUnixMs  int64   `json:"sinceUnixMs"`
	// herdr's completion_seq: which completion this idle/done status is (agent.list
	// only; null until fetched)
	CompletionSeq *int64 `json:"completionSeq"`
	// herdr's state_change_seq: when this status began, in herdr's own order of
	// changes, which (unlike sinceUnixMs) survives a bridge restart
	StateChangeSeq *int64 `json:"stateChangeSeq"`
	// the agent's herdr name (agent.start's, as `yoicks agent` and a headless orchestrator's
	// [yoicks] notices name it; agent.list only, null until fetched)
	HerdrName *string `json:"herdrName"`
}

// PaneNode is a pane. Nodes reachable from a published State are never modified:
// every change builds new ones (copy-on-write), like the TypeScript state.
type PaneNode struct {
	PaneID  string `json:"paneId"`
	Focused bool   `json:"focused"`
	// where the pane is now (foreground process cwd, else the shell's); moves with cd
	Cwd *string `json:"cwd"`
	// the pane shell's cwd: where its agent was launched; stable while the agent runs
	LaunchCwd *string    `json:"launchCwd"`
	Title     *string    `json:"title"`
	Agent     *AgentInfo `json:"agent"`
}

// TabNode is a tab and its panes.
type TabNode struct {
	TabID string      `json:"tabId"`
	Label string      `json:"label"`
	Panes []*PaneNode `json:"panes"`
}

// WorktreeInfo is a workspace's git context.
type WorktreeInfo struct {
	// stable repo identity (path to the shared .git)
	RepoKey      string `json:"repoKey"`
	RepoName     string `json:"repoName"`
	RepoRoot     string `json:"repoRoot"`
	CheckoutPath string `json:"checkoutPath"`
	// false: the repo's main checkout; true: a linked git worktree
	IsLinkedWorktree bool `json:"isLinkedWorktree"`
	// current branch (null when detached, or only herdr's branch-less data is known)
	Branch *string `json:"branch"`
}

// WorkspaceNode is a workspace and its tabs.
type WorkspaceNode struct {
	WorkspaceID string        `json:"workspaceId"`
	Label       string        `json:"label"`
	Cwd         *string       `json:"cwd"`
	Worktree    *WorktreeInfo `json:"worktree"`
	Tabs        []*TabNode    `json:"tabs"`
}

// HerdrInfo is the herdr server's version.
type HerdrInfo struct {
	Version  *string `json:"version"`
	Protocol *int    `json:"protocol"`
}

// Focus is herdr's focused workspace, tab and pane.
type Focus struct {
	WorkspaceID *string `json:"workspaceId"`
	TabID       *string `json:"tabId"`
	PaneID      *string `json:"paneId"`
}

// State is the normalized herdr session (NormalizedState). Treat it as immutable.
// Its JSON is the client state minus what http.ts adds (orchestrators): the
// internal indexes are unexported and never serialized.
type State struct {
	Connected  bool             `json:"connected"`
	Herdr      HerdrInfo        `json:"herdr"`
	Focused    Focus            `json:"focused"`
	Workspaces []*WorkspaceNode `json:"workspaces"`

	paneByID  map[string]*PaneNode
	paneOrder []string // pane ids in snapshot order (Map insertion order in TS)
	tabByID   map[string]*TabNode
}

// Pane returns a pane by id, or nil.
func (s *State) Pane(id string) *PaneNode { return s.paneByID[id] }

// PaneIDs returns every pane id, in snapshot order (getPaneIds).
func (s *State) PaneIDs() []string { return append([]string(nil), s.paneOrder...) }

// withConnected returns a copy of s with Connected set.
func (s *State) withConnected(v bool) *State {
	n := *s
	n.Connected = v
	return &n
}

// StatusChange is an agent's status transition.
type StatusChange struct {
	PaneID string
	From   string
	To     string
	Agent  *AgentInfo
}

// ── orchestrators and config ─────────────────────────────────────────────────

// OrchestratorDef is a configured orchestrator.
type OrchestratorDef struct {
	// stable id, used in the app's #/home/<name> route
	Name string
	// shown as the Home title; "" = fall back to the workspace label
	Label string
	// absolute dir, no trailing slash
	Dir string
	// environment it is started with (e.g. CLAUDE_CONFIG_DIR, which picks its account)
	Env map[string]string
	// "tui" (an agent in a herdr pane; "" too) or "headless" (the bridge's own claude -p child)
	Mode string
}

// OrchestratorView is an orchestrator as sent to clients.
type OrchestratorView struct {
	Name   string  `json:"name"`
	Label  string  `json:"label"`
	PaneID *string `json:"paneId"`
	// the agent panes of its Claude account (itself included); null when unknown
	Agents []string `json:"agents"`
	// "tui" or "headless" (then paneId is "hl:<name>" while its child runs)
	Mode string `json:"mode"`
	// a headless orchestrator's state; null for tui
	Headless *HeadlessView `json:"headless"`
}

// HeadlessView is a headless orchestrator's state (headless.go, headless_state.go).
type HeadlessView struct {
	Status        string `json:"status"` // stopped | idle | working | blocked | done | error
	CompletionSeq int64  `json:"completionSeq"`
	// the question waiting for the user (AskUserQuestion): answered with /answer and its id
	Pending  *HeadlessPending  `json:"pending"`
	Usage    *HeadlessUsage    `json:"usage"`
	Warnings []HeadlessWarning `json:"warnings"`
	// the model it runs on (set with /model): one of models' values, "default" = Claude Code's own
	Model string `json:"model"`
	// the models Claude Code offers the account, as its /model lists them; [] until a child of
	// this bridge has said
	Models []HeadlessModel `json:"models"`
}

type HeadlessModel struct {
	Value         string `json:"value"` // an alias (opus, default) or a model id
	DisplayName   string `json:"displayName"`
	Description   string `json:"description"`
	ResolvedModel string `json:"resolvedModel"` // the model id it stands for now
}

type HeadlessPending struct {
	ID        string        `json:"id"`
	Questions []AskQuestion `json:"questions"`
}

// HeadlessUsage is what Claude Code last said of the account's rate limits and the
// session's context.
type HeadlessUsage struct {
	FiveHour   *UsageWindow `json:"fiveHour"`
	SevenDay   *UsageWindow `json:"sevenDay"`
	Fable      *UsageWindow `json:"fable"`      // Claude Code's "Fable limit" (seven_day_overage_included): only in answers to a Fable request
	ContextPct *float64     `json:"contextPct"` // percent of the context window; null until a turn ends
	At         int64        `json:"at"`         // when the rate limits were read (ms); 0 = not yet
}

type UsageWindow struct {
	Utilization float64 `json:"utilization"` // 0–1
	ResetsAt    int64   `json:"resetsAt"`    // ms
}

// HeadlessWarning is something that went wrong, shown on the Home until the next start.
type HeadlessWarning struct {
	Kind    string   `json:"kind"`
	Message string   `json:"message"`
	Since   int64    `json:"since"`   // ms
	Actions []string `json:"actions"` // what the Home offers: interrupt | clear | tui
}

// LaunchProfile is a named, fixed way to start an agent.
type LaunchProfile struct {
	// the agent kind + fixed flags, e.g. ["claude", "--dangerously-skip-permissions"]
	Argv  []string `json:"argv"`
	Label string   `json:"label"`
}

// Config is the bridge's configuration.
type Config struct {
	Host           string
	Port           int
	NotifyURL      *string
	PublicURL      *string // externally reachable base URL (config public_url)
	StateDir       string
	SocketPath     string
	LaunchProfiles map[string]LaunchProfile
	Orchestrators  []OrchestratorDef
}

// ── errors and rpc ───────────────────────────────────────────────────────────

// HerdrError is an error answer from herdr, with its code (e.g. agent_pane_busy).
type HerdrError struct{ Code, Message string }

func (e *HerdrError) Error() string { return e.Message }

// herdrCode is err's herdr error code, or "".
func herdrCode(err error) string {
	if he, ok := err.(*HerdrError); ok {
		return he.Code
	}
	return ""
}

// LifecycleError is a validation or orchestration failure carrying the HTTP status
// and error code the bridge answers with.
type LifecycleError struct {
	Status  int
	Code    string
	Message string
}

func (e *LifecycleError) Error() string { return e.Message }

// Rpc sends one request to herdr and returns its result.
type Rpc func(method string, params map[string]any) (json.RawMessage, error)

// ── raw herdr payloads ───────────────────────────────────────────────────────
// Only the fields the bridge reads. An absent string reads as "", which the
// TypeScript code treats like undefined (falsy) everywhere it matters.

type RawPane struct {
	PaneID        string           `json:"pane_id"`
	WorkspaceID   string           `json:"workspace_id"`
	TabID         string           `json:"tab_id"`
	Focused       bool             `json:"focused"`
	Agent         string           `json:"agent"`
	DisplayAgent  string           `json:"display_agent"`
	AgentStatus   string           `json:"agent_status"`
	CustomStatus  string           `json:"custom_status"`
	AgentMessage  string           `json:"agent_message"`
	Cwd           string           `json:"cwd"`
	ForegroundCwd string           `json:"foreground_cwd"`
	Title         string           `json:"title"`
	AgentSession  *RawAgentSession `json:"agent_session"`
}

// RawAgentSession is herdr's agent_session ({source: "herdr:claude", value: <session id>}).
type RawAgentSession struct {
	Source string `json:"source"`
	Value  string `json:"value"`
}

type RawTab struct {
	TabID       string          `json:"tab_id"`
	WorkspaceID string          `json:"workspace_id"`
	Label       json.RawMessage `json:"label"` // string or number
}

// LabelOr is the tab's label as a string (a number label as its digits), or def
// when it has none: `t.label != null ? String(t.label) : def`.
func (t RawTab) LabelOr(def string) string {
	if len(t.Label) == 0 || string(t.Label) == "null" {
		return def
	}
	var s string
	if json.Unmarshal(t.Label, &s) == nil {
		return s
	}
	var f float64
	if json.Unmarshal(t.Label, &f) == nil {
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return string(t.Label)
}

type RawWorktree struct {
	RepoKey          string `json:"repo_key"`
	RepoName         string `json:"repo_name"`
	RepoRoot         string `json:"repo_root"`
	CheckoutPath     string `json:"checkout_path"`
	IsLinkedWorktree *bool  `json:"is_linked_worktree"`
}

type RawWorkspace struct {
	WorkspaceID string       `json:"workspace_id"`
	Label       string       `json:"label"`
	ActiveTabID string       `json:"active_tab_id"`
	Worktree    *RawWorktree `json:"worktree"`
}

type RawSnapshot struct {
	Version            string         `json:"version"`
	Protocol           int            `json:"protocol"`
	FocusedWorkspaceID string         `json:"focused_workspace_id"`
	FocusedTabID       string         `json:"focused_tab_id"`
	FocusedPaneID      string         `json:"focused_pane_id"`
	Workspaces         []RawWorkspace `json:"workspaces"`
	Tabs               []RawTab       `json:"tabs"`
	Panes              []RawPane      `json:"panes"`
}

// RawAgentSeqs is the part of an agent.list entry applyCompletionSeqs reads.
type RawAgentSeqs struct {
	PaneID         string `json:"pane_id"`
	Name           string `json:"name"` // the agent's herdr name (agent.start's)
	AgentStatus    string `json:"agent_status"`
	CompletionSeq  *int64 `json:"completion_seq"`
	StateChangeSeq *int64 `json:"state_change_seq"`
}

// ── websocket messages (outbound) ────────────────────────────────────────────

// ClientState is the state as sent to clients: State plus the orchestrators
// (http.ts clientState).
type ClientState struct {
	*State
	Orchestrators []OrchestratorView `json:"orchestrators"`
	// the first running orchestrator's pane, for older clients
	OrchestratorPaneID *string `json:"orchestratorPaneId"`
	// the last check of Claude Code's headless mode; null when none has run
	ClaudeCheck *ClaudeCheck `json:"claudeCheck"`
}

// ClaudeCheck is the last periodic check of Claude Code's headless mode: what
// scripts/claude-canary.sh wrote to <state>/canary.json.
type ClaudeCheck struct {
	At      int64    `json:"at"` // ms
	Version string   `json:"version"`
	OK      bool     `json:"ok"`
	Failed  []string `json:"failed"` // the live test's items that failed
}

type WsStateMessage struct {
	Type  string      `json:"type"` // "state"
	State ClientState `json:"state"`
}

type WsAgentStatusMessage struct {
	Type           string  `json:"type"` // "agent_status"
	PaneID         string  `json:"paneId"`
	Agent          *string `json:"agent"` // the display string, not the agent object
	From           string  `json:"from"`
	To             string  `json:"to"`
	WorkspaceLabel *string `json:"workspaceLabel"`
	TabLabel       *string `json:"tabLabel"`
}

// WsOrchestratorAlertMessage is a headless orchestrator's new warning, sent once per kind
// and session; or (Name "", Kind "canary") a failed claude check, once.
type WsOrchestratorAlertMessage struct {
	Type    string `json:"type"` // "orchestrator_alert"
	Name    string `json:"name"` // "": not one orchestrator's (the claude check)
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

type WsPongMessage struct {
	Type string `json:"type"` // "pong"
}

type WsPaneOutputMessage struct {
	Type      string `json:"type"` // "pane_output"
	PaneID    string `json:"paneId"`
	Ansi      string `json:"ansi"`
	AppScroll bool   `json:"appScroll"`
}

type WsPaneGoneMessage struct {
	Type   string `json:"type"` // "pane_gone"
	PaneID string `json:"paneId"`
}

// WsTranscriptItemsMessage: available=false carries no sessionId.
type WsTranscriptItemsMessage struct {
	Type      string         `json:"type"` // "transcript_items"
	PaneID    string         `json:"paneId"`
	Available bool           `json:"available"`
	SessionID *string        `json:"sessionId,omitempty"`
	Items     []TimelineItem `json:"items"`
	Cursor    int64          `json:"cursor"`
	Reset     bool           `json:"reset"`
}

// ── transcript timeline ──────────────────────────────────────────────────────

// TimelineItem is one entry of the chat view, a union keyed by Kind (user |
// assistant | thinking | tool_use | tool_result). It marshals to exactly the
// fields of its kind, in the TypeScript order.
type TimelineItem struct {
	Kind      string
	Text      string
	Images    []string      // user: the images sent with it, as data: URLs (omitted when none)
	Truncated bool          // thinking, tool_result
	ID        string        // tool_use
	Name      string        // tool_use
	Summary   string        // tool_use
	Todos     []TodoEntry   // tool_use; nil = null
	Ask       []AskQuestion // tool_use; nil = null
	ForID     *string       // tool_result
	IsError   bool          // tool_result
	Sidechain bool
	TS        *int64
}

type TodoEntry struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

type AskOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
}

type AskQuestion struct {
	Question    string      `json:"question"`
	Header      string      `json:"header"`
	MultiSelect bool        `json:"multiSelect"`
	Options     []AskOption `json:"options"`
}

func (t TimelineItem) MarshalJSON() ([]byte, error) {
	switch t.Kind {
	case "thinking":
		return marshalRaw(struct {
			Kind      string `json:"kind"`
			Text      string `json:"text"`
			Truncated bool   `json:"truncated"`
			Sidechain bool   `json:"sidechain"`
			TS        *int64 `json:"ts"`
		}{t.Kind, t.Text, t.Truncated, t.Sidechain, t.TS})
	case "tool_use":
		return marshalRaw(struct {
			Kind      string        `json:"kind"`
			ID        string        `json:"id"`
			Name      string        `json:"name"`
			Summary   string        `json:"summary"`
			Todos     []TodoEntry   `json:"todos"`
			Ask       []AskQuestion `json:"ask"`
			Sidechain bool          `json:"sidechain"`
			TS        *int64        `json:"ts"`
		}{t.Kind, t.ID, t.Name, t.Summary, t.Todos, t.Ask, t.Sidechain, t.TS})
	case "tool_result":
		return marshalRaw(struct {
			Kind      string  `json:"kind"`
			ForID     *string `json:"forId"`
			Text      string  `json:"text"`
			Truncated bool    `json:"truncated"`
			IsError   bool    `json:"isError"`
			Sidechain bool    `json:"sidechain"`
			TS        *int64  `json:"ts"`
		}{t.Kind, t.ForID, t.Text, t.Truncated, t.IsError, t.Sidechain, t.TS})
	default: // user, assistant
		return marshalRaw(struct {
			Kind      string   `json:"kind"`
			Text      string   `json:"text"`
			Images    []string `json:"images,omitempty"`
			Sidechain bool     `json:"sidechain"`
			TS        *int64   `json:"ts"`
		}{t.Kind, t.Text, t.Images, t.Sidechain, t.TS})
	}
}

// ── small helpers ────────────────────────────────────────────────────────────

// strp is &s, or nil for "" (the TypeScript `x || null`).
func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// firstNonEmpty is the first non-empty string (the TypeScript `a || b || …`).
func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// ── JavaScript string semantics ──────────────────────────────────────────────
// The TypeScript bridge measures and slices strings in UTF-16 code units, and its
// regexps' \s matches Unicode spaces. Ports that depend on either use these.

// jsLen is s.length: its length in UTF-16 code units.
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// jsSlice is s.slice(0, n) for n >= 0, except that it never splits a surrogate
// pair: a character that would be cut in half is left out (JavaScript keeps a lone
// surrogate, which JSON then can't carry intact).
func jsSlice(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r >= 0x10000 {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// jsSpace is a regexp class body matching what JavaScript's \s matches (RE2's \s
// is ASCII only). Use it as `[` + jsSpace + `]`.
const jsSpace = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// isJSSpace is what JavaScript's \s, trim() and parseInt count as white space, the
// same set as jsSpace: unicode.IsSpace plus U+FEFF, minus U+0085.
func isJSSpace(r rune) bool { return r == '\ufeff' || r != '\u0085' && unicode.IsSpace(r) }

// jsTrimEnd is s.trimEnd() (s.replace(/\s+$/, "")).
func jsTrimEnd(s string) string { return strings.TrimRightFunc(s, isJSSpace) }

// jsTrim is s.trim().
func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// asciiLower lowercases A-Z only, which is all JavaScript's non-unicode /i folds onto
// an ASCII pattern.
func asciiLower(s string) string {
	return strings.Map(func(r rune) rune {
		if 'A' <= r && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}, s)
}

// marshalRaw is json.Marshal without HTML escaping, as JSON.stringify writes <, >
// and &. A MarshalJSON method must use it: an encoder's SetEscapeHTML(false) does
// not undo escaping already done inside a Marshaler's output.
func marshalRaw(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}
