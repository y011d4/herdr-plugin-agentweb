//go:build claudelive

package bridge

// TestClaudeLive runs the REAL claude (haiku, the personal account: no CLAUDE_CONFIG_DIR)
// through the bridge's headless runner, with fakeherdr as herdr and throwaway state and
// orchestrator dirs, and checks what headless mode depends on (plan §8): one session, one
// resume, about six short turns. Never in the production binary (the claudelive tag); run by
// hand or by scripts/claude-canary.sh:
//
//	go test -tags claudelive -count=1 -run TestClaudeLive -v ./internal/bridge
//
// It prints one `PASS|FAIL <item> <detail>` line per item, and with CLAUDE_LIVE_OUT set
// writes {version, ok, failed: [items]} there. At the end it removes its own
// ~/.claude/projects/<slug>/ (its temp dir's slug, checked) and nothing else.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// liveGet is v[k] for a JSON object v (nil otherwise).
func liveGet(v any, k string) any { m, _ := v.(map[string]any); return m[k] }

func TestClaudeLive(t *testing.T) {
	t.Setenv("YOICKS_CLAUDE_BIN", "")
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	var mu sync.Mutex
	var lines []map[string]any
	reached := map[string]bool{} // overview tool_use id → its call reached the bridge with that id
	var revoke bool              // item 11: revoke the bearer at the next turn's init
	var h *headlessRunner
	hook := func(line []byte) { // in the reader, before the bridge reads the line
		var ev map[string]any
		if json.Unmarshal(line, &ev) != nil {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		lines = append(lines, ev)
		if ev["type"] == "system" && ev["subtype"] == "init" && revoke {
			revoke = false
			h.mu.Lock()
			h.mcpBearer = "revoked" // the next call gets a 401: it fails before reaching the bridge
			h.mu.Unlock()
		}
		if ev["type"] == "user" {
			content, _ := liveGet(ev["message"], "content").([]any)
			for _, b := range content {
				if id, _ := liveGet(b, "tool_use_id").(string); id != "" {
					h.mu.Lock()
					reached[id] = h.served[id]
					h.mu.Unlock()
				}
			}
		}
	}
	dir := filepath.Join(t.TempDir(), "orch")
	def := OrchestratorDef{Name: "live", Label: "Live", Dir: dir, Managed: true, Mode: "headless"}
	tb := startBridge(t, Config{StateDir: t.TempDir(), Orchestrators: []OrchestratorDef{def}}, nil, func(s *server) {
		h = s.headless["live"]
		h.extraArgs, h.lineHook = []string{"--model", "haiku"}, hook
	})
	b := &hlBridge{tb, "", "", "live"}
	failed := []string{}
	version, completed := "", false
	defer func() { // however it ends: its child stopped, its verdict written, its transcripts removed
		b.srv.shutdownHeadless()
		if !completed {
			failed = append(failed, "incomplete")
		}
		if out := os.Getenv("CLAUDE_LIVE_OUT"); out != "" {
			data, _ := json.Marshal(map[string]any{"version": version, "ok": len(failed) == 0, "failed": failed})
			os.WriteFile(out, data, 0o600)
		}
		// its own transcripts only: the dir must be its temp dir's slug
		files, _ := filepath.Glob(filepath.Join(osHomedir(), ".claude", "projects", "*", h.session()+".jsonl"))
		for _, file := range files {
			project := filepath.Dir(file)
			if slug := strings.NewReplacer("/", "-", ".", "-", "_", "-").Replace(dir); filepath.Base(project) == slug && strings.Contains(slug, "TestClaudeLive") {
				os.RemoveAll(project)
			} else {
				t.Errorf("left %s: not the slug of %s", project, dir)
			}
		}
	}()
	item := func(name string, ok bool, detail string, a ...any) {
		verdict := "PASS"
		if !ok {
			verdict, failed = "FAIL", append(failed, name)
			t.Errorf("%s: "+detail, append([]any{name}, a...)...)
		}
		fmt.Printf("%s %s %s\n", verdict, name, fmt.Sprintf(detail, a...))
	}
	poll := func(timeout time.Duration, ok func() bool) bool {
		for end := time.Now().Add(timeout); !ok(); time.Sleep(200 * time.Millisecond) {
			if time.Now().After(end) {
				return false
			}
		}
		return true
	}
	status := func() string {
		if v := b.view(t); v.Headless != nil {
			return v.Headless.Status
		}
		return ""
	}
	count := func(match func(ev map[string]any) bool) (n int) {
		mu.Lock()
		defer mu.Unlock()
		for _, ev := range lines {
			if match(ev) {
				n++
			}
		}
		return n
	}
	isInit := func(ev map[string]any) bool { return ev["type"] == "system" && ev["subtype"] == "init" }
	isResult := func(ev map[string]any) bool { return ev["type"] == "result" }
	// turn sends text and waits for its result (and anything queued after it) to end the turn
	turn := func(text string, timeout time.Duration) bool {
		results := count(isResult)
		if code, body := b.post(t, "send", fmt.Sprintf(`{"text":%q}`, text)); code != 200 {
			t.Logf("send: %d %s", code, body)
			return false
		}
		return poll(timeout, func() bool { return count(isResult) > results && status() != "working" && status() != "blocked" })
	}
	resultsWith := func(word string) int { // results whose text has word
		return count(func(ev map[string]any) bool {
			r, _ := ev["result"].(string)
			return isResult(ev) && strings.Contains(strings.ToLower(r), strings.ToLower(word))
		})
	}
	resultWith := func(word string) bool { return resultsWith(word) > 0 }

	if code, body := b.post(t, "start", ""); code != 200 || !poll(60*time.Second, func() bool { return status() == "idle" }) {
		item("start", false, "the start: %d %s, status %s, warnings %+v", code, body, status(), b.view(t).Headless.Warnings)
		return
	}

	// T1: a tool round trip, a word to remember, and a message sent while it works
	t1 := count(isInit)
	if code, body := b.post(t, "send", `{"text":"Remember this code word: ZEBRA-17. Now call the mcp__yoicks__overview tool once, then reply with just the word DONE."}`); code != 200 {
		t.Logf("send: %d %s", code, body)
	}
	poll(60*time.Second, func() bool { return count(isInit) > t1 })
	b.post(t, "send", `{"text":"Also end your reply with the word KUMQUAT."}`)
	t1ok := poll(180*time.Second, func() bool { return resultWith("KUMQUAT") && status() == "done" })

	mu.Lock()
	var init map[string]any
	if i := slices.IndexFunc(lines, isInit); i >= 0 {
		init = lines[i]
	}
	mu.Unlock()
	version, _ = init["claude_code_version"].(string)
	var missing, interrupts []string
	for _, k := range []string{"session_id", "tools", "mcp_servers", "apiKeySource", "claude_code_version", "model", "permissionMode", "capabilities"} {
		if _, ok := init[k]; !ok {
			missing = append(missing, k)
		}
	}
	caps, _ := init["capabilities"].([]any)
	for _, c := range caps {
		if s, _ := c.(string); strings.HasPrefix(s, "interrupt_") {
			interrupts = append(interrupts, s)
		}
	}
	item("init_keys", init != nil && len(missing) == 0 && len(interrupts) > 0, "version %s, model %v, missing %v, capabilities %v", version, init["model"], missing, interrupts)
	item("api_key_source", init["apiKeySource"] == "none", "apiKeySource %v", init["apiKeySource"])
	connected := ""
	servers, _ := init["mcp_servers"].([]any)
	for _, s := range servers {
		if s, _ := s.(map[string]any); s["name"] == "yoicks" {
			connected, _ = s["status"].(string)
		}
	}
	item("mcp_connected", connected == "connected", "yoicks %q", connected)

	var overviewIDs []string
	mu.Lock()
	for _, ev := range lines {
		content, _ := liveGet(ev["message"], "content").([]any)
		for _, c := range content {
			if c, _ := c.(map[string]any); ev["type"] == "assistant" && c["type"] == "tool_use" && c["name"] == "mcp__yoicks__overview" {
				id, _ := c["id"].(string)
				overviewIDs = append(overviewIDs, id)
			}
		}
	}
	served := len(overviewIDs) > 0
	for _, id := range overviewIDs {
		served = served && reached[id]
	}
	mu.Unlock()
	item("tool_round_trip", resultWith("DONE") && served && !hasWarning(b.view(t), "mcp_call"), "overview called %d time(s), each reached the bridge with its tool_use id: %v", len(overviewIDs), served)
	v := b.view(t)
	u := v.Headless.Usage
	rateEvent := count(func(ev map[string]any) bool {
		w, _ := liveGet(ev["rate_limit_info"], "unifiedWindows").(map[string]any)
		return ev["type"] == "rate_limit_event" && w != nil
	})
	window := count(func(ev map[string]any) bool {
		usage, _ := ev["modelUsage"].(map[string]any)
		for _, m := range usage {
			if w, _ := liveGet(m, "contextWindow").(float64); w > 0 {
				return true
			}
		}
		return false
	})
	item("usage", u != nil && u.ContextPct != nil && (u.FiveHour != nil || u.SevenDay != nil) && u.At > 0 && rateEvent > 0 && window > 0,
		"rate_limit_events %d, results with a contextWindow %d, state usage: contextPct %v, fiveHour %v, sevenDay %v, at %v", rateEvent, window,
		u != nil && u.ContextPct != nil, u != nil && u.FiveHour != nil, u != nil && u.SevenDay != nil, u != nil && u.At > 0)

	// T2: an AskUserQuestion, answered through /answer: a multiSelect and a free-text answer
	results := count(isResult)
	b.post(t, "send", `{"text":"Use the AskUserQuestion tool exactly once, with two questions in that one call: first 'Which fruits do you like?' with multiSelect true and the options apple, banana and cherry; second 'What size?' with the options small and large. After my answer, reply with exactly the answers you received and nothing else."}`)
	var pending *HeadlessPending
	poll(120*time.Second, func() bool { pending = b.view(t).Headless.Pending; return pending != nil })
	asked, multi := "", false
	if pending != nil {
		answers := map[string]any{}
		for _, q := range pending.Questions {
			switch {
			case q.MultiSelect && len(q.Options) > 1:
				answers[q.Question], multi = q.Options[0].Label+", "+q.Options[len(q.Options)-1].Label, true
			default:
				answers[q.Question] = "medium" // not one of its options: free text
			}
		}
		body, _ := json.Marshal(map[string]any{"id": pending.ID, "answers": answers})
		code, out := b.post(t, "answer", string(body))
		asked = fmt.Sprintf("answered %s: %d %s", body, code, out)
	}
	t2ok := poll(120*time.Second, func() bool { return count(isResult) > results && status() == "done" })
	item("ask_answered", pending != nil && multi && t2ok && resultWith("apple") && resultWith("cherry") && resultWith("medium"),
		"%d question(s), a multiSelect: %v; %s; the reply has the answers: %v", func() int {
			if pending == nil {
				return 0
			}
			return len(pending.Questions)
		}(), multi, asked, resultWith("medium"))

	// T3, T4: an interrupt mid-turn, then the next message
	t3 := count(isInit)
	b.post(t, "send", `{"text":"Write the numbers from 1 to 2000 in English words, one per line, and nothing else."}`)
	poll(60*time.Second, func() bool { return count(isInit) > t3 })
	time.Sleep(1500 * time.Millisecond) // into its answer, long before its end
	code, _ := b.post(t, "interrupt", "")
	aborted := poll(30*time.Second, func() bool {
		return count(func(ev map[string]any) bool {
			r, _ := ev["terminal_reason"].(string)
			return strings.HasPrefix(r, "aborted")
		}) > 0 && status() == "idle"
	})
	next := turn("Reply with just the word PELICAN.", 120*time.Second) && resultWith("PELICAN")
	item("interrupt", code == 200 && aborted && next, "interrupt %d, the turn aborted: %v, the next message answered: %v", code, aborted, next)

	// the transcript: written, and read by normalizeLine (the message sent mid-turn a user item)
	_, body, _ := b.do(t, "GET", "/api/panes/hl:live/transcript", b.token, nil)
	var tr struct {
		Available bool             `json:"available"`
		SessionID string           `json:"sessionId"`
		Items     []map[string]any `json:"items"`
	}
	json.Unmarshal([]byte(body), &tr)
	kinds := map[string]int{}
	userKumquat := false
	for _, it := range tr.Items {
		kind, _ := it["kind"].(string)
		text, _ := it["text"].(string)
		kinds[kind]++
		userKumquat = userKumquat || kind == "user" && strings.Contains(text, "KUMQUAT")
	}
	files, _ := filepath.Glob(filepath.Join(osHomedir(), ".claude", "projects", "*", h.session()+".jsonl"))
	raw, normalized := 0, 0
	if len(files) == 1 {
		data, _ := os.ReadFile(files[0])
		for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			raw++
			normalized += len(normalizeLine(l))
		}
	}
	item("mid_turn_message", t1ok && userKumquat && resultWith("KUMQUAT"), "a user item for it: %v, a reply to it: %v", userKumquat, resultWith("KUMQUAT"))
	item("transcript", tr.Available && len(files) == 1 && kinds["user"] > 0 && kinds["assistant"] > 0 && kinds["tool_use"] > 0 && normalized > 0,
		"available %v, %d file(s), %d lines → %d items, the tail's kinds %v", tr.Available, len(files), raw, normalized, kinds)

	// stop, then start again: --resume, the word remembered
	session, words := h.session(), resultsWith("ZEBRA-17")
	b.post(t, "stop", "")
	stopped := poll(30*time.Second, func() bool { return status() == "stopped" })
	code, _ = b.post(t, "start", "")
	resumed := code == 200 && poll(60*time.Second, func() bool { return status() == "idle" }) && h.session() == session
	remembered := resumed && turn("What was the code word I asked you to remember? Reply with just the code word.", 120*time.Second) && resultsWith("ZEBRA-17") > words
	item("resume", stopped && resumed && remembered, "stopped %v, resumed session %v, the word remembered: %v", stopped, resumed, remembered)

	// a yoicks call failing before it reaches the bridge: the bearer revoked at the turn's start
	mu.Lock()
	revoke = true
	mu.Unlock()
	turned := turn("Call the mcp__yoicks__overview tool once. Then reply with just the word FINISHED, whatever the tool returned.", 120*time.Second)
	warning, errText := "", ""
	for _, w := range b.view(t).Headless.Warnings {
		if w.Kind == "mcp_call" {
			warning = w.Message
		}
	}
	mu.Lock()
	for _, ev := range lines[max(0, len(lines)-40):] {
		content, _ := liveGet(ev["message"], "content").([]any)
		for _, c := range content {
			if c, _ := c.(map[string]any); ev["type"] == "user" && c["is_error"] == true {
				errText, _ = truncateUnits(strings.ReplaceAll(toolResultText(c["content"]), "\n", " | "), 400)
			}
		}
	}
	mu.Unlock()
	item("mcp_failure", turned && warning != "", "warning %q; Claude Code's tool_result: %q", warning, errText)

	completed = true
}
