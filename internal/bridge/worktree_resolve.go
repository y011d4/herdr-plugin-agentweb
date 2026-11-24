package bridge

// Port of server/worktree-resolve.ts. Fills in git context herdr's session.snapshot
// omits — most importantly the current branch, which the snapshot never carries — by
// resolving a workspace's path with `git rev-parse`. A herdr-tagged worktree is
// resolved from its stable checkout path (not the mutable pane cwd) and only has its
// branch layered in; an untagged checkout derives its full worktree info from the
// pane cwd. repoKey uses git's shared `--git-common-dir`, matching herdr's own
// repoKey, and isLinkedWorktree is derived (git-dir differs from the common dir for a
// linked worktree).
//
// Resolution is asynchronous and cached so it never blocks the caller: the snapshot
// path only READS the cache (enrichStateWorktrees), while refreshWorktrees runs git
// in the background (bounded concurrency) and calls back when anything changed so
// the state can be re-broadcast. A short TTL lets a `git checkout` surface on the
// next refresh. state.go stays pure — this all lives in the client I/O layer.

import (
	"context"
	"maps"
	"os"
	"os/exec"
	"path"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	worktreeTTL       = 30 * time.Second
	maxGitConcurrency = 4
)

// A cache entry's info is a resolved repo (known, non-nil), a confirmed non-repo
// (known, nil), or unknown (!known — never successfully resolved). A transient
// failure keeps the last known info rather than overwriting it, so a resolved branch
// survives a timeout or a git hiccup; at records the last attempt so failures still
// back off.
type worktreeCacheEntry struct {
	at    time.Time
	info  *WorktreeInfo
	known bool
}

var (
	worktreeMu       sync.Mutex
	worktreeCache    = map[string]worktreeCacheEntry{}
	worktreeInflight = map[string]bool{}
	// Process-wide concurrency limit for git, shared by every refreshWorktrees call,
	// so overlapping refreshes can't collectively exceed it.
	gitSem = make(chan struct{}, maxGitConcurrency)
)

// jsTrim is String.prototype.trim: it strips what JavaScript's \s matches.
var jsTrimRe = regexp.MustCompile(`^[` + jsSpace + `]+|[` + jsSpace + `]+$`)

func jsTrim(s string) string { return jsTrimRe.ReplaceAllString(s, "") }

func parseGit(stdout string) *WorktreeInfo {
	var lines []string
	for _, l := range strings.Split(stdout, "\n") {
		if l = jsTrim(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) < 4 {
		return nil
	}
	commonDir, gitDir, toplevel, branchRaw := lines[0], lines[1], lines[2], lines[3]
	// repoKey is the shared common .git dir — identical for a main checkout and all
	// its linked worktrees, and byte-identical to herdr's own repoKey.
	repoRoot := path.Dir(commonDir)
	// linked worktrees have a per-worktree gitDir under <common>/worktrees/*.
	isLinkedWorktree := gitDir != commonDir
	// Repo name: a linked worktree's own checkout dir isn't the repo, so name it from
	// the shared common dir — `<repo>/.git` → its parent (the repo), or a submodule's
	// `<super>/.git/modules/<name>` → its last segment. A main checkout or a submodule
	// main uses its working-tree dir.
	repoName := path.Base(toplevel)
	if isLinkedWorktree {
		if repoName = path.Base(commonDir); repoName == ".git" {
			repoName = path.Base(repoRoot)
		}
	}
	var branch *string
	// `--abbrev-ref HEAD` yields "HEAD" on a detached checkout.
	if branchRaw != "HEAD" {
		branch = strp(branchRaw)
	}
	return &WorktreeInfo{
		RepoKey:          commonDir,
		RepoName:         repoName,
		RepoRoot:         repoRoot,
		CheckoutPath:     toplevel,
		IsLinkedWorktree: isLinkedWorktree,
		Branch:           branch,
	}
}

// Anchored to git's actual diagnostic line, so an unrelated 128 whose path/detail
// merely contains the phrase isn't misread as authoritative. JavaScript's multiline
// ^ also follows \r, U+2028 and U+2029.
var notARepoRe = regexp.MustCompile(`(?m)(?:^|[\r\x{2028}\x{2029}])fatal: not a git repository`)

// isNotARepo classifies a `git rev-parse` failure. git exits 128 for many fatal
// conditions (dubious ownership, permission errors, a deleted cwd, ...), so only the
// actual "not a git repository" message is an authoritative negative that should
// clear worktree data. A missing git binary or a timeout (code -1) and every other
// 128 are tooling failures that must NOT erase herdr-provided worktree data.
// Requires LC_ALL=C so the message is English.
func isNotARepo(code int, stderr string) bool {
	return code == 128 && notARepoRe.MatchString(stderr)
}

// resolveOutcome decides the value to cache from a git outcome, given the last
// known value (prevKnown false = unknown):
//   - success with valid output → the parsed repo info
//   - authoritative "not a git repository" → nil (known)
//   - anything else (transient failure, or success with malformed output) → keep the
//     last known value, so a resolved branch survives a git hiccup.
func resolveOutcome(prev *WorktreeInfo, prevKnown, failed bool, parsed *WorktreeInfo, notARepo bool) (*WorktreeInfo, bool) {
	if !failed {
		if parsed != nil {
			return parsed, true
		}
		return prev, prevKnown
	}
	if notARepo {
		return nil, true
	}
	return prev, prevKnown
}

// gitResult is one git run: code 0 on success, the exit code on a failure, -1 when
// git is missing or was killed by the timeout (Node's `err.code ?? -1`).
type gitResult struct {
	code           int
	stdout, stderr string
}

func defaultRunGit(cwd string) gitResult {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--path-format=absolute",
		"--git-common-dir", "--git-dir", "--show-toplevel", "--abbrev-ref", "HEAD")
	// LC_ALL=C so a "not a git repository" failure is reported in English.
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	code := 0
	if err := cmd.Run(); err != nil {
		code = -1
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		}
	}
	return gitResult{code, stdout.String(), stderr.String()}
}

// runGit is the one-cwd git call, a seam so tests can drive resolution (e.g. to
// assert the concurrency cap) without spawning real git (TS _setGitRunForTest).
var runGit = defaultRunGit

// resolveCwd resolves one cwd (already reserved in worktreeInflight by the caller)
// under the process-wide semaphore, updates the cache and clears the reservation.
// Reports whether the effective value changed.
func resolveCwd(cwd string) bool {
	gitSem <- struct{}{}
	defer func() { <-gitSem }()
	r := runGit(cwd)
	failed := r.code != 0
	var parsed *WorktreeInfo
	if !failed {
		parsed = parseGit(r.stdout)
	}
	worktreeMu.Lock()
	defer worktreeMu.Unlock()
	delete(worktreeInflight, cwd)
	prev := worktreeCache[cwd]
	info, known := resolveOutcome(prev.info, prev.known, failed, parsed, failed && isNotARepo(r.code, r.stderr))
	// at records the attempt (even a failed one) so transient failures back off.
	worktreeCache[cwd] = worktreeCacheEntry{at: time.Now(), info: info, known: known}
	return prev.known != known || !reflect.DeepEqual(prev.info, info)
}

// worktreeForCwd reads the cache for a workspace cwd. !ok = not resolved (cache
// miss, or only ever a transient failure); ok with nil = git confirmed it isn't a
// repo; ok with info = a resolved checkout (also returned through a later transient
// failure, since the last known value is preserved).
func worktreeForCwd(cwd string) (*WorktreeInfo, bool) {
	worktreeMu.Lock()
	defer worktreeMu.Unlock()
	e := worktreeCache[cwd]
	return e.info, e.known
}

// resolveCwdFor is the cwd to resolve git from for a workspace ("" = none). When
// herdr already tagged the workspace with a worktree, resolve from its stable
// checkout path so an agent that `cd`s the pane out of the checkout (changing
// foreground_cwd) can't repoint the workspace to another repo or clear its grouping.
// Only an untagged checkout — which carries no herdr repo identity — falls back to
// the (pane-derived) workspace cwd.
func resolveCwdFor(ws *WorkspaceNode) string {
	if ws.Worktree != nil && ws.Worktree.CheckoutPath != "" {
		return ws.Worktree.CheckoutPath
	}
	if ws.Cwd != nil {
		return *ws.Cwd
	}
	return ""
}

// enrichStateWorktrees returns a state where every workspace carries its cached git
// worktree info: the same state when nothing changed. Reads only the cache — never
// spawns git — so it is safe on the snapshot hot path. The input is not modified.
// lookup is injectable for tests (nil = worktreeForCwd).
//
// When herdr tagged the workspace with a worktree, its repo identity
// (repoKey/paths/isLinkedWorktree) is authoritative: only the git-resolved branch is
// layered in, so a moved pane cwd or a git hiccup can neither repoint the workspace
// to another repo nor drop its grouping. An untagged checkout has no herdr identity,
// so the git result is authoritative for it — including clearing it (nil) once its
// cwd no longer resolves as a git repo.
func enrichStateWorktrees(s *State, lookup func(cwd string) (*WorktreeInfo, bool)) *State {
	if lookup == nil {
		lookup = worktreeForCwd
	}
	changed := false
	workspaces := make([]*WorkspaceNode, len(s.Workspaces))
	for i, ws := range s.Workspaces {
		workspaces[i] = ws
		cwd := resolveCwdFor(ws)
		if cwd == "" {
			continue
		}
		info, ok := lookup(cwd)
		// Cache miss: not resolved yet — keep whatever baseline the snapshot carried.
		if !ok {
			continue
		}
		// A resolved WorktreeInfo is authoritative for the branch — including a nil
		// branch (detached HEAD), which must replace a previously-shown one. Only a nil
		// info (checkout path no longer a repo) falls back to herdr's last-known branch,
		// so the tagged identity/grouping survives rather than being cleared.
		merged := info
		if ws.Worktree != nil {
			m := *ws.Worktree
			if info != nil {
				m.Branch = info.Branch
			}
			merged = &m
		}
		if reflect.DeepEqual(ws.Worktree, merged) {
			continue
		}
		changed = true
		n := *ws
		n.Worktree = merged
		workspaces[i] = &n
	}
	if !changed {
		return s
	}
	n := *s
	n.Workspaces = workspaces
	return &n
}

// refreshWorktrees resolves git info for the given cwds that are missing or past
// their TTL, in the background with bounded concurrency, updating the cache. It
// reserves the cwds before returning, and calls onChange once (on a background
// goroutine) if any cached entry changed, so the caller can re-enrich and
// re-broadcast. The returned channel closes when it is done (the TS promise).
func refreshWorktrees(cwds []string, onChange func()) <-chan struct{} {
	done := make(chan struct{})
	now := time.Now()
	var stale []string
	// Reserve every selected cwd globally before going async, so a concurrent refresh
	// (snapshot + interval) filters these out instead of re-selecting the same cwds.
	// Actual git concurrency is bounded process-wide by gitSem, so all stale cwds can
	// be launched at once here. A reserved cwd also dedups repeats within cwds.
	worktreeMu.Lock()
	for _, cwd := range cwds {
		if worktreeInflight[cwd] {
			continue
		}
		if hit, ok := worktreeCache[cwd]; !ok || now.Sub(hit.at) >= worktreeTTL {
			worktreeInflight[cwd] = true
			stale = append(stale, cwd)
		}
	}
	worktreeMu.Unlock()
	if len(stale) == 0 {
		close(done)
		return done
	}
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		var changed atomic.Bool
		for _, cwd := range stale {
			wg.Go(func() {
				if resolveCwd(cwd) {
					changed.Store(true)
				}
			})
		}
		wg.Wait()
		if changed.Load() {
			onChange()
		}
	}()
	return done
}

// ── placing a new worktree ────────────────────────────────────────────────────

// mainCheckout is the repo checkout containing cwd when it is the repo's main one,
// else "" (not in git, or in a linked worktree — herdr makes new worktrees only from
// the main one).
func mainCheckout(cwd string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", cwd, "rev-parse", "--path-format=absolute",
		"--git-dir", "--git-common-dir", "--show-toplevel").Output()
	if err != nil {
		return ""
	}
	lines := strings.Split(jsTrim(string(out)), "\n")
	if len(lines) < 3 || lines[0] != lines[1] {
		return ""
	}
	return lines[2]
}

var unsafePathChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// placeWorktreeNextToRepo puts a new worktree of the repo at spec["repo"] next to the
// repo, as `<repo>-wt-<branch>`, instead of herdr's worktrees dir: whatever covers
// the repo from a parent dir (e.g. a direnv .envrc per org dir, which may pick the
// Claude account) then covers the checkout too. A spec naming only a workspace is
// placed from that workspace's dir (looked up in workspaces) and then names just the
// dir, since herdr takes one or the other. A blank branch gets a generated name,
// since the path needs one. A spec with its own path, no repo at all, or a branch
// that isn't a string comes back as is (createWorktree validates it). Anything else
// this can't place is refused rather than left to herdr's default dir.
//
// spec is a decoded JSON object (CreateWorktreeInput): an absent key is TS's
// undefined. The input is not modified. repoOf nil = mainCheckout.
func placeWorktreeNextToRepo(spec map[string]any, workspaces []*WorkspaceNode, repoOf func(cwd string) string) (map[string]any, error) {
	if repoOf == nil {
		repoOf = mainCheckout
	}
	if _, ok := spec["path"]; ok {
		return spec, nil
	}
	if repo, ok := spec["repo"]; !ok || repo == "" {
		if wsID, _ := spec["workspace"].(string); wsID != "" {
			repo := ""
			for _, w := range workspaces {
				if w.WorkspaceID == wsID {
					repo = resolveCwdFor(w)
					break
				}
			}
			if repo == "" {
				return nil, &LifecycleError{400, "invalid_params", "workspace " + wsID + ": its directory is not known yet"}
			}
			spec = maps.Clone(spec)
			spec["repo"] = repo
			delete(spec, "workspace")
		}
	}
	repo, _ := spec["repo"].(string)
	if repo == "" {
		return spec, nil
	}
	b, hasBranch := spec["branch"]
	branch, isString := b.(string)
	if hasBranch && !isString {
		return spec, nil
	}
	root := repoOf(repo)
	if root == "" {
		return nil, &LifecycleError{400, "invalid_params", repo + ": not the main checkout of a git repository (new worktrees start from the repo itself)"}
	}
	if branch = jsTrim(branch); branch == "" {
		branch = "worktree/" + strconv.FormatInt(time.Now().UnixMilli(), 36)
	}
	p := path.Dir(root) + "/" + path.Base(root) + "-wt-" + unsafePathChars.ReplaceAllString(branch, "-")
	// distinct branches can share that name (feat/x, feat-x): don't land on a taken one
	if _, err := os.Stat(p); err == nil {
		p += "-" + strconv.FormatInt(time.Now().UnixMilli(), 36)
	}
	spec = maps.Clone(spec)
	spec["branch"] = branch
	spec["path"] = p
	return spec, nil
}
