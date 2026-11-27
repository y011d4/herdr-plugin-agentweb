package bridge

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"
)

func TestPRURL(t *testing.T) {
	for link, want := range map[string]string{
		"https://github.com/y011d4/herdr-yoicks/pull/138":            "https://github.com/y011d4/herdr-yoicks/pull/138",
		"https://github.com/o/r.js/pull/7/files":                     "https://github.com/o/r.js/pull/7",
		"https://github.com/o/r/pull/7#issuecomment-1":               "https://github.com/o/r/pull/7",
		"https://github.com/o/r/pull/7?w=1":                          "https://github.com/o/r/pull/7",
		"https://github.com/o/r/pull/7x":                             "",
		"https://github.com/o/r/pull/0":                              "",
		"https://github.com/o/r/issues/7":                            "",
		"http://github.com/o/r/pull/7":                               "",
		"https://github.com.evil/o/r/pull/7":                         "",
		"https://gist.github.com/o/r/pull/7":                         "",
		"https://github.com/o/r/pull/7\"){x}":                        "",
		"https://github.com/o/r\"/pull/7":                            "",
		"https://github.com/o/r/pull/12345678901":                    "",
		"https://example.com/?u=https://github.com/o/r/pull/7":       "",
		"https://github.com/pfn-Matlantis/core_dev.x/pull/3/commits": "https://github.com/pfn-Matlantis/core_dev.x/pull/3",
	} {
		if got := prURL(link); got != want {
			t.Errorf("%q: %q, want %q", link, got, want)
		}
	}
}

func TestPRArgsAndStates(t *testing.T) {
	urls := []string{"https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2", "https://github.com/o/r/pull/3", "https://github.com/o/r/pull/4"}
	args := prArgs(urls[:2])
	want := []string{"api", "graphql", "-f", "u0=https://github.com/o/r/pull/1", "-f", "u1=https://github.com/o/r/pull/2", "-f",
		"query=query($u0: URI!, $u1: URI!) { p0: resource(url: $u0) { ... on PullRequest { state } } p1: resource(url: $u1) { ... on PullRequest { state } } }"}
	if !slices.Equal(args, want) {
		t.Errorf("%q", args)
	}
	// GitHub's answer (seen 2026-11-27): a merged PR, none, an issue, an open one
	states, err := prStates(urls, []byte(`{"data":{"p0":{"state":"MERGED"},"p1":null,"p2":{},"p3":{"state":"OPEN"}}}`))
	if err != nil || len(states) != 4 || states[urls[0]] != "MERGED" || states[urls[1]] != "" || states[urls[2]] != "" || states[urls[3]] != "OPEN" {
		t.Errorf("%v %v", states, err)
	}
	for _, out := range []string{"", "{}", `{"errors":[{"type":"RATE_LIMITED"}]}`, "nope"} {
		if _, err := prStates(urls, []byte(out)); err == nil {
			t.Errorf("%q: no error", out)
		}
	}
}

// Through the bridge: a merged and a closed PR's items are removed and the Home woken, an
// unreadable one told once, an open one left; gh failing alerts once per error.
func TestHeadlessPRWatch(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, func(h *headlessRunner) { h.def.PRWatch = true })
	b.start(t)
	b.waitStatus(t, "idle")
	const merged, closed, unread, open = "https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2", "https://github.com/o/r/pull/3", "https://github.com/o/r/pull/4"
	if _, _, err := b.srv.todos.Apply("h1", []todoAdd{
		{Text: "merge PR #1", URL: merged + "/files", Agent: "w-one"}, {Text: "merge PR #2", URL: closed},
		{Text: "merge PR #3", URL: unread}, {Text: "merge PR #4", URL: open}, {Text: "read the docs", URL: "https://example.com/"},
		{Text: "run /login"},
	}, nil, nowMs()); err != nil {
		t.Fatal(err)
	}
	var asked [][]string
	answer := map[string]string{merged: "MERGED", closed: "CLOSED", unread: "", open: "OPEN"}
	var fail error
	b.srv.prStates = func(_ context.Context, urls []string) (map[string]string, error) {
		asked = append(asked, urls)
		return answer, fail
	}
	prWakes := func() []string { return b.wakesWith(t, "[yoicks] PR ") }
	waitPRWakes := func(n int) []string {
		t.Helper()
		var got []string
		waitUntil(t, 10*time.Second, "the PR wake-ups", func() bool {
			b.clock.Advance(wakeCoalesce)
			got = prWakes()
			return len(got) >= n
		})
		return got
	}

	b.srv.watchPRs()
	want := []string{
		"[yoicks] PR merged: " + merged + " (w-one); its to-do item is removed",
		"[yoicks] PR closed without merging: " + closed + "; its to-do item is removed",
		"[yoicks] PR " + unread + " can't be read with the bridge's GitHub login (no such PR, or no access): its merge won't be noticed",
	}
	if got := waitPRWakes(3); !slices.Equal(got, want) {
		t.Errorf("wakes %q", got)
	}
	var texts []string
	for _, it := range b.srv.todos.Items("h1") {
		texts = append(texts, it.Text)
	}
	if !slices.Equal(texts, []string{"merge PR #3", "merge PR #4", "read the docs", "run /login"}) {
		t.Errorf("left %q", texts)
	}
	if len(asked) != 1 || !sameSet(asked[0], []string{merged, closed, unread, open}) {
		t.Errorf("asked %q", asked)
	}

	// again: nothing new is told (the unreadable one is still asked about)
	b.srv.watchPRs()
	b.clock.Advance(wakeCoalesce + time.Second)
	if got := prWakes(); len(got) != 3 || len(asked) != 2 || !sameSet(asked[1], []string{unread, open}) {
		t.Errorf("wakes %q, asked %q", got, asked)
	}

	// gh failing: one alert per error, on the Home's notifications (sent on goroutines: any order)
	fail = errors.New("gh is not logged in: run `gh auth login` on the PC")
	b.srv.watchPRs()
	b.srv.watchPRs()
	fail = errors.New("gh failed: HTTP 502")
	b.srv.watchPRs()
	b.srv.bg.Wait()
	var shown []string
	for _, n := range b.world.Notifications() {
		if n["title"] == "H1: github" {
			shown = append(shown, n["body"].(string))
		}
	}
	if !sameSet(shown, []string{"PR merges aren't noticed: gh is not logged in: run `gh auth login` on the PC", "PR merges aren't noticed: gh failed: HTTP 502"}) {
		t.Errorf("%q", shown)
	}

	// no PR on the list: gh isn't asked
	b.srv.todos.Apply("h1", nil, []string{b.srv.todos.Items("h1")[0].ID, b.srv.todos.Items("h1")[1].ID}, nowMs())
	n := len(asked)
	b.srv.watchPRs()
	if len(asked) != n {
		t.Errorf("asked %q", asked[n:])
	}
}

func sameSet(a, b []string) bool {
	return slices.Equal(slices.Sorted(slices.Values(a)), slices.Sorted(slices.Values(b)))
}
