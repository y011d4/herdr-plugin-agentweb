package bridge

import (
	"bytes"
	"encoding/json"
	"reflect"
	"testing"
)

func TestNDJSON(t *testing.T) {
	eq := func(t *testing.T, got []string, want ...string) {
		t.Helper()
		if want == nil {
			want = []string{}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("got %q, want %q", got, want)
		}
	}

	t.Run("createSplitter", func(t *testing.T) {
		t.Run("emits a complete line when chunk contains newline", func(t *testing.T) {
			var s splitter
			eq(t, s.push(`{"a":1}`+"\n"), `{"a":1}`)
		})

		t.Run("buffers partial lines across chunks", func(t *testing.T) {
			var s splitter
			eq(t, s.push(`{"a":`))
			eq(t, s.push("1}\n"), `{"a":1}`)
		})

		t.Run("emits multiple lines from a single chunk", func(t *testing.T) {
			var s splitter
			eq(t, s.push(`{"a":1}`+"\n"+`{"b":2}`+"\n"+`{"c":3}`+"\n"), `{"a":1}`, `{"b":2}`, `{"c":3}`)
		})

		t.Run("handles a split across the newline boundary", func(t *testing.T) {
			var s splitter
			eq(t, s.push(`{"x":1}`))
			eq(t, s.push("\n"), `{"x":1}`)
		})

		t.Run("handles two lines split across multiple small chunks", func(t *testing.T) {
			var s splitter
			var collected []string
			for _, c := range []string{`{"i`, `d":1}`, "\n" + `{"id"`, ":2}\n"} {
				collected = append(collected, s.push(c)...)
			}
			eq(t, collected, `{"id":1}`, `{"id":2}`)
		})

		t.Run("ignores empty lines", func(t *testing.T) {
			var s splitter
			eq(t, s.push("\n\n"+`{"a":1}`+"\n\n"), `{"a":1}`)
		})

		t.Run("reset clears internal buffer", func(t *testing.T) {
			var s splitter
			s.push(`{"partial"`)
			s.reset()
			eq(t, s.push(`{"fresh":1}`+"\n"), `{"fresh":1}`)
		})

		t.Run("handles lines delivered one byte at a time", func(t *testing.T) {
			var s splitter
			collected := []string{}
			for _, ch := range `{"v":42}` + "\n" {
				collected = append(collected, s.push(string(ch))...)
			}
			eq(t, collected, `{"v":42}`)
		})
	})

	t.Run("serialize", func(t *testing.T) {
		t.Run("appends a newline", func(t *testing.T) {
			line, err := serialize(map[string]any{"a": 1})
			if err != nil || !bytes.HasSuffix(line, []byte("\n")) {
				t.Errorf("got %q (%v)", line, err)
			}
		})

		t.Run("produces valid JSON before the newline", func(t *testing.T) {
			line, err := serialize(map[string]any{"x": "hello"})
			var got map[string]any
			if err != nil || json.Unmarshal(bytes.TrimRight(line, "\n"), &got) != nil ||
				!reflect.DeepEqual(got, map[string]any{"x": "hello"}) {
				t.Errorf("got %q (%v)", line, err)
			}
		})
	})
}
