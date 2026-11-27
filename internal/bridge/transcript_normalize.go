package bridge

// Pure transcript normalizer, a port of server/transcript-normalize.ts. No I/O.
//
// Turns one line of a Claude Code JSONL session transcript
// (~/.claude/projects/<slug>/<sessionId>.jsonl) into zero or more display-ready
// TimelineItems for the PWA's chat view.
//
// The JSONL format is Claude Code's own, private and undocumented: tolerate
// unknown line/block types by skipping them (forward compatibility) rather than
// failing. Only the fields we render are read. Lines are decoded into plain JSON
// values (jsObject, []any, string, json.Number, bool, nil) and inspected the way
// the TypeScript does at runtime (typeof, === true, truthiness).

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Cap oversized fields so a single line can't bloat a WS frame. Conversational
// text (user/assistant) is the content itself and kept whole; thinking and tool
// results are previews and truncated. Lengths are in UTF-16 code units, like JS.
const (
	thinkingMax = 8_000
	resultMax   = 4_000
	summaryMax  = 200
)

// narration: whether a thinking block is the words the model says to the user between its tool
// calls (an explanation before a question, say), which Claude Code shows as its reply. The API
// tags it in the signature (base64 protobuf): the string at field 2 → 1 → 8 is "narration", where
// thinking has "thinking" (Claude Code 2.1.322's classifier; the transcript has no other mark).
func narration(signature string) bool {
	b, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(signature, "="))
	for _, field := range []uint64{2, 1, 8} {
		if err != nil || b == nil {
			return false
		}
		b = protoBytes(b, field)
	}
	return string(b) == "narration"
}

// protoBytes is the last length-delimited value of field n in the protobuf message b; nil when it
// has none or doesn't parse whole.
func protoBytes(b []byte, n uint64) []byte {
	var found []byte
	for len(b) > 0 {
		key, k := binary.Uvarint(b)
		if k <= 0 {
			return nil
		}
		b = b[k:]
		size := 0
		switch key & 7 {
		case 0:
			if _, k = binary.Uvarint(b); k <= 0 {
				return nil
			}
			size = k
		case 1:
			size = 8
		case 2:
			l, k := binary.Uvarint(b)
			if k <= 0 || l > uint64(len(b)-k) {
				return nil
			}
			if key>>3 == n {
				found = b[k : k+int(l)]
			}
			size = k + int(l)
		case 5:
			size = 4
		default:
			return nil
		}
		if size > len(b) {
			return nil
		}
		b = b[size:]
	}
	return found
}

// ── JSON.parse, JavaScript-style ─────────────────────────────────────────────

// jsObject is a decoded JSON object that keeps JavaScript's key order, which
// summarizeToolInput's fallback depends on (Object.values / Object.keys).
type jsObject struct {
	keys []string // first-occurrence order; a duplicate key keeps its place, last value wins
	vals map[string]any
}

// jsGet is `v.k` on a decoded value: nil (undefined) unless v is an object.
func jsGet(v any, k string) any {
	if o, ok := v.(*jsObject); ok {
		return o.vals[k]
	}
	return nil
}

// jsEntries is Object.keys and Object.values: array-index keys first in numeric
// order, then the rest in insertion order. For an array, its indices and elements.
func jsEntries(v any) (keys []string, vals []any) {
	switch x := v.(type) {
	case *jsObject:
		keys = append(keys, x.keys...)
		sort.SliceStable(keys, func(i, j int) bool {
			a, aIdx := jsArrayIndex(keys[i])
			b, bIdx := jsArrayIndex(keys[j])
			return aIdx && (!bIdx || a < b)
		})
		for _, k := range keys {
			vals = append(vals, x.vals[k])
		}
	case []any:
		for i := range x {
			keys = append(keys, strconv.Itoa(i))
		}
		vals = x
	}
	return keys, vals
}

func jsArrayIndex(k string) (uint64, bool) {
	if k == "" || (len(k) > 1 && k[0] == '0') {
		return 0, false
	}
	n, err := strconv.ParseUint(k, 10, 32)
	return n, err == nil && n < 1<<32-1
}

// jsTruthy is JavaScript truthiness for a decoded JSON value.
func jsTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, _ := strconv.ParseFloat(string(x), 64) // out of range: ±Inf (truthy) or 0
		return f != 0
	case float64: // encoding/json's numbers (config.json)
		return x != 0 && x == x
	}
	return true // objects and arrays
}

// jsonParse is JSON.parse: ok=false for anything JSON.parse would throw on.
// ponytail: Token-based, ~3x slower than V8 on a 2 MiB tail (tens of ms); a
// hand-rolled scanner if transcript reads ever show up in profiles.
func jsonParse(s string) (any, bool) {
	d := json.NewDecoder(strings.NewReader(s))
	d.UseNumber() // never fail on a number JS would accept (e.g. 1e400)
	v, err := jsonValue(d, 0)
	if err != nil {
		return nil, false
	}
	if _, err := d.Token(); err != io.EOF { // trailing data
		return nil, false
	}
	return v, true
}

func jsonValue(d *json.Decoder, depth int) (any, error) {
	if depth > 10_000 { // encoding/json's nesting limit (V8 has none; no real line nests so deep)
		return nil, errors.New("json: nesting too deep")
	}
	t, err := d.Token()
	if err != nil {
		return nil, err
	}
	switch t {
	case json.Delim('{'):
		o := &jsObject{vals: map[string]any{}}
		for d.More() {
			kt, err := d.Token()
			if err != nil {
				return nil, err
			}
			k := kt.(string)
			v, err := jsonValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			if _, dup := o.vals[k]; !dup {
				o.keys = append(o.keys, k)
			}
			o.vals[k] = v
		}
		_, err := d.Token() // '}'
		return o, err
	case json.Delim('['):
		a := []any{}
		for d.More() {
			v, err := jsonValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			a = append(a, v)
		}
		_, err := d.Token() // ']'
		return a, err
	}
	return t, nil // string, json.Number, bool or nil
}

// ── normalizer ───────────────────────────────────────────────────────────────

func truncateUnits(s string, max int) (string, bool) {
	if jsLen(s) <= max {
		return s, false
	}
	return jsSlice(s, max), true
}

// toMs is Date.parse of a transcript timestamp, or nil. Claude Code writes
// toISOString() (RFC 3339 in UTC); the other forms Date.parse accepts aren't read.
func toMs(timestamp any) *int64 {
	s, ok := timestamp.(string)
	if !ok {
		return nil
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return nil
	}
	ms := t.UnixMilli()
	return &ms
}

func strOr(v any, def string) string {
	if s, ok := v.(string); ok {
		return s
	}
	return def
}

// summarizeToolInput is a short one-line summary of a tool call, tuned per
// well-known tool.
func summarizeToolInput(name string, input any) string {
	switch input.(type) {
	case *jsObject, []any:
	default:
		return ""
	}
	str := func(k string) string { return strOr(jsGet(input, k), "") }
	var s string
	switch name {
	case "Bash":
		s, _, _ = strings.Cut(str("command"), "\n")
	case "Read", "Edit", "Write", "NotebookEdit":
		s = str("file_path")
	case "Glob", "Grep":
		s = str("pattern")
		if jsTruthy(jsGet(input, "path")) {
			s += " in " + str("path")
		}
	case "Task":
		s = strings.TrimPrefix(str("subagent_type")+": "+str("description"), ": ")
	case "TodoWrite":
		if todos, ok := jsGet(input, "todos").([]any); ok {
			s = strconv.Itoa(len(todos)) + " items"
		}
	case "AskUserQuestion":
		var q0 any
		if qs, ok := jsGet(input, "questions").([]any); ok && len(qs) > 0 {
			q0 = qs[0]
		}
		s = firstNonEmpty(strOr(jsGet(q0, "question"), ""), strOr(jsGet(q0, "header"), ""))
	case "WebFetch", "WebSearch":
		s = firstNonEmpty(str("url"), str("query"))
	default:
		// generic: first string-valued field, else compact key list
		keys, vals := jsEntries(input)
		s = strings.Join(keys, ", ")
		for _, v := range vals {
			if vs, ok := v.(string); ok && vs != "" {
				s, _, _ = strings.Cut(vs, "\n")
				break
			}
		}
	}
	if jsLen(s) > summaryMax {
		return jsSlice(s, summaryMax) + "…"
	}
	return s
}

func extractTodos(input any) []TodoEntry {
	todos, ok := jsGet(input, "todos").([]any)
	if !ok {
		return nil
	}
	out := make([]TodoEntry, 0, len(todos))
	for _, t := range todos {
		out = append(out, TodoEntry{Content: strOr(jsGet(t, "content"), ""), Status: strOr(jsGet(t, "status"), "")})
	}
	return out
}

func extractAsk(input any) []AskQuestion {
	questions, ok := jsGet(input, "questions").([]any)
	if !ok {
		return nil
	}
	out := make([]AskQuestion, 0, len(questions))
	for _, q := range questions {
		opts, _ := jsGet(q, "options").([]any)
		options := make([]AskOption, 0, len(opts))
		for _, op := range opts {
			options = append(options, AskOption{Label: strOr(jsGet(op, "label"), ""), Description: strOr(jsGet(op, "description"), "")})
		}
		out = append(out, AskQuestion{
			Question:    strOr(jsGet(q, "question"), ""),
			Header:      strOr(jsGet(q, "header"), ""),
			MultiSelect: jsGet(q, "multiSelect") == true,
			Options:     options,
		})
	}
	return out
}

// toolResultText flattens a tool_result content field (string, or array of
// text/blocks) to text.
func toolResultText(content any) string {
	switch c := content.(type) {
	case string:
		return c
	case []any:
		var b strings.Builder
		for _, block := range c {
			if t, ok := jsGet(block, "text").(string); ok {
				b.WriteString(t)
			} else if jsGet(block, "type") == "image" {
				b.WriteString("[image]")
			}
		}
		return b.String()
	}
	return ""
}

var base64Data = regexp.MustCompile(`^[A-Za-z0-9+/]+={0,2}$`)

// imageURL is a user's image block as a data: URL, or "" for any other source or type: it goes
// into an <img src>.
func imageURL(block any) string {
	src := jsGet(block, "source")
	mt, _ := jsGet(src, "media_type").(string)
	data, _ := jsGet(src, "data").(string)
	if jsGet(src, "type") != "base64" || !slices.Contains([]string{"image/jpeg", "image/png", "image/gif", "image/webp"}, mt) || !base64Data.MatchString(data) {
		return ""
	}
	return "data:" + mt + ";base64," + data
}

// userItems is a user turn's content (a string, or text / image / tool_result blocks) as
// TimelineItems. Its images go with its last words, or alone.
func userItems(content any, sidechain bool, ts *int64) []TimelineItem {
	var out []TimelineItem
	switch c := content.(type) {
	case string:
		if text := jsTrim(c); text != "" {
			out = append(out, TimelineItem{Kind: "user", Text: text, Sidechain: sidechain, TS: ts})
		}
	case []any:
		var images []string
		for _, b := range c {
			switch jsGet(b, "type") {
			case "image":
				if url := imageURL(b); url != "" {
					images = append(images, url)
				}
			case "text":
				if t, ok := jsGet(b, "text").(string); ok && jsTrim(t) != "" {
					out = append(out, TimelineItem{Kind: "user", Text: t, Sidechain: sidechain, TS: ts})
				}
			case "tool_result":
				text, truncated := truncateUnits(toolResultText(jsGet(b, "content")), resultMax)
				var forID *string
				if id, ok := jsGet(b, "tool_use_id").(string); ok {
					forID = &id
				}
				out = append(out, TimelineItem{
					Kind: "tool_result", ForID: forID, Text: text, Truncated: truncated,
					IsError: jsGet(b, "is_error") == true, Sidechain: sidechain, TS: ts,
				})
			}
		}
		if n := len(out); len(images) > 0 && n > 0 && out[n-1].Kind == "user" {
			out[n-1].Images = images
		} else if len(images) > 0 {
			out = append(out, TimelineItem{Kind: "user", Images: images, Sidechain: sidechain, TS: ts})
		}
	}
	return out
}

// normalizeLine maps one raw JSONL line to zero or more TimelineItems: none for
// lines we don't render (meta, system, snapshots, unparseable).
func normalizeLine(rawLine string) []TimelineItem {
	o, _ := jsonParse(rawLine)
	// A valid-but-non-object line (null, array, number, string) has no fields to read.
	if _, ok := o.(*jsObject); !ok {
		return nil
	}
	// Injected context / bookkeeping lines are not conversation.
	if jsGet(o, "isMeta") == true {
		return nil
	}
	typ := jsGet(o, "type")
	if typ == "system" || typ == "summary" || typ == "file-history-snapshot" {
		return nil
	}

	sidechain := jsGet(o, "isSidechain") == true
	ts := toMs(jsGet(o, "timestamp"))

	// A message the user sent while the agent was working, taken in mid-turn (at a tool
	// boundary): Claude Code records it only as this attachment, never as a `user` line.
	// Other queued commands (task notifications, messages from peer agents) aren't the
	// user's words and stay hidden. Under claude -p (a headless orchestrator) the user's has
	// no origin at all; the others always have one.
	if typ == "attachment" {
		a := jsGet(o, "attachment")
		if origin := jsGet(a, "origin"); jsGet(a, "type") != "queued_command" || origin != nil && jsGet(origin, "kind") != "human" {
			return nil
		}
		return userItems(jsGet(a, "prompt"), sidechain, ts)
	}

	message := jsGet(o, "message")
	switch typ {
	case "user":
		return userItems(jsGet(message, "content"), sidechain, ts)
	case "assistant":
		content, _ := jsGet(message, "content").([]any)
		// the filler a --resume after a kill adds (Claude Code's other synthetic lines, API
		// errors and limits, are for the user to read)
		if jsGet(message, "model") == "<synthetic>" && len(content) == 1 && jsGet(content[0], "text") == "No response requested." {
			return nil
		}
		var out []TimelineItem
		for _, b := range content {
			switch jsGet(b, "type") {
			case "thinking":
				t, ok := jsGet(b, "thinking").(string)
				if !ok || jsTrim(t) == "" {
					break
				}
				if narration(strOr(jsGet(b, "signature"), "")) { // said to the user: its reply, kept whole
					out = append(out, TimelineItem{Kind: "assistant", Text: t, Sidechain: sidechain, TS: ts})
				} else {
					text, truncated := truncateUnits(t, thinkingMax)
					out = append(out, TimelineItem{Kind: "thinking", Text: text, Truncated: truncated, Sidechain: sidechain, TS: ts})
				}
			case "text":
				if t, ok := jsGet(b, "text").(string); ok && jsTrim(t) != "" {
					out = append(out, TimelineItem{Kind: "assistant", Text: t, Sidechain: sidechain, TS: ts})
				}
			case "tool_use":
				name := strOr(jsGet(b, "name"), "tool")
				input := jsGet(b, "input")
				item := TimelineItem{
					Kind: "tool_use", ID: strOr(jsGet(b, "id"), ""), Name: name,
					Summary: summarizeToolInput(name, input), Sidechain: sidechain, TS: ts,
				}
				if name == "TodoWrite" {
					item.Todos = extractTodos(input)
				}
				if name == "AskUserQuestion" {
					item.Ask = extractAsk(input)
				}
				out = append(out, item)
			}
		}
		return out
	}
	return nil
}
