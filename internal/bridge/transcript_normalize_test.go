package bridge

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

// itemsJSON is items as the bridge sends them, so tests compare the exact field set.
func itemsJSON(t *testing.T, items []TimelineItem) string {
	t.Helper()
	if items == nil {
		items = []TimelineItem{}
	}
	b, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// jsonLine is one JSONL line as the transcript format stores it.
func jsonLine(v any) string {
	b, _ := json.Marshal(v) // plain maps and strings: never fails
	return string(b)
}

func mustParse(t *testing.T, s string) any {
	t.Helper()
	v, ok := jsonParse(s)
	if !ok {
		t.Fatalf("bad JSON: %s", s)
	}
	return v
}

func kindsOf(items []TimelineItem) string {
	var ks []string
	for _, i := range items {
		ks = append(ks, i.Kind)
	}
	return strings.Join(ks, ",")
}

func TestTranscriptNormalize(t *testing.T) {
	type obj = map[string]any

	t.Run("normalizeLine — user turns", func(t *testing.T) {
		t.Run("maps a string user message to a user item", func(t *testing.T) {
			items := normalizeLine(`{"type":"user","timestamp":"2026-07-15T00:00:00.000Z","message":{"role":"user","content":"hello there"}}`)
			ts := time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC).UnixMilli()
			want := fmt.Sprintf(`[{"kind":"user","text":"hello there","sidechain":false,"ts":%d}]`, ts)
			if got := itemsJSON(t, items); got != want {
				t.Fatalf("got %s, want %s", got, want)
			}
		})

		t.Run("skips an empty/whitespace user message", func(t *testing.T) {
			if items := normalizeLine(`{"type":"user","message":{"role":"user","content":"   "}}`); len(items) != 0 {
				t.Fatalf("got %s", itemsJSON(t, items))
			}
		})

		t.Run("maps a tool_result block to a tool_result item", func(t *testing.T) {
			items := normalizeLine(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_123","content":"ok output","is_error":false}]}}`)
			want := `[{"kind":"tool_result","forId":"tu_123","text":"ok output","truncated":false,"isError":false,"sidechain":false,"ts":null}]`
			if got := itemsJSON(t, items); got != want {
				t.Fatalf("got %s, want %s", got, want)
			}
		})

		t.Run("flattens array-form tool_result content and flags errors", func(t *testing.T) {
			items := normalizeLine(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}],"is_error":true}]}}`)
			if items[0].Text != "ab" || !items[0].IsError {
				t.Fatalf("got %s", itemsJSON(t, items))
			}
		})

		// a pasted image as Claude Code records it (TUI: the text first, with "[Image #1]"; the
		// bridge's to a headless one: the images first)
		img := func(mt, data string) obj {
			return obj{"type": "image", "source": obj{"type": "base64", "media_type": mt, "data": data}}
		}
		t.Run("gives a user turn's images to its last words, as data: URLs", func(t *testing.T) {
			for _, content := range [][]any{
				{obj{"type": "text", "text": "what is it?\n[Image #1]"}, img("image/png", "iVBORw0KGgo=")},
				{img("image/png", "iVBORw0KGgo="), obj{"type": "text", "text": "what is it?\n[Image #1]"}},
			} {
				items := normalizeLine(jsonLine(obj{"type": "user", "message": obj{"role": "user", "content": content}}))
				want := `[{"kind":"user","text":"what is it?\n[Image #1]","images":["data:image/png;base64,iVBORw0KGgo="],"sidechain":false,"ts":null}]`
				if got := itemsJSON(t, items); got != want {
					t.Fatalf("got %s, want %s", got, want)
				}
			}
		})
		t.Run("images alone are a user item with no text; an odd one is left out", func(t *testing.T) {
			items := normalizeLine(jsonLine(obj{"type": "user", "message": obj{"role": "user", "content": []any{
				img("image/jpeg", "/9j/4A=="), img("image/svg+xml", "PHN2Zz4="), img("image/png", `x" onerror="y`), img("image/gif", ""),
				obj{"type": "image", "source": obj{"type": "url", "media_type": "image/png", "url": "https://a.b/c.png"}},
			}}}))
			want := `[{"kind":"user","text":"","images":["data:image/jpeg;base64,/9j/4A=="],"sidechain":false,"ts":null}]`
			if got := itemsJSON(t, items); got != want {
				t.Fatalf("got %s, want %s", got, want)
			}
			if items := normalizeLine(jsonLine(obj{"type": "user", "message": obj{"role": "user", "content": []any{img("text/html", "PGI+")}}})); len(items) != 0 {
				t.Fatalf("got %s", itemsJSON(t, items))
			}
		})

		// A message sent while the agent was working, taken in mid-turn: Claude Code records it
		// only as a queued_command attachment (shape as seen in real transcripts).
		queued := func(prompt any, kind string, extra obj) string {
			mode := kind
			if kind == "human" {
				mode = "prompt"
			}
			a := obj{"type": "queued_command", "prompt": prompt, "commandMode": mode, "origin": obj{"kind": kind}}
			for k, v := range extra {
				a[k] = v
			}
			return jsonLine(obj{"type": "attachment", "isSidechain": false, "timestamp": "2026-11-23T11:52:30.000Z", "attachment": a})
		}

		t.Run("maps a message the user sent mid-turn (queued_command attachment) to a user item", func(t *testing.T) {
			items := normalizeLine(queued("Also, reply with just the word TWO.", "human", obj{"humanTurn": true}))
			ts := time.Date(2026, 11, 23, 11, 52, 30, 0, time.UTC).UnixMilli()
			want := fmt.Sprintf(`[{"kind":"user","text":"Also, reply with just the word TWO.","sidechain":false,"ts":%d}]`, ts)
			if got := itemsJSON(t, items); got != want {
				t.Fatalf("got %s, want %s", got, want)
			}
		})

		t.Run("takes the text blocks of an array-form queued prompt (e.g. with a pasted image)", func(t *testing.T) {
			items := normalizeLine(queued([]any{obj{"type": "text", "text": "look at this"}, obj{"type": "image", "source": obj{"type": "base64", "data": "x"}}}, "human", nil))
			if len(items) != 1 || items[0].Kind != "user" || items[0].Text != "look at this" {
				t.Fatalf("got %s", itemsJSON(t, items))
			}
		})

		t.Run("maps a queued command without an origin (claude -p) to a user item", func(t *testing.T) {
			l := `{"type":"attachment","attachment":{"type":"queued_command","prompt":"and then this","commandMode":"prompt"}}`
			if items := normalizeLine(l); len(items) != 1 || items[0].Kind != "user" || items[0].Text != "and then this" {
				t.Fatalf("got %s", itemsJSON(t, items))
			}
		})

		t.Run("hides the synthetic filler of a resume after a kill, not other synthetic lines", func(t *testing.T) {
			synthetic := func(text string) string {
				return jsonLine(obj{"type": "assistant", "message": obj{"model": "<synthetic>", "role": "assistant", "content": []any{obj{"type": "text", "text": text}}}})
			}
			if items := normalizeLine(synthetic("No response requested.")); len(items) != 0 {
				t.Errorf("filler: got %s", itemsJSON(t, items))
			}
			if items := normalizeLine(synthetic("API Error: Connection lost")); len(items) != 1 {
				t.Errorf("an API error: got %s", itemsJSON(t, items))
			}
		})

		t.Run("keeps queued commands that are not the user's words, and other attachments, hidden", func(t *testing.T) {
			for _, l := range []string{
				queued("<task-notification>done</task-notification>", "task-notification", nil),
				queued("message from another agent", "peer", nil),
				`{"type":"attachment","attachment":{"type":"skill_listing","content":"x"}}`,
				`{"type":"attachment"}`,
			} {
				if items := normalizeLine(l); len(items) != 0 {
					t.Errorf("%s: got %s", l, itemsJSON(t, items))
				}
			}
		})
	})

	t.Run("normalizeLine — assistant turns", func(t *testing.T) {
		t.Run("maps thinking, text and tool_use blocks in order", func(t *testing.T) {
			items := normalizeLine(`{"type":"assistant","message":{"role":"assistant","content":[` +
				`{"type":"thinking","thinking":"hmm"},` +
				`{"type":"text","text":"done"},` +
				`{"type":"tool_use","id":"tu_1","name":"Bash","input":{"command":"ls -la\nsecond line"}}]}}`)
			if k := kindsOf(items); k != "thinking,assistant,tool_use" {
				t.Fatalf("kinds %s", k)
			}
			if items[0].Text != "hmm" || items[1].Text != "done" || items[2].Name != "Bash" {
				t.Fatalf("got %s", itemsJSON(t, items))
			}
			if items[2].Summary != "ls -la" { // first line only
				t.Fatalf("summary %q", items[2].Summary)
			}
		})

		t.Run("extracts TodoWrite items", func(t *testing.T) {
			items := normalizeLine(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"x","name":"TodoWrite","input":{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"in_progress"}]}}]}}`)
			todos := items[0].Todos
			if len(todos) != 2 || todos[1] != (TodoEntry{Content: "b", Status: "in_progress"}) {
				t.Fatalf("todos %+v", todos)
			}
		})

		t.Run("truncates very long thinking and marks it", func(t *testing.T) {
			long := strings.Repeat("x", 20_000)
			items := normalizeLine(jsonLine(obj{"type": "assistant", "message": obj{"role": "assistant", "content": []any{obj{"type": "thinking", "thinking": long}}}}))
			if items[0].Kind != "thinking" || len(items[0].Text) >= len(long) || !items[0].Truncated {
				t.Fatalf("kind %s, len %d, truncated %v", items[0].Kind, len(items[0].Text), items[0].Truncated)
			}
		})

		t.Run("shows a thinking block its signature tags as narration as the assistant's words", func(t *testing.T) {
			// signatures shaped like the API's (field 2 → 1 → 8 the tag, a nonce, a trailing field)
			const said, thought = "CAQSIQoRCBQYAjgBQgluYXJyYXRpb24SDAABAgMEBQYHCAkKCxoC//8=", "CAQSIAoQCBQYAjgBQgh0aGlua2luZxIMAAECAwQFBgcICQoLGgL//w=="
			long := strings.Repeat("x", 20_000)
			for sig, want := range map[string]string{
				said:                         "assistant",
				strings.TrimRight(said, "="): "assistant", // unpadded, as atob takes it
				thought:                      "thinking",
				"CAQSIQoRCBQYAjgBQgluYXJyYXRpb24SDAABAg==": "thinking", // cut short: doesn't parse whole
				"not base64!": "thinking",
				"":            "thinking",
			} {
				items := normalizeLine(jsonLine(obj{"type": "assistant", "message": obj{"role": "assistant", "content": []any{
					obj{"type": "thinking", "thinking": long, "signature": sig}}}}))
				if len(items) != 1 || items[0].Kind != want || want == "assistant" && (items[0].Text != long || items[0].Truncated) {
					t.Errorf("%q: %s", sig, kindsOf(items))
				}
			}
		})

		t.Run("skips signature-only (empty-text) thinking blocks but keeps sibling text", func(t *testing.T) {
			// Some sessions persist redacted thinking: a signature with no plaintext.
			items := normalizeLine(`{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":"redacted-sig"},{"type":"text","text":"answer"}]}}`)
			if k := kindsOf(items); k != "assistant" {
				t.Fatalf("kinds %s", k)
			}
		})
	})

	t.Run("normalizeLine — skipped and malformed lines", func(t *testing.T) {
		t.Run("skips meta, system, and snapshot lines", func(t *testing.T) {
			for _, l := range []string{
				`{"type":"user","isMeta":true,"message":{"role":"user","content":"ctx"}}`,
				`{"type":"system","content":"hook"}`,
				`{"type":"file-history-snapshot","snapshot":{}}`,
			} {
				if items := normalizeLine(l); len(items) != 0 {
					t.Errorf("%s: got %s", l, itemsJSON(t, items))
				}
			}
		})

		t.Run("returns [] for unparseable JSON", func(t *testing.T) {
			if items := normalizeLine("not json{"); len(items) != 0 {
				t.Fatalf("got %s", itemsJSON(t, items))
			}
		})

		t.Run("returns [] for valid-but-non-object JSON without throwing", func(t *testing.T) {
			for _, l := range []string{"null", "123", `"a string"`, "[1,2,3]", "true"} {
				if items := normalizeLine(l); len(items) != 0 {
					t.Errorf("line: %s: got %s", l, itemsJSON(t, items))
				}
			}
		})

		t.Run("carries the sidechain flag from isSidechain", func(t *testing.T) {
			items := normalizeLine(`{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sub"}]}}`)
			if !items[0].Sidechain {
				t.Fatal("sidechain false")
			}
		})
	})

	t.Run("summarizeToolInput", func(t *testing.T) {
		t.Run("summarizes common tools by their key field", func(t *testing.T) {
			for _, c := range []struct{ name, input, want string }{
				{"Read", `{"file_path":"/a/b.ts"}`, "/a/b.ts"},
				{"Grep", `{"pattern":"foo","path":"src"}`, "foo in src"},
				{"Task", `{"subagent_type":"Explore","description":"find x"}`, "Explore: find x"},
			} {
				if got := summarizeToolInput(c.name, mustParse(t, c.input)); got != c.want {
					t.Errorf("%s: got %q, want %q", c.name, got, c.want)
				}
			}
		})

		t.Run("falls back to the first string field for unknown tools", func(t *testing.T) {
			if got := summarizeToolInput("Mystery", mustParse(t, `{"note":"hello","n":3}`)); got != "hello" {
				t.Fatalf("got %q", got)
			}
		})
	})
}

// Go-only: the JavaScript semantics the port reproduces by hand.
func TestTranscriptNormalizeJSSemantics(t *testing.T) {
	for _, c := range []struct{ name, input, want string }{
		// Object.values order: the line's key order, array-index keys first
		{"Skill", `{"skill":"review","args":"x"}`, "review"},
		{"Mystery", `{"b":1,"2":1,"a":1,"1":1}`, "1, 2, b, a"},
		{"Mystery", `["", "second"]`, "second"},
		{"Mystery", `[1, 2]`, "0, 1"},
		{"Grep", `{"pattern":"p","path":0}`, "p"},
		{"Grep", `{"pattern":"p","path":5}`, "p in "},
		{"Task", `{"description":"d"}`, "d"},
		// UTF-16 length: 199 'x' + an emoji is 201 units; the emoji isn't split
		{"Bash", `{"command":"` + strings.Repeat("x", 199) + `😀"}`, strings.Repeat("x", 199) + "…"},
	} {
		if got := summarizeToolInput(c.name, mustParse(t, c.input)); got != c.want {
			t.Errorf("%s %s: got %q, want %q", c.name, c.input, got, c.want)
		}
	}
	for _, s := range []string{`{"a":1,}`, `{"a" 1}`, `[1 2]`, `{} {}`, `{}x`, `{"a":"` + "\x01" + `"}`, ``} {
		if _, ok := jsonParse(s); ok {
			t.Errorf("jsonParse(%q) should fail", s)
		}
	}
	// String.prototype.trim: strips U+FEFF, keeps U+0085
	items := normalizeLine(`{"type":"user","message":{"content":"\ufeff hi \u0085"}}`)
	if len(items) != 1 || items[0].Text != "hi \u0085" {
		t.Errorf("got %s", itemsJSON(t, items))
	}
	// tool_use_id "" is a string (forId ""), a missing one is null
	items = normalizeLine(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":""},{"type":"tool_result"}]}}`)
	if got := itemsJSON(t, items); !strings.Contains(got, `"forId":"",`) || !strings.Contains(got, `"forId":null,`) {
		t.Errorf("got %s", got)
	}
}
