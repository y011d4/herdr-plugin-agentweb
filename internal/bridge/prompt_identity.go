package bridge

// A port of server/prompt-identity.ts: the identity of an on-screen TUI prompt region.
//
// It MUST behave exactly like stripAnsi()/parsePrompt()/promptIdentity() in
// web/src/prompt.ts. The client sends the identity it computed as `expect_prompt`,
// and the bridge recomputes it from a fresh read — gated on parsePrompt, exactly like
// the client — to confirm the prompt hasn't changed before pressing the answer digit
// (closing the client read->POST TOCTOU gap). If the two diverge, an answer would 409
// or, worse, a stale menu could verify. testdata/vectors/prompt.json (written from
// the web copy by tools/vectors/prompt.ts) is run by both sides' tests. Only the web
// shows the options, so only it joins a wrapped label and reads the descriptions; this
// copy matches it on everything else (labels up to their first line break).
//
// The regexps keep JavaScript's meaning: \s is jsSpace, `.` excludes \r and the
// Unicode line separators, and the /i ones match an ASCII-lowercased line instead of
// using (?i), which would also fold ſ (U+017F) onto s.

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

type PromptOption struct {
	Send  string `json:"send"`
	Label string `json:"label"`
}

type ParsedPrompt struct {
	Question *string        `json:"question"`
	Options  []PromptOption `json:"options"`
	Selected int            `json:"selected"`
}

const (
	reSpace    = `[` + jsSpace + `]`
	reNonSpace = `[^` + jsSpace + `]`
)

var (
	ansiEscape = regexp.MustCompile(`\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?`)
	// A menu's navigation hint line. Menu-specific on purpose — NOT "Tab to"/"Space to",
	// which appear in the composer/status bar ("shift+tab to cycle") and would sweep the
	// volatile status bar into the identity. Matched against asciiLower(line).
	menuHint         = regexp.MustCompile(`(enter to (select|confirm)|↑/↓|↑ ↓|esc to (cancel|close))`)
	boxDrawing       = regexp.MustCompile(`[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼]`)
	boxDrawingOrMark = regexp.MustCompile(`[│┃╭╮╰╯─━┌┐└┘├┤┬┴┼❯➤▶►]`)
	identityOption   = regexp.MustCompile(`^` + reSpace + `*\d+[.)]` + reSpace + `+` + reNonSpace)
	menuOption       = regexp.MustCompile(`^` + reSpace + `*([❯➤▶►])?` + reSpace + `*(\d+)[.)]` + reSpace + `+(` + reNonSpace + `[^\n\r\x{2028}\x{2029}]*)$`)
	boxRule          = regexp.MustCompile(`[─━]{4,}`)
	indentedLine     = regexp.MustCompile(`^` + reSpace + `+` + reNonSpace)
	checkbox         = regexp.MustCompile(`^\[[^\n\r\x{2028}\x{2029}]\] `) // a multi-select option's box
	boxTitle         = regexp.MustCompile(`^[←☐☑✓]`)
	questionNoise    = regexp.MustCompile(`^(enter to select|press|type something|chat about this|↑|↓|esc|tab)`) // matched against asciiLower(line)
	questionBullet   = regexp.MustCompile(`^[•·]+` + reSpace + `*`)
	blankLines       = regexp.MustCompile(`\n{2,}`)
)

// stripAnsi strips ANSI escapes (CSI + OSC) to plain text.
func stripAnsi(s string) string { return ansiEscape.ReplaceAllLiteralString(s, "") }

// promptIdentity is the identity of the visible prompt region: the context and menu
// down through the last navigation hint or last numbered option (a ❯-only menu has no
// hint), with box-drawing and ❯ selection markers stripped and the volatile status bar
// below the menu excluded. Captures the literal on-screen question text (even when
// parsing yields no question), so two distinct prompts that share a parsed signature
// still get different identities, while cursor moves and status-bar ticks don't churn it.
func promptIdentity(text string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = jsTrimEnd(boxDrawingOrMark.ReplaceAllLiteralString(l, " "))
	}
	end := len(lines)
	for i, l := range lines {
		if menuHint.MatchString(asciiLower(l)) || identityOption.MatchString(l) {
			end = i + 1
		}
	}
	return jsTrim(blankLines.ReplaceAllLiteralString(strings.Join(lines[:end], "\n"), "\n"))
}

// parsePrompt is parsePrompt() of web/src/prompt.ts (keep in sync). The bridge gates
// the verify identity on it so a screen the client would NOT treat as an active
// answerable menu (e.g. a stale menu above a different active prompt) yields an empty
// id that won't match the client's expect_prompt → the answer is refused. nil = null.
func parsePrompt(text string) *ParsedPrompt {
	raw := strings.Split(text, "\n") // kept un-stripped so the menu box border (│) is visible
	lines := make([]string, len(raw))
	for i, l := range raw {
		lines[i] = jsTrimEnd(boxDrawing.ReplaceAllLiteralString(l, " "))
	}
	type block struct {
		options               []PromptOption
		selected, first, last int
	}
	var best *block // the bottom-most block
	var cur []PromptOption
	sel, first, last, gap := 0, -1, -1, 0
	col, cont := 0, false // the column of the current option's text; still on lines continuing it
	commit := func() {
		if len(cur) >= 2 {
			best = &block{cur, sel, first, last}
		}
		cur, sel, first, last, gap = nil, 0, -1, -1, 0
	}
	for i, l := range lines {
		at := menuOption.FindStringSubmatchIndex(l)
		if at == nil {
			if len(cur) == 0 {
				continue
			}
			// a line indented to the option's text continues it (a wrapped label or its
			// description), which is no gap
			if cont && jsTrim(l) != "" && utf8.RuneCountInString(l)-utf8.RuneCountInString(strings.TrimLeftFunc(l, isJSSpace)) >= col {
				continue
			}
			cont = false
			if gap++; gap > 4 {
				commit()
			}
			continue
		}
		m := []string{"", "", l[at[4]:at[5]], l[at[6]:]}
		if at[2] >= 0 {
			m[1] = l[at[2]:at[3]]
		}
		gap = 0
		col, cont = utf8.RuneCountInString(l[:at[6]]), true
		if checkbox.MatchString(m[3]) {
			col += 4
		}
		// Number(): a digit run too long for an int is a huge float, never a match
		num, _ := strconv.ParseFloat(m[2], 64)
		if num == float64(len(cur)+1) {
			if first < 0 {
				first = i
			}
			last = i
			if m[1] != "" {
				sel = len(cur) + 1
			}
			cur = append(cur, PromptOption{Send: m[2], Label: jsTrim(m[3])})
		} else {
			commit()
			if num == 1 {
				cur = []PromptOption{{Send: "1", Label: jsTrim(m[3])}}
				first, last = i, i
				if m[1] != "" {
					sel = 1
				}
			}
		}
	}
	commit()
	if best == nil || best.selected == 0 {
		return nil
	}
	sawForeign := false
	for i := best.last + 1; i < len(lines); i++ {
		t := lines[i]
		if menuHint.MatchString(asciiLower(t)) {
			break // the menu's own hint (nothing foreign preceded it) — end of the menu
		}
		if boxRule.MatchString(raw[i]) {
			sawForeign = true // a new box's top rule below = a different prompt
			continue
		}
		if jsTrim(t) == "" || indentedLine.MatchString(t) {
			continue // blank, or an indented option description (e.g. "     ✓ recommended")
		}
		sawForeign = true // left-aligned content below the options → a different prompt
	}
	if sawForeign {
		return nil // a different prompt sits below this block → it is stale, hint or not
	}
	var qLines []string
	boxed := false
	for i := best.first - 1; i >= 0 && i >= best.first-12; i-- {
		t := jsTrim(lines[i])
		if boxRule.MatchString(raw[i]) || boxTitle.MatchString(t) {
			boxed = true // box top rule or category/title line — edge reached
			break
		}
		if t == "" || questionNoise.MatchString(asciiLower(t)) {
			continue // padding blank — keep looking for the box edge
		}
		qLines = append([]string{questionBullet.ReplaceAllLiteralString(t, "")}, qLines...)
	}
	var question *string
	if boxed && len(qLines) > 0 {
		question = new(strings.Join(qLines, " "))
	}
	return &ParsedPrompt{Question: question, Options: best.options, Selected: best.selected}
}
