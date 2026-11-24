package bridge

// A port of server/ndjson.ts: NDJSON (newline-delimited JSON) split and serialize.

import (
	"bytes"
	"encoding/json"
	"strings"
)

// splitter accumulates chunks and emits complete lines. The zero value is ready.
type splitter struct{ buf string }

// push adds a chunk and returns the complete, non-empty lines it finished.
func (s *splitter) push(chunk string) []string {
	lines := strings.Split(s.buf+chunk, "\n")
	s.buf = lines[len(lines)-1] // incomplete (or empty after a trailing newline)
	out := []string{}
	for _, l := range lines[:len(lines)-1] {
		if l != "" {
			out = append(out, l)
		}
	}
	return out
}

func (s *splitter) reset() { s.buf = "" }

// serialize is one NDJSON line: v as JSON, then a newline.
func serialize(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false) // JSON.stringify leaves < > & as they are
	err := enc.Encode(v)     // appends the newline
	return b.Bytes(), err
}
