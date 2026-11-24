package bridge

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The bridge's verify-and-send compares the client's `expect_prompt` against a
// freshly-recomputed identity, so these must behave exactly like the client copy in
// web/src/prompt.ts. If this drifts, every tapped answer would 409.
func TestPromptIdentity(t *testing.T) {
	t.Run("stripAnsi", func(t *testing.T) {
		t.Run("removes CSI and OSC escapes, keeps text", func(t *testing.T) {
			s := "\x1b[1;32m❯ 1. Yes\x1b[0m\x1b]0;title\x07 tail"
			if got := stripAnsi(s); got != "❯ 1. Yes tail" {
				t.Errorf("got %q", got)
			}
		})
	})

	t.Run("promptIdentity", func(t *testing.T) {
		A := strings.Join([]string{
			"● Deploy the app to PRODUCTION now?",
			"",
			"❯ 1. Yes",
			"  2. No",
			"Enter to select · ↑/↓ to navigate · Esc to cancel",
			"  [OMC] 17:20 (0h39m)",
		}, "\n")
		B := strings.Join([]string{
			"● Delete the PRODUCTION database now?",
			"",
			"❯ 1. Yes",
			"  2. No",
			"Enter to select · ↑/↓ to navigate · Esc to cancel",
			"  [OMC] 17:21 (0h40m)",
		}, "\n")

		t.Run("distinguishes two prompts that share a parsed signature", func(t *testing.T) {
			// Same options (Yes/No), different question text — must get different ids.
			if promptIdentity(A) == promptIdentity(B) {
				t.Error("identities are equal")
			}
		})

		t.Run("is stable across ❯ cursor movement and status-bar ticks", func(t *testing.T) {
			moved := strings.Replace(A, "❯ 1. Yes", "  1. Yes", 1)
			moved = strings.Replace(moved, "  2. No", "❯ 2. No", 1)
			moved = strings.Replace(moved, "17:20 (0h39m)", "17:25 (0h44m)", 1)
			if a, b := promptIdentity(A), promptIdentity(moved); a != b {
				t.Errorf("%q != %q", a, b)
			}
		})

		t.Run("excludes everything below the navigation hint", func(t *testing.T) {
			withNoise := A + "\nfresh status line churn\nmore churn"
			if a, b := promptIdentity(A), promptIdentity(withNoise); a != b {
				t.Errorf("%q != %q", a, b)
			}
		})

		t.Run("includes the question text (not just options)", func(t *testing.T) {
			if !strings.Contains(promptIdentity(A), "Deploy the app to PRODUCTION now?") {
				t.Errorf("got %q", promptIdentity(A))
			}
		})

		t.Run("excludes the status bar for a ❯-only menu with no navigation hint", func(t *testing.T) {
			// No recognized hint line — the bottom edge must fall back to the last option, or
			// the ticking status bar would churn the identity and 409 every tap.
			base := strings.Join([]string{"● Keep going?", "❯ 1. Yes", "  2. No"}, "\n")
			t1 := base + "\n" + "  [OMC] 17:20 (0h39m) ctx 12%"
			t2 := base + "\n" + "  [OMC] 17:26 (0h45m) ctx 34%"
			if a, b := promptIdentity(t1), promptIdentity(t2); a != b {
				t.Errorf("%q != %q", a, b)
			}
			if !strings.Contains(promptIdentity(t1), "Keep going?") {
				t.Errorf("got %q", promptIdentity(t1))
			}
		})

		t.Run("does not treat the composer status bar (shift+tab to cycle) as a menu hint", func(t *testing.T) {
			// "Tab to"/"Space to" are NOT menu hints — the composer's "shift+tab to cycle"
			// line must not extend the identity into the ticking status bar, or it churns.
			base := strings.Join([]string{"● Choose an action", "❯ 1. Commit", "  2. Amend"}, "\n")
			hint := "Enter to select · ↑/↓ to navigate · Esc to cancel"
			t1 := strings.Join([]string{base, hint, "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents", "[OMC] 0h39m"}, "\n")
			t2 := strings.Join([]string{base, hint, "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents", "[OMC] 9h99m"}, "\n")
			if a, b := promptIdentity(t1), promptIdentity(t2); a != b {
				t.Errorf("%q != %q", a, b)
			}
			if strings.Contains(promptIdentity(t1), "shift+tab") {
				t.Errorf("got %q", promptIdentity(t1))
			}
		})

		t.Run("keys off the bottom-most (active) prompt when an older hint is scrolled above", func(t *testing.T) {
			// An older, answered prompt with its own nav hint remains visible above the active
			// one. The identity must reflect the ACTIVE prompt at the bottom (which parsePrompt
			// renders buttons for) — two different active prompts under the same old one must
			// still differ, i.e. truncation stops at the LAST hint, not the first.
			old := strings.Join([]string{"● Old question already answered?", "❯ 1. Yes", "  2. No",
				"Enter to select · ↑/↓ to navigate · Esc to cancel", ""}, "\n")
			activeX := strings.Join([]string{"● Ship release X now?", "❯ 1. Yes", "  2. No",
				"Enter to select · ↑/↓ to navigate · Esc to cancel", "  [OMC] 0h39m"}, "\n")
			activeY := strings.Join([]string{"● Wipe caches now?", "❯ 1. Yes", "  2. No",
				"Enter to select · ↑/↓ to navigate · Esc to cancel", "  [OMC] 0h39m"}, "\n")
			if promptIdentity(old+"\n"+activeX) == promptIdentity(old+"\n"+activeY) {
				t.Error("identities are equal")
			}
		})
	})

	t.Run("server parsePrompt matches the client copy (verify gating)", func(t *testing.T) {
		// The client's answers come from testdata/vectors/prompt.json, which
		// tools/vectors/prompt.ts writes from web/src/prompt.ts.
		b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "vectors", "prompt.json"))
		if err != nil {
			t.Fatal(err)
		}
		var vectors []struct {
			Name  string        `json:"name"`
			Input string        `json:"input"`
			Want  *ParsedPrompt `json:"want"`
		}
		if err := json.Unmarshal(b, &vectors); err != nil || len(vectors) == 0 {
			t.Fatalf("no vectors: %v", err)
		}
		for _, v := range vectors {
			t.Run("agrees with the client on: "+v.Name, func(t *testing.T) {
				// The bridge gates the verify identity on this parsePrompt; if it disagreed with
				// the client's, a real answer would 409 or a stale one could slip through.
				// Labels are the web's display text (it joins wrapped ones), so they're left out.
				got := parsePrompt(v.Input)
				for _, p := range []*ParsedPrompt{got, v.Want} {
					if p == nil {
						continue
					}
					for i := range p.Options {
						p.Options[i].Label = ""
					}
				}
				if !reflect.DeepEqual(got, v.Want) {
					g, _ := json.Marshal(got)
					w, _ := json.Marshal(v.Want)
					t.Errorf("got %s, want %s", g, w)
				}
			})
		}

		t.Run("returns null for a stale menu so its identity gate is empty", func(t *testing.T) {
			stale := strings.Join([]string{"❯ 1. Yes", "  2. No", "", " ──────── ", " ☐ Confirm", "   Type a reason:",
				"Enter to select · ↑/↓ to navigate · Esc to cancel"}, "\n")
			if got := parsePrompt(stale); got != nil {
				t.Errorf("got %+v", got)
			}
		})
	})
}

// Not in the TypeScript suite: none of the vectors has a question, so this covers
// the question walk with the screen of web/test/prompt.test.ts's first test.
func TestParsePromptReadsTheBoxedQuestion(t *testing.T) {
	screen := strings.Join([]string{
		"────────────────────────────",
		" ☐ Fruit",
		"Which fruit would you like to pick?",
		"",
		"❯ 1. apple",
		"     Pick an apple.",
		"  2. banana",
		"     Pick a banana.",
		"  3. cherry",
		"Enter to select · ↑/↓ to navigate · Esc to cancel",
		"  [OMC] status 0h39m",
	}, "\n")
	want := &ParsedPrompt{
		Question: new("Which fruit would you like to pick?"),
		Options:  []PromptOption{{"1", "apple"}, {"2", "banana"}, {"3", "cherry"}},
		Selected: 1,
	}
	if got := parsePrompt(screen); !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v", got)
	}
}
