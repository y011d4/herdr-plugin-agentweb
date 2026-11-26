package bridge

// Orchestrators the plugin manages (config `orchestrators`), a port of
// server/orchestrator.ts. Each gets a dir, <data>/orchestrators/<name>/, which the
// plugin writes when the bridge starts and again before each start of it:
//
//	CLAUDE.md              imports rules.md, then local.md
//	rules.md               the rules bundled with the plugin (orchestrator/rules.md),
//	                       with the real yoicks command filled in
//	.claude/settings.json  the allowlist: yoicks only, nothing else asked or allowed
//	local.md               this orchestrator's own rules — created once, never overwritten
//
// (.claude/settings.local.json, which Claude Code also reads, is the user's too.)
// It is started with its configured env (e.g. CLAUDE_CONFIG_DIR, picking its Claude
// account), so no per-dir tool like direnv is needed, and the started agent's account
// is checked against that env.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var shellSafe = regexp.MustCompile(`^[\w./@%+=:,-]+$`)

// shellWord is a path as one shell word (quoted only when it needs to be).
func shellWord(p string) string {
	if shellSafe.MatchString(p) {
		return p
	}
	return "'" + strings.ReplaceAll(p, "'", `'\''`) + "'"
}

// yoicksCommand is how an orchestrator runs yoicks: the exact command its
// allowlist permits, this executable's real path. If that can't be found it is an
// empty quoted word (an allowlist that matches nothing: fail closed).
func yoicksCommand() string {
	exe, err := os.Executable()
	if err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
	}
	return shellWord(exe)
}

const localTemplate = `<!-- This orchestrator's own rules: which repos it takes on, what language to answer in,
     anything else. yoicks never changes this file (CLAUDE.md and rules.md are
     rewritten each time it starts the orchestrator). -->
`

// orchestratorFiles is the plugin-written files of a managed orchestrator's dir
// (paths relative to it).
func orchestratorFiles(def OrchestratorDef, rules, ctl string) map[string]string {
	type permissions struct {
		DefaultMode string   `json:"defaultMode"`
		Allow       []string `json:"allow"`
		Deny        []string `json:"deny"`
	}
	settings := struct {
		DisableAgentView bool        `json:"disableAgentView"`
		Permissions      permissions `json:"permissions"`
	}{true, permissions{
		// anything not allowed below is refused without asking
		DefaultMode: "dontAsk",
		Allow:       []string{"Bash(" + ctl + " overview)", "Bash(" + ctl + " agent *)", "Bash(" + ctl + " worktree remove *)"},
		// dontAsk itself refuses most read-only commands (cat, ls, grep, git -C…) on paths outside
		// this dir, but runs these listers there; existence checks (test -e, realpath) still answer.
		// Not blockReadsOutsideWorkingDirectories: it also refuses yoicks, whose path and
		// --cwd/worktree paths lie outside this dir, and no allow rule or hook lifts that.
		// (Measured on Claude Code 2.1.322; recheck on upgrades.)
		Deny: []string{"Edit", "Write", "NotebookEdit", "Bash(herdr *)",
			"Bash(tree *)", "Bash(du *)", "Bash(fd *)", "Bash(fdfind *)", "Bash(lsof *)",
			"Read(~/.config/claude/**)", "Read(~/.claude/projects/**)"},
	}}
	// JSON.stringify(settings, null, 2) + "\n": no HTML escaping, as JS writes & < >
	var js bytes.Buffer
	enc := json.NewEncoder(&js)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	enc.Encode(settings) // plain strings: can't fail
	return map[string]string{
		"CLAUDE.md": `<!-- Written by yoicks each time it starts this orchestrator: edits here are lost.
     This orchestrator's own rules go in local.md. -->

# Orchestrator: ` + def.Label + `

@rules.md

@local.md
`,
		"rules.md":              strings.ReplaceAll(rulesFor(rules, firstNonEmpty(def.Mode, "tui")), "{{yoicks}}", ctl),
		".claude/settings.json": js.String(),
	}
}

// rulesFor is the bundled rules for mode: the shared text and that mode's sections, each
// written "<!-- mode -->\n…<!-- /mode -->\n", their markers left out (the other mode's go whole).
func rulesFor(rules, mode string) string {
	for _, m := range []string{"tui", "headless"} {
		open, end := "<!-- "+m+" -->\n", "<!-- /"+m+" -->\n"
		for {
			i := strings.Index(rules, open)
			j := strings.Index(rules, end)
			if i < 0 || j < i {
				break
			}
			if m == mode {
				rules = rules[:i] + rules[i+len(open):j] + rules[j+len(end):]
			} else {
				rules = rules[:i] + rules[j+len(end):]
			}
		}
	}
	return rules
}

// ensureOrchestratorDir writes a managed orchestrator's dir (see the top of this
// file); local.md only when missing. rules is the bundled orchestrator/rules.md.
func ensureOrchestratorDir(def OrchestratorDef, rules string) error {
	if err := os.MkdirAll(filepath.Join(def.Dir, ".claude"), 0o777); err != nil {
		return err
	}
	for rel, text := range orchestratorFiles(def, rules, yoicksCommand()) {
		if err := os.WriteFile(filepath.Join(def.Dir, rel), []byte(text), 0o666); err != nil {
			return err
		}
	}
	local := filepath.Join(def.Dir, "local.md")
	if _, err := os.Stat(local); err != nil {
		return os.WriteFile(local, []byte(localTemplate), 0o666)
	}
	return nil
}

// Always plain claude, whatever config does to the `claude` launch profile.
var orchestratorProfile = map[string]LaunchProfile{"claude": {Argv: []string{"claude"}, Label: "Claude Code"}}

// expectedAccount is the Claude account an orchestrator runs under: the one its env sets,
// else what its dir sets (direnv; up to 15 s), else the default. startOrchestrator checks
// the started agent against it; a stopped orchestrator's Home lists that account's agents.
func expectedAccount(def OrchestratorDef) string {
	a, _ := expectedAccountRead(def)
	return a
}

// expectedAccountRead is expectedAccount, and whether it was read (false: direnv couldn't
// tell, so the default stands in). A headless one runs with its env only, never direnv's.
func expectedAccountRead(def OrchestratorDef) (string, bool) {
	if cfg := def.Env["CLAUDE_CONFIG_DIR"]; cfg != "" || def.Mode == "headless" {
		return accountForConfigDir(cfg, ""), true
	}
	if a := dirAccount(def.Dir); a != "" {
		return a, true
	}
	return accountForConfigDir("", ""), false
}

// startOrchestrator starts an orchestrator in a new workspace at its dir, with its
// env, and returns its pane and agent name. Refused when one already runs there. A
// managed dir is (re)written first; a legacy one must exist. The started agent must
// come up under the account its env sets, else it is stopped again.
func startOrchestrator(rpc Rpc, def OrchestratorDef, rules string) (paneID, name string, err error) {
	if pane, err := agentInDir(rpc, def.Dir); err != nil {
		return "", "", err
	} else if pane != "" {
		return "", "", &LifecycleError{Status: 409, Code: "already_running",
			Message: fmt.Sprintf("orchestrator %s already runs (pane %s)", def.Name, pane)}
	}
	if def.Managed {
		if err := ensureOrchestratorDir(def, rules); err != nil {
			return "", "", err
		}
	} else if _, err := os.Stat(def.Dir); err != nil {
		return "", "", &LifecycleError{Status: 404, Code: "not_found", Message: def.Dir + " does not exist"}
	}
	expected := expectedAccount(def)
	agent := agentName("orch-" + def.Name)
	if agent == "" {
		agent = "orch"
	}
	out, err := startAgent(rpc, orchestratorProfile, StartAgentInput{
		Profile: "claude", Name: agent, Cwd: def.Dir, NewWorkspace: true, Env: def.Env,
	}, StartAgentOptions{
		Verify: func(paneID string) error {
			if err := waitForDetectedAgent(rpc, paneID); err != nil {
				return err
			}
			account, err := paneAccount(rpc, paneID)
			if err != nil {
				return err
			}
			if account != expected {
				return &LifecycleError{Status: 409, Code: "account_mismatch", Message: "it came up under another Claude account than its env sets"}
			}
			return nil
		},
	})
	if err != nil {
		return "", "", err
	}
	return out.PaneID, out.Name, nil
}

// agentInDir is the pane of a herdr agent running in dir or below ("" = none).
func agentInDir(rpc Rpc, dir string) (string, error) {
	raw, err := rpc("agent.list", nil)
	if err != nil {
		return "", err
	}
	var list struct {
		Agents []struct {
			PaneID string `json:"pane_id"`
			Cwd    string `json:"cwd"`
		} `json:"agents"`
	}
	json.Unmarshal(raw, &list)
	for _, a := range list.Agents {
		if a.Cwd == dir || strings.HasPrefix(a.Cwd, dir+"/") {
			return a.PaneID, nil
		}
	}
	return "", nil
}
