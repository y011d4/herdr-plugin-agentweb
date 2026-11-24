package bridge

// Transcript file I/O, a port of server/transcript.ts: locate a Claude Code
// session's JSONL transcript on disk and read it incrementally. The pure
// line→TimelineItem mapping lives in transcript_normalize.go.
//
// Reads are confined to the Claude Code projects roots (~/.claude/projects and
// ~/.config/claude/<name>/projects). The session id is supplied by herdr
// (pane.agent_session.value) and the cwd by the pane — never by the client — so
// a client can't steer these reads; the containment check is defence in depth.

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// claudeHome is the home dir the projects roots hang off, read once at startup
// like the TS module's homedir() (HOME, else the passwd entry). Tests repoint it.
var claudeHome = func() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	if u, err := user.Current(); err == nil {
		return u.HomeDir
	}
	return ""
}()

// Cap the initial/reset read so a large transcript (many MB) can't stall or
// exhaust memory; only the recent tail is needed for the chat view.
const tailMaxBytes = 2 * 1024 * 1024

// findLastItemMaxBytes is findLastItem's default scan bound.
const findLastItemMaxBytes = 64 * 1024 * 1024

// absPath is path.resolve: absolute and cleaned.
func absPath(p string) string {
	if a, err := filepath.Abs(p); err == nil {
		return a
	}
	return filepath.Clean(p)
}

// projectsRoots discovers the transcript "projects" roots on this host: the
// default plus any ~/.config/claude/<name>/projects (alternate CLAUDE_CONFIG_DIRs,
// e.g. per-org setups). Recomputed per resolve so a new config dir is picked up live.
func projectsRoots() []string {
	roots := []string{absPath(filepath.Join(claudeHome, ".claude", "projects"))}
	base := absPath(filepath.Join(claudeHome, ".config", "claude"))
	entries, _ := os.ReadDir(base) // none: only the default root
	for _, e := range entries {
		p := absPath(filepath.Join(base, e.Name(), "projects"))
		if _, err := os.Stat(p); err == nil {
			roots = append(roots, p)
		}
	}
	return roots
}

// cappedBuffer fails a write that would take it past max bytes (execFile's maxBuffer).
type cappedBuffer struct {
	bytes.Buffer
	max int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.max {
		return 0, errors.New("maxBuffer exceeded")
	}
	return b.Buffer.Write(p)
}

// projectsRootForPid derives a claude process's transcript projects root from its
// own environment via Linux /proc: CLAUDE_CONFIG_DIR/projects, else
// HOME/.claude/projects. "" if the process is gone, unreadable, or off-host (e.g.
// an ssh client — its remote claude's env isn't in local /proc).
//
// Least-privilege: this is a LAST RESORT (callers try the plain filesystem roots
// first). The read + filter is delegated to a `grep` subprocess, so only the two
// path vars ever reach this network-facing process — the rest of the environ
// (unrelated secrets) transits grep's short-lived memory and is never held,
// logged, or returned here. `pid` comes from herdr (not the client) and is passed
// as an exec arg (no shell), so it can't inject.
func projectsRootForPid(pid int) string {
	if pid <= 0 {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "grep", "-z", "-a", "-E", "^(CLAUDE_CONFIG_DIR|HOME)=", "/proc/"+strconv.Itoa(pid)+"/environ")
	out := &cappedBuffer{max: 64 * 1024}
	cmd.Stdout = out
	if err := cmd.Run(); err != nil || out.Len() == 0 {
		return "" // no match / unreadable / grep absent / too big / timed out
	}
	var configDir, home string
	for _, rec := range strings.Split(out.String(), "\x00") {
		if v, ok := strings.CutPrefix(rec, "CLAUDE_CONFIG_DIR="); ok {
			configDir = v
		} else if v, ok := strings.CutPrefix(rec, "HOME="); ok {
			home = v
		}
	}
	if configDir != "" {
		return absPath(filepath.Join(configDir, "projects"))
	}
	if home != "" {
		return absPath(filepath.Join(home, ".claude", "projects"))
	}
	return ""
}

// A session id must be a bare file-stem (UUID in practice). Reject anything with
// path separators or dots so it can't escape a project directory.
var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]*$`)

// slugForCwd is Claude Code's per-project directory name for the cwd it was
// launched in: '/', '.', '_' replaced with '-' (letter case preserved).
func slugForCwd(cwd string) string {
	return strings.Map(func(r rune) rune {
		if r == '/' || r == '.' || r == '_' {
			return '-'
		}
		return r
	}, cwd)
}

func containedIn(p, root string) string {
	abs := absPath(p)
	if abs == root || strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return abs
	}
	return ""
}

// safeRealFile confirms a candidate transcript is a REGULAR FILE that, after
// symlinks are resolved on both it and the root, still lives under the root. The
// lexical containedIn check can't see through a symlink, and opening follows
// links — so a `<root>/<slug>/<uuid>.jsonl` that is really a symlink to a file
// outside the roots would otherwise be tailed. Returns the real path, or "".
func safeRealFile(candidate, root string) string {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return ""
	}
	real, err := filepath.EvalSymlinks(candidate) // fails if missing
	if err != nil {
		return ""
	}
	if real != realRoot && !strings.HasPrefix(real, realRoot+string(filepath.Separator)) {
		return ""
	}
	if st, err := os.Stat(real); err != nil || !st.Mode().IsRegular() {
		return ""
	}
	return real
}

// resolveTranscriptPath resolves the on-disk transcript for a claude session.
// sessionID comes from herdr's agent_session.value, cwd from the pane. Returns
// an absolute path under one of the projects roots, or "" if this session's
// transcript is not on this host (e.g. a remote/containerized claude).
func resolveTranscriptPath(sessionID, cwd string, extraRoots []string) string {
	if sessionID == "" || !sessionIDRe.MatchString(sessionID) {
		return ""
	}
	fileName := sessionID + ".jsonl"
	// extraRoots (a process-derived CLAUDE_CONFIG_DIR) take priority, then the
	// discovered defaults; dedupe so a shared root isn't scanned twice.
	seen := map[string]bool{}
	var roots []string
	for _, r := range extraRoots {
		r = absPath(r)
		if !seen[r] {
			seen[r] = true
			roots = append(roots, r)
		}
	}
	for _, r := range projectsRoots() {
		if !seen[r] {
			seen[r] = true
			roots = append(roots, r)
		}
	}

	// Fast path: the pane's current cwd slug under each root. Correct when claude
	// was launched in the directory the pane still reports.
	if cwd != "" {
		slug := slugForCwd(cwd)
		for _, root := range roots {
			if direct := containedIn(filepath.Join(root, slug, fileName), root); direct != "" {
				if safe := safeRealFile(direct, root); safe != "" {
					return safe
				}
			}
		}
	}

	// Fallback: claude's launch cwd can differ from the pane's current
	// foreground_cwd, so scan each root's project dirs for the globally-unique
	// session id.
	for _, root := range roots {
		dirs, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, d := range dirs {
			if cand := containedIn(filepath.Join(root, d.Name(), fileName), root); cand != "" {
				if safe := safeRealFile(cand, root); safe != "" {
					return safe
				}
			}
		}
	}
	return ""
}

type TranscriptChunk struct {
	Items []TimelineItem // never nil
	// byte offset just past the last complete line consumed
	Cursor int64
	// true when the cursor was too far behind: Items are a rebuilt tail to replace,
	// not append (the caller must forward reset to the client)
	Reset bool
}

// normalizeLines normalizes the newline-separated lines of text (never nil).
func normalizeLines(text string) []TimelineItem {
	items := []TimelineItem{}
	for _, l := range strings.Split(text, "\n") {
		if l != "" {
			items = append(items, normalizeLine(l)...)
		}
	}
	return items
}

// readAt reads len(buf) bytes at off like a single readSync: a short read at EOF
// is not an error.
func readAt(f *os.File, buf []byte, off int64) (int, error) {
	n, err := f.ReadAt(buf, off)
	if err == io.EOF {
		err = nil
	}
	return n, err
}

// readTranscriptFrom reads new complete lines from byteOffset to EOF and
// normalizes them. A trailing partial line (mid-append, no newline yet) is left
// unconsumed so the next read picks it up whole; Cursor only advances past
// complete lines. byteOffset always lands on a newline boundary, so it can't
// split a multi-byte character.
//
// If the gap from byteOffset to EOF exceeds tailMaxBytes (a stale or
// caller-supplied `after`, or a huge burst), the incremental read is abandoned
// and a bounded tail is returned with Reset so the read stays bounded and the
// caller rebuilds instead of streaming megabytes.
func readTranscriptFrom(file string, byteOffset int64, resetMaxItems int) TranscriptChunk {
	noUpdate := TranscriptChunk{Items: []TimelineItem{}, Cursor: byteOffset}
	st, err := os.Stat(file)
	if err != nil {
		// file removed / rotated / unreadable — no update this round
		return noUpdate
	}
	size := st.Size()
	if size <= byteOffset {
		return noUpdate // nothing new
	}
	if size-byteOffset > tailMaxBytes {
		// tailUnsafe (not readTranscriptTail) so a tail-read failure becomes "no
		// update", never an empty reset that would clear the client's log and rewind
		// the cursor.
		tail, err := tailUnsafe(file, resetMaxItems)
		// No complete line in the capped window (a single >cap unterminated line),
		// or no forward progress (a truncate/recreate race): don't advance or reset
		// — the next read makes progress once a complete line lands.
		if err != nil || !tail.hadCompleteLine || tail.cursor <= byteOffset {
			return noUpdate
		}
		// Complete lines exist past the cursor. Advance past them; rebuild the
		// client log only when there's something to show. A window of only skipped
		// lines (system/meta/summary) advances the cursor silently so the watcher
		// catches up instead of re-reading the same window every poll.
		return TranscriptChunk{Items: tail.items, Cursor: tail.cursor, Reset: len(tail.items) > 0}
	}
	f, err := os.Open(file)
	if err != nil {
		return noUpdate
	}
	defer f.Close()
	buf := make([]byte, size-byteOffset)
	read, err := readAt(f, buf, byteOffset)
	if err != nil || read == 0 {
		return noUpdate
	}
	// Reason only over the bytes actually read (a truncate/recreate between stat
	// and read yields a short read). Byte-space newline boundary keeps the cursor
	// byte-exact even mid multi-byte char.
	data := buf[:read]
	lastNl := bytes.LastIndexByte(data, '\n')
	if lastNl == -1 {
		return noUpdate // no complete line yet
	}
	return TranscriptChunk{Items: normalizeLines(string(data[:lastNl+1])), Cursor: byteOffset + int64(lastNl) + 1}
}

type TranscriptTail struct {
	Items  []TimelineItem // never nil
	Cursor int64
	// true when older items were dropped (byte cap or maxItems)
	Truncated bool
}

// tailResult is a tail read. hadCompleteLine distinguishes a window with at least
// one complete line (cursor may advance) from one holding a single >cap
// unterminated line (no progress possible) — separate from whether those complete
// lines produced any renderable item.
type tailResult struct {
	items           []TimelineItem
	cursor          int64
	truncated       bool
	hadCompleteLine bool
}

// tailUnsafe is the core tail read; it fails on fs errors. readTranscriptTail
// swallows a failure (empty tail), while readTranscriptFrom turns it into "no
// update" rather than an empty reset that would clear the client's log.
func tailUnsafe(file string, maxItems int) (tailResult, error) {
	f, err := os.Open(file)
	if err != nil {
		return tailResult{}, err
	}
	defer f.Close()
	// stat the open file (not the path) so the size and the read see the same
	// file; a truncate after this still yields a short read, handled below, so the
	// cursor never exceeds bytes confirmed from the file.
	st, err := f.Stat()
	if err != nil {
		return tailResult{}, err
	}
	size := st.Size()
	start := max(0, size-tailMaxBytes)
	if size == start {
		return tailResult{items: []TimelineItem{}, cursor: size}, nil
	}
	buf := make([]byte, size-start)
	read, err := readAt(f, buf, start)
	if err != nil {
		return tailResult{}, err
	}
	if read == 0 {
		// Truncated below `start` since the stat: clamp the cursor to the real
		// current EOF, not the stale `start`, so a later incremental read isn't
		// stuck past EOF.
		st, err := f.Stat()
		if err != nil {
			return tailResult{}, err
		}
		return tailResult{items: []TimelineItem{}, cursor: st.Size()}, nil
	}
	// Reason only over the bytes actually read. Find newline boundaries in BYTE
	// space so an incomplete multi-byte char at EOF can't skew the cursor;
	// hadCompleteLine uses the whole read window so a completed >cap line still
	// advances the cursor.
	data := buf[:read]
	lastNl := bytes.LastIndexByte(data, '\n')
	hadCompleteLine := lastNl != -1
	cursor := start // just past the last newline
	if hadCompleteLine {
		cursor = start + int64(lastNl) + 1
	}
	// For PARSING, drop a leading partial line when we began mid-file, then decode
	// only the complete-line byte range (both bounds are newlines → no split char).
	bodyStart := 0
	if start > 0 {
		if firstNl := bytes.IndexByte(data, '\n'); firstNl == -1 {
			bodyStart = read
		} else {
			bodyStart = firstNl + 1
		}
	}
	usable := ""
	if hadCompleteLine && bodyStart <= lastNl {
		usable = string(data[bodyStart : lastNl+1])
	}
	all := normalizeLines(usable)
	truncated := start > 0 || len(all) > maxItems
	if len(all) > maxItems {
		all = all[len(all)-maxItems:]
	}
	return tailResult{items: all, cursor: cursor, truncated: truncated, hadCompleteLine: hadCompleteLine}, nil
}

// findLastItem is the newest item matching pred, scanning the file backwards from
// EOF in 1 MiB chunks (at most maxBytes, normally findLastItemMaxBytes) — for an
// item that has scrolled out of the tail window, e.g. the last real user request
// in a long tool-heavy session. Only lines that can hold a user turn are parsed.
// nil if none / unreadable.
func findLastItem(file string, pred func(TimelineItem) bool, maxBytes int64) *TimelineItem {
	const chunk = 1024 * 1024
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil
	}
	pos := st.Size()
	floor := max(0, pos-maxBytes)
	var carry []byte // the partial first line of the chunk after this one
	for pos > floor {
		start := max(floor, pos-chunk)
		buf := make([]byte, pos-start)
		read, err := readAt(f, buf, start)
		if err != nil {
			return nil
		}
		data := append(buf[:read], carry...)
		// below the floor/start the first line may be partial: keep it for the next chunk
		firstNl := -1
		if start > 0 {
			firstNl = bytes.IndexByte(data, '\n')
		}
		body := ""
		switch {
		case start == 0:
			body = string(data)
			carry = nil
		case firstNl == -1:
			carry = data
		default:
			body = string(data[firstNl+1:])
			carry = data[:firstNl]
		}
		lines := strings.Split(body, "\n")
		for i := len(lines) - 1; i >= 0; i-- {
			// cheap prefilter before parsing: a user line, or a message the user sent
			// mid-turn (a queued_command attachment, whose raw line has no "user")
			if !strings.Contains(lines[i], `"user"`) && !strings.Contains(lines[i], `"queued_command"`) {
				continue
			}
			if hit := lastMatch(normalizeLine(lines[i]), pred); hit != nil {
				return hit
			}
		}
		pos = start
	}
	return nil
}

// readTranscriptTail is the initial load: read at most the last tailMaxBytes of
// the file, normalize the complete lines within, and return the last maxItems
// items with a cursor at the end of the last complete line. Older history
// (beyond the cap or maxItems) is dropped — chat views only need the recent tail
// — which also bounds the work. Truncated flags that older items exist above.
// Returns an empty tail if the file can't be read.
func readTranscriptTail(file string, maxItems int) TranscriptTail {
	t, err := tailUnsafe(file, maxItems)
	if err != nil {
		return TranscriptTail{Items: []TimelineItem{}} // removed/rotated/unreadable
	}
	return TranscriptTail{Items: t.items, Cursor: t.cursor, Truncated: t.truncated}
}
