package bridge

import (
	"bufio"
	"os"
	"os/exec"
	"runtime"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// userLine is one JSONL line (a minimal user turn) with the given text.
func userLine(text string) string {
	return jsonLine(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}})
}

func itemTexts(items []TimelineItem) []string {
	out := []string{}
	for _, i := range items {
		out = append(out, i.Text)
	}
	return out
}

func writeFile(t *testing.T, path, data string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

func appendFile(t *testing.T, path, data string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(data); err != nil {
		t.Fatal(err)
	}
}

func realPath(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestTranscript(t *testing.T) {
	dir := t.TempDir()
	// The projects roots under the home dir: an empty temp home, so resolve's
	// fallback scan never reads the real ~/.claude.
	defer func(h string) { claudeHome = h }(claudeHome)
	claudeHome = t.TempDir()

	t.Run("slugForCwd", func(t *testing.T) {
		t.Run("replaces / . _ with - (case preserved)", func(t *testing.T) {
			if got := slugForCwd("/home/y011d4/ghq/github.com/y011d4/herdr-plugin-mobile"); got != "-home-y011d4-ghq-github-com-y011d4-herdr-plugin-mobile" {
				t.Errorf("got %q", got)
			}
			if got := slugForCwd("/a/b_c.d"); got != "-a-b-c-d" {
				t.Errorf("got %q", got)
			}
		})
	})

	t.Run("resolveTranscriptPath — symlink containment", func(t *testing.T) {
		const cwd = "/w/proj"
		t.Run("resolves a regular transcript file under the root", func(t *testing.T) {
			root := t.TempDir()
			proj := filepath.Join(root, slugForCwd(cwd))
			os.MkdirAll(proj, 0o755)
			f := filepath.Join(proj, "sessone.jsonl")
			writeFile(t, f, userLine("hi")+"\n")
			if got := resolveTranscriptPath("sessone", cwd, []string{root}); got != realPath(t, f) {
				t.Errorf("got %q", got)
			}
		})

		t.Run("rejects a transcript that is a symlink escaping the root", func(t *testing.T) {
			root := t.TempDir()
			outside := t.TempDir()
			secret := filepath.Join(outside, "secret.jsonl")
			writeFile(t, secret, userLine("secret")+"\n")
			proj := filepath.Join(root, slugForCwd(cwd))
			os.MkdirAll(proj, 0o755)
			if err := os.Symlink(secret, filepath.Join(proj, "sesstwo.jsonl")); err != nil { // points outside the root
				t.Fatal(err)
			}
			if got := resolveTranscriptPath("sesstwo", cwd, []string{root}); got != "" {
				t.Errorf("got %q", got)
			}
		})

		t.Run("allows a symlink whose target stays inside the root", func(t *testing.T) {
			root := t.TempDir()
			proj := filepath.Join(root, slugForCwd(cwd))
			os.MkdirAll(proj, 0o755)
			real := filepath.Join(proj, "real.jsonl")
			writeFile(t, real, userLine("ok")+"\n")
			if err := os.Symlink(real, filepath.Join(proj, "sessthree.jsonl")); err != nil { // target inside the root
				t.Fatal(err)
			}
			if got := resolveTranscriptPath("sessthree", cwd, []string{root}); got != realPath(t, real) {
				t.Errorf("got %q", got)
			}
		})
	})

	t.Run("readTranscriptTail", func(t *testing.T) {
		t.Run("returns all items with the cursor at EOF for a newline-terminated file", func(t *testing.T) {
			f := filepath.Join(dir, "a.jsonl")
			writeFile(t, f, userLine("one")+"\n"+userLine("two")+"\n")
			tail := readTranscriptTail(f, 300)
			if got := itemTexts(tail.Items); !slices.Equal(got, []string{"one", "two"}) || tail.Truncated {
				t.Fatalf("got %q, truncated %v", got, tail.Truncated)
			}
			// cursor at EOF → a follow-up read finds nothing new
			if n := len(readTranscriptFrom(f, tail.Cursor, 300).Items); n != 0 {
				t.Fatalf("re-read %d items", n)
			}
		})

		t.Run("leaves a trailing partial line unconsumed (cursor before it)", func(t *testing.T) {
			f := filepath.Join(dir, "b.jsonl")
			partial := userLine("incomplete") // no trailing newline
			writeFile(t, f, userLine("done")+"\n"+partial)
			tail := readTranscriptTail(f, 300)
			if got := itemTexts(tail.Items); !slices.Equal(got, []string{"done"}) {
				t.Fatalf("got %q", got)
			}
			// completing the partial line makes it appear on the next incremental read
			appendFile(t, f, "\n")
			if got := itemTexts(readTranscriptFrom(f, tail.Cursor, 300).Items); !slices.Equal(got, []string{"incomplete"}) {
				t.Fatalf("next %q", got)
			}
		})

		t.Run("slices to the last maxItems and flags truncated", func(t *testing.T) {
			f := filepath.Join(dir, "c.jsonl")
			var lines []string
			for i := range 10 {
				lines = append(lines, userLine("m"+strconv.Itoa(i)))
			}
			writeFile(t, f, strings.Join(lines, "\n")+"\n")
			tail := readTranscriptTail(f, 3)
			if got := itemTexts(tail.Items); !slices.Equal(got, []string{"m7", "m8", "m9"}) || !tail.Truncated {
				t.Fatalf("got %q, truncated %v", got, tail.Truncated)
			}
		})

		t.Run("bounds a large file to the byte cap and keeps the recent tail", func(t *testing.T) {
			f := filepath.Join(dir, "big.jsonl")
			// ~2.4 MB of ~1 KB lines — larger than tailMaxBytes (2 MB).
			writeFile(t, f, numberedLines(2400))
			tail := readTranscriptTail(f, 300)
			if len(tail.Items) != 300 || !tail.Truncated {
				t.Fatalf("%d items, truncated %v", len(tail.Items), tail.Truncated)
			}
			// the tail must be the most recent lines, and end exactly at line 2399
			if last := tail.Items[len(tail.Items)-1].Text; !strings.HasPrefix(last, "2399-") {
				t.Fatalf("last %.20q", last)
			}
			// cursor sits at EOF (file ends with a newline) → no phantom re-read
			if n := len(readTranscriptFrom(f, tail.Cursor, 300).Items); n != 0 {
				t.Fatalf("re-read %d items", n)
			}
		})
	})

	t.Run("readTranscriptFrom — byte cursor with multi-byte UTF-8", func(t *testing.T) {
		t.Run("advances the cursor by exact byte length across multi-byte chars", func(t *testing.T) {
			f := filepath.Join(dir, "utf8.jsonl")
			writeFile(t, f, userLine("café ☕ 日本語")+"\n")
			first := readTranscriptTail(f, 300)
			if len(first.Items) != 1 {
				t.Fatalf("%d items", len(first.Items))
			}
			// append another multi-byte line and confirm only it comes back
			appendFile(t, f, userLine("二行目 🎉")+"\n")
			inc := readTranscriptFrom(f, first.Cursor, 300)
			if got := itemTexts(inc.Items); !slices.Equal(got, []string{"二行目 🎉"}) || inc.Reset {
				t.Fatalf("got %q, reset %v", got, inc.Reset)
			}
			// and the cursor is now at EOF
			if n := len(readTranscriptFrom(f, inc.Cursor, 300).Items); n != 0 {
				t.Fatalf("re-read %d items", n)
			}
		})

		t.Run("keeps the cursor byte-exact when the tail ends mid multi-byte char (no replay)", func(t *testing.T) {
			f := filepath.Join(dir, "mb-partial.jsonl")
			line := userLine("done") + "\n"
			writeFile(t, f, line)
			afterLine := int64(len(line))
			// append the first 2 of the 3 bytes of ☕ (e2 98 95) — an unterminated char
			appendFile(t, f, "\xe2\x98")
			tail := readTranscriptTail(f, 300)
			if got := itemTexts(tail.Items); !slices.Equal(got, []string{"done"}) {
				t.Fatalf("got %q", got)
			}
			// cursor must sit exactly after the complete line's newline
			if tail.Cursor != afterLine {
				t.Fatalf("cursor %d, want %d", tail.Cursor, afterLine)
			}
			// an incremental read from there must not replay 'done'
			if n := len(readTranscriptFrom(f, tail.Cursor, 300).Items); n != 0 {
				t.Fatalf("replayed %d items", n)
			}
		})
	})

	t.Run("readTranscriptFrom — bounded when the cursor is far behind", func(t *testing.T) {
		t.Run("returns a rebuilt tail with reset=true when the gap exceeds the cap", func(t *testing.T) {
			f := filepath.Join(dir, "gap.jsonl")
			writeFile(t, f, numberedLines(2400))
			// after=0 on a >2 MB file: must not stream the whole file
			r := readTranscriptFrom(f, 0, 300)
			if !r.Reset || len(r.Items) != 300 || !strings.HasPrefix(r.Items[len(r.Items)-1].Text, "2399-") {
				t.Fatalf("reset %v, %d items", r.Reset, len(r.Items))
			}
			// a small gap does not reset
			tail := readTranscriptTail(f, 300)
			near := readTranscriptFrom(f, tail.Cursor, 300)
			if near.Reset || len(near.Items) != 0 {
				t.Fatalf("near: reset %v, %d items", near.Reset, len(near.Items))
			}
		})

		t.Run("treats an unreadable file as no-update, never an empty reset", func(t *testing.T) {
			missing := filepath.Join(dir, "does-not-exist.jsonl")
			r := readTranscriptFrom(missing, 12345, 300)
			if r.Reset { // must NOT clear the client's log
				t.Fatal("reset")
			}
			if r.Cursor != 12345 { // cursor preserved, not rewound to 0
				t.Fatalf("cursor %d", r.Cursor)
			}
			if len(r.Items) != 0 || len(readTranscriptTail(missing, 300).Items) != 0 {
				t.Fatal("items from a missing file")
			}
		})

		t.Run("does not reset past a single >cap unterminated line (no skip)", func(t *testing.T) {
			f := filepath.Join(dir, "giant.jsonl")
			first := userLine("first")
			writeFile(t, f, first+"\n") // one complete line
			afterFirst := int64(len(first) + 1)
			// a single unterminated line larger than the 2 MB cap
			appendFile(t, f, strings.Repeat("y", 2_300_000))
			stuck := readTranscriptFrom(f, afterFirst, 300)
			if stuck.Reset || stuck.Cursor != afterFirst || len(stuck.Items) != 0 {
				// no complete line in the window → no reset, cursor not advanced past the unshown line
				t.Fatalf("stuck: reset %v, cursor %d, %d items", stuck.Reset, stuck.Cursor, len(stuck.Items))
			}
			// once the giant line ends and a normal line follows, progress resumes
			appendFile(t, f, "\n"+userLine("next")+"\n")
			resumed := readTranscriptFrom(f, afterFirst, 300)
			if !resumed.Reset || !slices.Contains(itemTexts(resumed.Items), "next") || resumed.Cursor <= afterFirst {
				t.Fatalf("resumed: reset %v, cursor %d, %q", resumed.Reset, resumed.Cursor, itemTexts(resumed.Items))
			}
		})

		t.Run("advances the cursor over a large all-skipped tail without resetting", func(t *testing.T) {
			f := filepath.Join(dir, "meta.jsonl")
			first := userLine("first")
			writeFile(t, f, first+"\n")
			afterFirst := int64(len(first) + 1)
			// >2 MB of complete lines that normalize to nothing (system/meta)
			metaLine := jsonLine(map[string]any{"type": "system", "content": strings.Repeat("x", 500)})
			var chunks []string
			for bytes := 0; bytes < 2_300_000; bytes += len(metaLine) + 1 {
				chunks = append(chunks, metaLine)
			}
			appendFile(t, f, strings.Join(chunks, "\n")+"\n")
			r := readTranscriptFrom(f, afterFirst, 300)
			if r.Reset || len(r.Items) != 0 { // nothing renderable → don't clear the log
				t.Fatalf("reset %v, %d items", r.Reset, len(r.Items))
			}
			if r.Cursor <= afterFirst { // but the cursor advances — no re-read loop
				t.Fatalf("cursor %d", r.Cursor)
			}
		})

		t.Run("advances past a completed >cap line with no following line (no loop)", func(t *testing.T) {
			f := filepath.Join(dir, "giant-done.jsonl")
			first := userLine("first")
			writeFile(t, f, first+"\n")
			afterFirst := int64(len(first) + 1)
			// a single COMPLETE line larger than the cap, terminated, with nothing after
			content := first + "\n" + strings.Repeat("z", 2_300_000) + "\n"
			writeFile(t, f, content)
			size := int64(len(content))
			r := readTranscriptFrom(f, afterFirst, 300)
			if r.Reset || len(r.Items) != 0 { // giant line is unrenderable → no reset
				t.Fatalf("reset %v, %d items", r.Reset, len(r.Items))
			}
			if r.Cursor != size { // cursor advances to EOF past the completed line
				t.Fatalf("cursor %d, want %d", r.Cursor, size)
			}
			// and a follow-up read finds nothing new — no re-read loop
			if next := readTranscriptFrom(f, r.Cursor, 300); len(next.Items) != 0 || next.Reset {
				t.Fatalf("next: reset %v, %d items", next.Reset, len(next.Items))
			}
		})
	})

	t.Run("findLastItem (backward scan past the tail window)", func(t *testing.T) {
		asstLine := func(text string) string {
			return jsonLine(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}}})
		}
		isUser := func(i TimelineItem) bool { return i.Kind == "user" }

		t.Run("finds the newest matching item across 1 MiB chunk boundaries, even a multi-byte one", func(t *testing.T) {
			file := filepath.Join(dir, "scan.jsonl")
			filler := asstLine(strings.Repeat("x", 500)) + "\n"
			// the request, then ~2.5 MB of assistant output: beyond the 2 MB tail window
			writeFile(t, file, userLine("older")+"\n"+userLine("本当の依頼 ✓")+"\n"+strings.Repeat(filler, 5000))
			if slices.ContainsFunc(readTranscriptTail(file, 1000).Items, isUser) {
				t.Fatal("the request is still in the tail")
			}
			if hit := findLastItem(file, isUser, findLastItemMaxBytes); hit == nil || hit.Kind != "user" || hit.Text != "本当の依頼 ✓" {
				t.Fatalf("hit %+v", hit)
			}
		})

		t.Run("finds a message the user sent mid-turn (queued_command attachment) past the tail window", func(t *testing.T) {
			file := filepath.Join(dir, "scan-queued.jsonl")
			// as Claude Code writes it: no "user" anywhere in the raw line
			queued := `{"type":"attachment","isSidechain":false,"attachment":{"type":"queued_command","prompt":"also do this","commandMode":"prompt","origin":{"kind":"human"}}}`
			if strings.Contains(queued, `"user"`) {
				t.Fatal(`queued line contains "user"`)
			}
			writeFile(t, file, userLine("first request")+"\n"+queued+"\n"+strings.Repeat(asstLine(strings.Repeat("z", 500))+"\n", 5000))
			if slices.ContainsFunc(readTranscriptTail(file, 1000).Items, isUser) {
				t.Fatal("the request is still in the tail")
			}
			if hit := findLastItem(file, isUser, findLastItemMaxBytes); hit == nil || hit.Kind != "user" || hit.Text != "also do this" {
				t.Fatalf("hit %+v", hit)
			}
		})

		t.Run("respects maxBytes and returns null when nothing matches or the file is missing", func(t *testing.T) {
			file := filepath.Join(dir, "scan2.jsonl")
			writeFile(t, file, userLine("far back")+"\n"+strings.Repeat(asstLine(strings.Repeat("y", 500))+"\n", 3000))
			if hit := findLastItem(file, isUser, 512*1024); hit != nil { // the request is beyond the bound
				t.Fatalf("hit %+v", hit)
			}
			if hit := findLastItem(file, func(i TimelineItem) bool { return i.Kind == "thinking" }, findLastItemMaxBytes); hit != nil {
				t.Fatalf("hit %+v", hit)
			}
			if hit := findLastItem(filepath.Join(dir, "nope.jsonl"), isUser, findLastItemMaxBytes); hit != nil {
				t.Fatalf("hit %+v", hit)
			}
		})
	})
}

// Go-only (no TS test): only CLAUDE_CONFIG_DIR / HOME come back. Reads the environ
// of this test's own child, never another process.
func TestProjectsRootForPid(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc/<pid>/environ (Linux); elsewhere it is always \"\"")
	}
	cfg := t.TempDir()
	for _, c := range []struct {
		env  []string
		want string
	}{
		{[]string{"HOME=/h", "CLAUDE_CONFIG_DIR=" + cfg, "SECRET=x"}, filepath.Join(cfg, "projects")},
		{[]string{"SECRET=x", "HOME=/h/"}, "/h/.claude/projects"},
		{[]string{"SECRET=x"}, ""},
	} {
		cmd := exec.Command("sh", "-c", "echo; read x")
		cmd.Env = c.env
		stdin, _ := cmd.StdinPipe()
		stdout, _ := cmd.StdoutPipe()
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		// Start returns before the kernel has filled in the new environ: wait until
		// the child runs its own code.
		bufio.NewReader(stdout).ReadString('\n')
		got := projectsRootForPid(cmd.Process.Pid)
		stdin.Close()
		cmd.Wait()
		if got != c.want {
			t.Errorf("%q: got %q, want %q", c.env, got, c.want)
		}
	}
	if got := projectsRootForPid(0); got != "" {
		t.Errorf("pid 0: got %q", got)
	}
}

// numberedLines is n user lines with text `<i>-<1000 x>`, newline-terminated.
func numberedLines(n int) string {
	filler := strings.Repeat("x", 1000)
	var b strings.Builder
	for i := range n {
		b.WriteString(userLine(strconv.Itoa(i) + "-" + filler))
		b.WriteByte('\n')
	}
	return b.String()
}
