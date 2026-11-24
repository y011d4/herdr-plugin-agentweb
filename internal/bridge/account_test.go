package bridge

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"
)

// waitFor polls cond (lookups run on goroutines, where the TS awaited a macrotask).
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); !cond(); time.Sleep(time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("timed out")
		}
	}
}

func TestPaneAccountCache(t *testing.T) {
	t.Run("paneAccountCache", func(t *testing.T) {
		t.Run("looks each agent pane up again after the ttl, retries failures, and forgets panes without an agent", func(t *testing.T) {
			var mu sync.Mutex
			clock := int64(0)
			answers := map[string]string{"p1": "A", "p2": ""} // p3: no answer
			var asked []string
			changes := 0
			cache := newPaneAccountCache(func(id string) (string, error) {
				mu.Lock()
				defer mu.Unlock()
				asked = append(asked, id)
				if a, ok := answers[id]; ok {
					return a, nil
				}
				return "", errors.New("no answer")
			}, func() {
				mu.Lock()
				changes++
				mu.Unlock()
			}, 100*time.Millisecond, func() time.Time {
				mu.Lock()
				defer mu.Unlock()
				return time.UnixMilli(clock)
			})
			// onChange for an answer runs before its lookup leaves pending, so this is all of them
			settle := func() {
				waitFor(t, func() bool { cache.mu.Lock(); defer cache.mu.Unlock(); return len(cache.pending) == 0 })
			}
			check := func(wantAsked []string, wantChanges int) { // wantAsked nil: not checked
				t.Helper()
				mu.Lock()
				defer mu.Unlock()
				slices.Sort(asked) // lookups run on goroutines: their order isn't the panes' order
				if wantAsked != nil && !slices.Equal(asked, wantAsked) {
					t.Errorf("asked %v, want %v", asked, wantAsked)
				}
				if changes != wantChanges {
					t.Errorf("changes = %d, want %d", changes, wantChanges)
				}
				asked = nil
			}
			a := func(s string) *string { return &s }

			cache.Refresh([]string{"p1", "p2", "p3"})
			settle()
			if got := cache.Accounts(); !reflect.DeepEqual(got, map[string]*string{"p1": a("A"), "p2": nil}) { // p3 failed: not stored
				t.Errorf("accounts %v", got)
			}
			check(nil, 2)

			mu.Lock()
			clock = 50 // within the ttl: only the failed one is asked again
			mu.Unlock()
			cache.Refresh([]string{"p1", "p2", "p3"})
			settle()
			check([]string{"p3"}, 2)

			mu.Lock()
			clock = 200 // past the ttl: p2 can now be told, and p1 was swapped for another account's agent
			answers["p1"], answers["p2"] = "B", "A"
			mu.Unlock()
			cache.Refresh([]string{"p1", "p2"}) // p3 lost its agent
			settle()
			check([]string{"p1", "p2"}, 4)
			if got := cache.Accounts(); !reflect.DeepEqual(got, map[string]*string{"p1": a("B"), "p2": a("A")}) {
				t.Errorf("accounts %v", got)
			}

			mu.Lock()
			clock = 400 // the same answers again: no change pushed
			mu.Unlock()
			cache.Refresh([]string{"p1", "p2"})
			settle()
			check(nil, 4)
		})

		t.Run("drops a lookup's answer when its pane lost the agent meanwhile, and asks right away for the next one", func(t *testing.T) {
			answer := make(chan string)
			var mu sync.Mutex
			var asked, live []string
			var cache *PaneAccountCache
			setLive := func(panes ...string) []string { mu.Lock(); defer mu.Unlock(); live = panes; return panes }
			// like the bridge, onChange leads to a refresh with the panes that have an agent now
			cache = newPaneAccountCache(func(id string) (string, error) {
				mu.Lock()
				asked = append(asked, id)
				first := len(asked) == 1
				mu.Unlock()
				if first {
					return <-answer, nil
				}
				return "B", nil
			}, func() {
				mu.Lock()
				panes := live
				mu.Unlock()
				cache.Refresh(panes)
			}, 100*time.Millisecond, func() time.Time { return time.UnixMilli(0) })

			cache.Refresh(setLive("p1")) // lookup for the first agent, in flight
			cache.Refresh(setLive())     // its agent exits
			cache.Refresh(setLive("p1")) // a replacement starts in the pane: its lookup waits for the first
			answer <- "A"                // the first agent's account arrives late
			waitFor(t, func() bool { got := cache.Accounts()["p1"]; return got != nil && *got == "B" })
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(asked, []string{"p1", "p1"}) {
				t.Errorf("asked %v", asked)
			}
		})
	})
}

func TestAccountForConfigDir(t *testing.T) {
	t.Run("accountForConfigDir", func(t *testing.T) {
		t.Run("is CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects, normalized", func(t *testing.T) {
			for _, c := range [][3]string{
				{"/home/u/.config/claude/work/", "/home/u", "/home/u/.config/claude/work/projects"},
				{"", "/home/u", "/home/u/.claude/projects"}, // TS: undefined and '' alike
			} {
				if got := accountForConfigDir(c[0], c[1]); got != c[2] {
					t.Errorf("accountForConfigDir(%q, %q) = %q, want %q", c[0], c[1], got, c[2])
				}
			}
			// an explicit default dir is the same account as an unset one
			if a, b := accountForConfigDir("/home/u/.claude", "/home/u"), accountForConfigDir("", "/home/u"); a != b {
				t.Errorf("%q != %q", a, b)
			}
		})
	})
}

func TestAccountEnv(t *testing.T) {
	t.Run("accountEnv", func(t *testing.T) {
		t.Run("sets CLAUDE_CONFIG_DIR for any account but the default (left unset), nothing for an unknown one", func(t *testing.T) {
			if got := accountEnv("/home/u/.config/claude/work/projects", "/home/u"); !reflect.DeepEqual(got, map[string]string{"CLAUDE_CONFIG_DIR": "/home/u/.config/claude/work"}) {
				t.Errorf("got %v", got)
			}
			if got := accountEnv("/home/u/.claude/projects", "/home/u"); got != nil {
				t.Errorf("default: got %v", got)
			}
			if got := accountEnv("", "/home/u"); got != nil {
				t.Errorf("unknown: got %v", got)
			}
		})
	})
}

func TestParseProcStat(t *testing.T) {
	t.Run("parseProcStat", func(t *testing.T) {
		t.Run("reads comm and ppid, even when comm holds spaces or parens", func(t *testing.T) {
			type res struct {
				comm string
				ppid int
				ok   bool
			}
			for stat, want := range map[string]res{
				"4177341 (bash) S 3920697 4177341 3919750 34817": {"bash", 3920697, true},
				"12 (a (b) c) R 7 12 12 0":                       {"a (b) c", 7, true},
				"garbage":                                        {"", 0, false},
			} {
				var got res
				got.comm, got.ppid, got.ok = parseProcStat(stat)
				if got != want {
					t.Errorf("parseProcStat(%q) = %+v, want %+v", stat, got, want)
				}
			}
		})
	})
}

func TestPaneAccount(t *testing.T) {
	t.Run("paneAccount", func(t *testing.T) {
		rpcFor := func(processInfo string) Rpc {
			return func(string, map[string]any) (json.RawMessage, error) {
				return json.RawMessage(`{"process_info":` + processInfo + `}`), nil
			}
		}
		t.Run("is unknown when no agent is in the foreground (the shell itself, or no group)", func(t *testing.T) {
			for _, rpc := range []Rpc{
				rpcFor(`{"foreground_process_group_id":50,"shell_pid":50}`),
				rpcFor(`{"shell_pid":50}`),
				func(string, map[string]any) (json.RawMessage, error) { return json.RawMessage(`null`), nil },
			} {
				if got, err := paneAccount(rpc, "p"); got != "" || err != nil {
					t.Errorf("got %q, %v", got, err)
				}
			}
		})
	})
}
