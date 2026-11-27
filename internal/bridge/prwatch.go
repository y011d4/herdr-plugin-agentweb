package bridge

// The PR watch (config pr_watch): each minute, the GitHub PRs on the headless Homes' to-do lists
// are looked up in one `gh api graphql` call (one point of the user's 5000 an hour, however many
// PRs). An item whose PR was merged or closed is removed, and its Home woken with `[yoicks] PR
// merged: <url> …`. With pr_watch set this is the bridge's one outward request besides notify_url:
// the user's own gh, its login, asking only the state of those PRs.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strings"
	"time"
)

const prWatchTimeout = 20 * time.Second

// a github.com PR link; its first group is the PR's own url (no /files, ?…, #…)
var prURLRe = regexp.MustCompile(`^(https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/pull/[1-9][0-9]{0,9})(?:[/?#]|$)`)

// prURL is the PR url of a to-do item's link ("": not a github.com PR).
func prURL(link string) string {
	if m := prURLRe.FindStringSubmatch(link); m != nil {
		return m[1]
	}
	return ""
}

// prArgs is gh's argv asking the state of each url: the urls go as GraphQL variables, never into
// the query's text.
func prArgs(urls []string) []string {
	var vars, fields []string
	args := []string{"api", "graphql"}
	for i, u := range urls {
		vars = append(vars, fmt.Sprintf("$u%d: URI!", i))
		fields = append(fields, fmt.Sprintf("p%d: resource(url: $u%d) { ... on PullRequest { state } }", i, i))
		args = append(args, "-f", fmt.Sprintf("u%d=%s", i, u))
	}
	return append(args, "-f", "query=query("+strings.Join(vars, ", ")+") { "+strings.Join(fields, " ")+" }")
}

// prStates reads gh's answer: each url's state (OPEN, MERGED, CLOSED; "": no PR this login can
// read, which GitHub answers with null, or {} for an issue).
func prStates(urls []string, out []byte) (map[string]string, error) {
	var r struct {
		Data map[string]*struct{ State string }
	}
	if err := json.Unmarshal(out, &r); err != nil || r.Data == nil {
		return nil, errors.New("gh gave no answer")
	}
	states := map[string]string{}
	for i, u := range urls {
		if p := r.Data[fmt.Sprintf("p%d", i)]; p != nil {
			states[u] = p.State
		} else {
			states[u] = ""
		}
	}
	return states, nil
}

// ghPRStates asks the bridge's gh (its env, so its login) for the urls' states. An answer with
// data is read even when gh exits non-zero (an error on one PR fails only that one).
func ghPRStates(ctx context.Context, urls []string) (map[string]string, error) {
	cmd := exec.CommandContext(ctx, "gh", prArgs(urls)...)
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1")
	out, err := cmd.Output()
	states, perr := prStates(urls, out)
	if perr == nil {
		return states, nil
	}
	var ee *exec.ExitError
	switch {
	case ctx.Err() != nil:
		return nil, fmt.Errorf("gh gave no answer within %s", prWatchTimeout)
	case errors.Is(err, exec.ErrNotFound):
		return nil, errors.New("gh is not on the bridge's PATH: install GitHub's gh and restart the bridge")
	case errors.As(err, &ee) && ee.ExitCode() == 4:
		return nil, errors.New("gh is not logged in: run `gh auth login` on the PC")
	case errors.As(err, &ee):
		line, _, _ := strings.Cut(strings.TrimSpace(string(ee.Stderr)), "\n")
		return nil, fmt.Errorf("gh failed: %s", firstNonEmpty(line, err.Error()))
	case err != nil:
		return nil, fmt.Errorf("gh failed: %w", err)
	}
	return nil, perr
}

// watchPRs is the minute's look at the headless Homes' PRs: a merged or closed one's items are
// removed and their Home woken; one that can't be read is told its Home once (per bridge run). gh
// failing alerts each Home with such items, once per distinct error. One at a time (prBusy); only
// the Homes with pr_watch (def.PRWatch), and nothing when none has a PR.
func (s *server) watchPRs() {
	type item struct {
		home   string
		id, pr string
		agent  *string
	}
	var items []item
	var urls []string
	for name, h := range s.headless {
		if !h.def.PRWatch {
			continue
		}
		for _, it := range s.todos.Items(name) {
			if it.URL == nil {
				continue
			}
			if u := prURL(*it.URL); u != "" {
				items = append(items, item{name, it.ID, u, it.Agent})
				if !slices.Contains(urls, u) {
					urls = append(urls, u)
				}
			}
		}
	}
	if len(urls) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), prWatchTimeout)
	defer cancel()
	states, err := s.prStates(ctx, urls)
	if err != nil {
		if err.Error() != s.prErr {
			s.prErr = err.Error()
			logf("[pr-watch] %s", err)
			var alerted []string
			for _, it := range items {
				if !slices.Contains(alerted, it.home) {
					alerted = append(alerted, it.home)
					s.broadcastAlert(s.headless[it.home].def, "github", "PR merges aren't noticed: "+err.Error())
				}
			}
		}
		return
	}
	s.prErr = ""
	for _, it := range items {
		var line string
		switch states[it.pr] {
		case "MERGED":
			line = "PR merged: " + it.pr
		case "CLOSED":
			line = "PR closed without merging: " + it.pr
		case "":
			if s.prUnread[it.home+" "+it.pr] {
				continue
			}
			s.prUnread[it.home+" "+it.pr] = true
			s.headless[it.home].notice("PR " + it.pr + " can't be read with the bridge's GitHub login (no such PR, or no access): its merge won't be noticed")
			continue
		default:
			continue
		}
		if it.agent != nil {
			line += " (" + *it.agent + ")"
		}
		if _, err := s.todos.Done(it.home, it.id); err != nil { // kept: told on a later look
			logf("[pr-watch] %s: %s", it.home, err)
			continue
		}
		s.headless[it.home].notice(line + "; its to-do item is removed")
	}
}
