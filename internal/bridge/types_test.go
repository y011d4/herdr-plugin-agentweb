package bridge

import (
	"regexp"
	"testing"
)

func TestJSStringHelpers(t *testing.T) {
	for _, c := range []struct {
		s    string
		n    int
		want string
	}{
		{"hello", 3, "hel"},
		{"日本語です", 2, "日本"},
		{"a😀b", 2, "a"}, // the emoji is two units: never split
		{"a😀b", 3, "a😀"},
		{"short", 10, "short"},
	} {
		if got := jsSlice(c.s, c.n); got != c.want {
			t.Errorf("jsSlice(%q, %d) = %q, want %q", c.s, c.n, got, c.want)
		}
	}
	if n := jsLen("a😀日"); n != 4 {
		t.Errorf("jsLen = %d, want 4", n)
	}
	if !regexp.MustCompile(`^[` + jsSpace + `]+$`).MatchString("　  \t") {
		t.Error("jsSpace should match ideographic and no-break spaces")
	}
}
