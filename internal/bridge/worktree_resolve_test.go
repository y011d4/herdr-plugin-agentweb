package bridge

// Port of server/test/worktree-resolve.test.ts.

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func mkWtState(workspaces ...*WorkspaceNode) *State {
	protocol := 16
	return &State{
		Connected:  true,
		Herdr:      HerdrInfo{Version: strp("0.7.3"), Protocol: &protocol},
		Workspaces: workspaces,
	}
}

func wtWs(id string, cwd *string, worktree *WorktreeInfo) *WorkspaceNode {
	return &WorkspaceNode{WorkspaceID: id, Label: id, Cwd: cwd, Worktree: worktree, Tabs: []*TabNode{}}
}

// derived is a fresh copy of the TS test's DERIVED.
func derived() *WorktreeInfo {
	return &WorktreeInfo{
		RepoKey:          "/home/u/repo/.git",
		RepoName:         "repo",
		RepoRoot:         "/home/u/repo",
		CheckoutPath:     "/home/u/repo",
		IsLinkedWorktree: false,
		Branch:           strp("main"),
	}
}

func found(info *WorktreeInfo) func(string) (*WorktreeInfo, bool) {
	return func(string) (*WorktreeInfo, bool) { return info, true }
}

func cacheMiss(string) (*WorktreeInfo, bool) { return nil, false }

func branchOf(w *WorktreeInfo) string {
	if w.Branch == nil {
		return "<nil>"
	}
	return *w.Branch
}

// gitT runs git for a test fixture, independent of the machine's git config.
func gitT(t *testing.T, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func wantInvalidParams(t *testing.T, err error, re string) {
	t.Helper()
	var le *LifecycleError
	if !errors.As(err, &le) || le.Status != 400 || le.Code != "invalid_params" || !regexp.MustCompile(re).MatchString(le.Message) {
		t.Errorf("err = %v, want a 400 invalid_params matching %q", err, re)
	}
}

func TestEnrichStateWorktrees(t *testing.T) {
	t.Run("enrichStateWorktrees", func(t *testing.T) {
		t.Run("derives git worktree info (incl. branch) from cwd", func(t *testing.T) {
			state := mkWtState(wtWs("w1", strp("/home/u/repo"), nil))
			next := enrichStateWorktrees(state, found(derived()))
			if !reflect.DeepEqual(next.Workspaces[0].Worktree, derived()) {
				t.Errorf("worktree = %+v", next.Workspaces[0].Worktree)
			}
		})

		t.Run("fills a herdr-tagged worktree's branch from git while preserving its identity", func(t *testing.T) {
			// herdr's identity fields win; git only supplies the branch it never carries.
			herdrWt := derived()
			herdrWt.RepoName, herdrWt.Branch = "herdr-name", nil
			git := derived()
			git.RepoName = "git-name"
			next := enrichStateWorktrees(mkWtState(wtWs("w1", strp("/home/u/repo"), herdrWt)), found(git))
			if w := next.Workspaces[0].Worktree; branchOf(w) != "main" || w.RepoName != "herdr-name" {
				t.Errorf("worktree = %+v, branch %s", w, branchOf(w))
			}
		})

		t.Run("keeps worktree null when the workspace has no cwd", func(t *testing.T) {
			called := false
			next := enrichStateWorktrees(mkWtState(wtWs("w1", nil, nil)), func(string) (*WorktreeInfo, bool) {
				called = true
				return derived(), true
			})
			if called || next.Workspaces[0].Worktree != nil {
				t.Errorf("called = %v, worktree = %+v", called, next.Workspaces[0].Worktree)
			}
		})

		t.Run("keeps the existing worktree on a cache miss (undefined = not resolved yet)", func(t *testing.T) {
			herdrWt := derived()
			herdrWt.Branch = nil
			next := enrichStateWorktrees(mkWtState(wtWs("w1", strp("/home/u/repo"), herdrWt)), cacheMiss)
			if next.Workspaces[0].Worktree != herdrWt {
				t.Errorf("worktree = %+v, want the same node", next.Workspaces[0].Worktree)
			}
		})

		t.Run("clears a tagged worktree's branch on detached HEAD (git null branch is authoritative)", func(t *testing.T) {
			// git resolved the checkout but HEAD is detached — the branch must go null, not
			// fall back to the previously-shown branch.
			git := derived()
			git.Branch = nil
			next := enrichStateWorktrees(mkWtState(wtWs("w1", strp("/home/u/repo"), derived())), found(git))
			if w := next.Workspaces[0].Worktree; w.Branch != nil || w.RepoKey != derived().RepoKey {
				t.Errorf("worktree = %+v, branch %s", w, branchOf(w))
			}
		})

		t.Run("keeps a herdr-tagged worktree when git can no longer resolve it (identity is authoritative)", func(t *testing.T) {
			// finding-1 guard: an agent cd-ing the pane out of the checkout (git → null)
			// must NOT drop herdr's repo identity/grouping — only the branch comes from git.
			next := enrichStateWorktrees(mkWtState(wtWs("w1", strp("/home/u/repo"), derived())), found(nil))
			if !reflect.DeepEqual(next.Workspaces[0].Worktree, derived()) {
				t.Errorf("worktree = %+v", next.Workspaces[0].Worktree)
			}
		})

		t.Run("clears an untagged workspace when git resolves it as not a repo (null)", func(t *testing.T) {
			// No herdr identity to protect, so git stays authoritative for untagged cwds.
			next := enrichStateWorktrees(mkWtState(wtWs("w1", strp("/home/u/plain"), nil)), found(nil))
			if next.Workspaces[0].Worktree != nil {
				t.Errorf("worktree = %+v", next.Workspaces[0].Worktree)
			}
		})

		t.Run("resolves a tagged workspace from its checkout path, not the moved pane cwd", func(t *testing.T) {
			// finding-1: the pane cwd has wandered into another repo. Resolution must use the
			// stable checkoutPath so the branch comes from the real worktree and the other
			// repo cannot repoint this workspace's grouping.
			herdrWt := derived()
			herdrWt.Branch = nil
			state := mkWtState(wtWs("w1", strp("/somewhere/else"), herdrWt))
			var seen []string
			next := enrichStateWorktrees(state, func(cwd string) (*WorktreeInfo, bool) {
				seen = append(seen, cwd)
				if cwd == herdrWt.CheckoutPath {
					return derived(), true
				}
				other := derived()
				other.RepoKey, other.RepoName, other.Branch = "/other/.git", "other", strp("wrong")
				return other, true
			})
			if !reflect.DeepEqual(seen, []string{herdrWt.CheckoutPath}) {
				t.Errorf("looked up %v, want the stable path only", seen)
			}
			if w := next.Workspaces[0].Worktree; w.RepoKey != derived().RepoKey || branchOf(w) != "main" {
				t.Errorf("worktree = %+v, branch %s", w, branchOf(w))
			}
			if state.Workspaces[0].Worktree != herdrWt {
				t.Error("input mutated")
			}
		})

		t.Run("gives two same-repo workspaces an identical repoKey (grouping enabler)", func(t *testing.T) {
			state := mkWtState(wtWs("w1", strp("/home/u/repo"), nil), wtWs("w2", strp("/home/u/repo/pkg/a"), nil))
			next := enrichStateWorktrees(state, func(cwd string) (*WorktreeInfo, bool) {
				d := derived()
				d.CheckoutPath = cwd
				return d, true
			})
			if next.Workspaces[0].Worktree.RepoKey != next.Workspaces[1].Worktree.RepoKey {
				t.Errorf("repoKeys differ: %+v %+v", next.Workspaces[0].Worktree, next.Workspaces[1].Worktree)
			}
		})

		t.Run("returns the same state reference on a cache miss (nothing changed)", func(t *testing.T) {
			state := mkWtState(wtWs("w1", strp("/home/u/repo"), nil))
			if enrichStateWorktrees(state, cacheMiss) != state {
				t.Error("want the same state")
			}
		})

		t.Run("does not mutate the input state", func(t *testing.T) {
			state := mkWtState(wtWs("w1", strp("/home/u/repo"), nil))
			before, _ := json.Marshal(state.Workspaces)
			enrichStateWorktrees(state, found(derived()))
			after, _ := json.Marshal(state.Workspaces)
			if string(after) != string(before) || state.Workspaces[0].Worktree != nil {
				t.Errorf("input changed: %s", after)
			}
		})
	})
}

func TestResolveOutcome(t *testing.T) {
	t.Run("resolveOutcome (what to cache from a git outcome)", func(t *testing.T) {
		a, b := derived(), derived()
		a.Branch, b.Branch = strp("a"), strp("b")
		// Go's (info, known): known false is TS's undefined.
		check := func(t *testing.T, gotInfo *WorktreeInfo, gotKnown bool, wantInfo *WorktreeInfo, wantKnown bool) {
			t.Helper()
			if gotInfo != wantInfo || gotKnown != wantKnown {
				t.Errorf("got (%+v, %v), want (%+v, %v)", gotInfo, gotKnown, wantInfo, wantKnown)
			}
		}

		t.Run("uses the parsed info on success", func(t *testing.T) {
			info, known := resolveOutcome(a, true, false, b, false)
			check(t, info, known, b, true)
		})

		t.Run("keeps the last known value on success with malformed output", func(t *testing.T) {
			info, known := resolveOutcome(a, true, false, nil, false)
			check(t, info, known, a, true)
		})

		t.Run("resolves to null for an authoritative not-a-repo", func(t *testing.T) {
			info, known := resolveOutcome(a, true, true, nil, true)
			check(t, info, known, nil, true)
		})

		t.Run("keeps the last resolved value on a transient failure (branch survives a hiccup)", func(t *testing.T) {
			info, known := resolveOutcome(a, true, true, nil, false)
			check(t, info, known, a, true)
		})

		t.Run("stays undefined on a transient failure with nothing resolved yet", func(t *testing.T) {
			info, known := resolveOutcome(nil, false, true, nil, false)
			check(t, info, known, nil, false)
		})
	})
}

func TestParseGit(t *testing.T) {
	t.Run("parseGit", func(t *testing.T) {
		t.Run("names a linked worktree by its main repo, not its checkout dir", func(t *testing.T) {
			info := parseGit(strings.Join([]string{
				"/home/u/repo/.git",                  // git-common-dir
				"/home/u/repo/.git/worktrees/feat-x", // git-dir (differs → linked worktree)
				"/home/u/.wt/repo/feat-x",            // show-toplevel (worktree checkout dir)
				"feat/x",                             // branch
			}, "\n"))
			if info == nil || !info.IsLinkedWorktree || info.RepoName != "repo" || info.RepoKey != "/home/u/repo/.git" || branchOf(info) != "feat/x" {
				t.Errorf("info = %+v", info) // the repo, not "feat-x"
			}
		})

		t.Run(`names a linked worktree of a submodule by the submodule, not "modules"`, func(t *testing.T) {
			info := parseGit(strings.Join([]string{
				"/super/.git/modules/sub",              // git-common-dir (submodule)
				"/super/.git/modules/sub/worktrees/wt", // git-dir (differs → linked worktree)
				"/home/u/.wt/sub-wt",                   // show-toplevel
				"feat/y",
			}, "\n"))
			if !info.IsLinkedWorktree || info.RepoName != "sub" {
				t.Errorf("info = %+v", info)
			}
		})

		t.Run("names a main checkout by its working-tree dir", func(t *testing.T) {
			info := parseGit("/home/u/repo/.git\n/home/u/repo/.git\n/home/u/repo\nmain")
			if info.IsLinkedWorktree || info.RepoName != "repo" {
				t.Errorf("info = %+v", info)
			}
		})

		t.Run("returns null for malformed (too-few-lines) output", func(t *testing.T) {
			if info := parseGit("/home/u/repo/.git\n"); info != nil {
				t.Errorf("info = %+v", info)
			}
		})
	})
}

func TestIsNotARepo(t *testing.T) {
	t.Run("isNotARepo (git failure classification)", func(t *testing.T) {
		t.Run(`is authoritative only for exit 128 with git's "fatal: not a git repository" line`, func(t *testing.T) {
			if !isNotARepo(128, "fatal: not a git repository (or any parent up to /)") {
				t.Error("want true")
			}
		})

		t.Run("does not match the phrase mid-line (e.g. inside a path)", func(t *testing.T) {
			if isNotARepo(128, "fatal: cannot open '/tmp/not a git repository/x'") {
				t.Error("want false")
			}
		})

		t.Run("treats other exit-128 fatals (dubious ownership, permissions) as transient", func(t *testing.T) {
			if isNotARepo(128, "fatal: detected dubious ownership in repository at ...") ||
				isNotARepo(128, "fatal: could not read Permission denied") {
				t.Error("want false")
			}
		})

		t.Run("treats a missing git, a timeout, or any other failure as transient", func(t *testing.T) {
			// Go has no string codes ('ENOENT') or undefined: the runner reports both as -1.
			if isNotARepo(-1, "") || isNotARepo(1, "some error") {
				t.Error("want false")
			}
			t.Setenv("PATH", t.TempDir()) // git binary not found
			if r := defaultRunGit("/"); r.code != -1 || isNotARepo(r.code, r.stderr) {
				t.Errorf("missing git: %+v", r)
			}
		})
	})
}

func TestGitConcurrencyLimit(t *testing.T) {
	t.Run("git concurrency limit (process-wide MAX_CONCURRENCY)", func(t *testing.T) {
		t.Run("caps simultaneous resolutions across overlapping refreshes of disjoint cwds", func(t *testing.T) {
			var mu sync.Mutex
			active, peak := 0, 0
			runGit = func(string) gitResult {
				mu.Lock()
				active++
				peak = max(peak, active)
				mu.Unlock()
				time.Sleep(15 * time.Millisecond)
				mu.Lock()
				active--
				mu.Unlock()
				return gitResult{0, "/r/.git\n/r/.git\n/r\nmain\n", ""}
			}
			t.Cleanup(func() { runGit = defaultRunGit })
			dir := t.TempDir() // fresh cache keys, so a rerun (-count) resolves again
			var setA, setB []string
			for _, x := range "abcde" {
				setA = append(setA, dir+"/conc/"+string(x))
			}
			for _, x := range "fghij" { // disjoint from setA
				setB = append(setB, dir+"/conc/"+string(x))
			}
			a, b := refreshWorktrees(setA, func() {}), refreshWorktrees(setB, func() {})
			<-a
			<-b
			if peak <= 0 {
				t.Error("expected the stub runner to be exercised")
			}
			if peak > 4 {
				t.Errorf("peak concurrency %d exceeded MAX_CONCURRENCY (4)", peak)
			}
		})
	})
}

func TestRefreshWorktreesRealGit(t *testing.T) {
	t.Run("refreshWorktrees + worktreeForCwd (real git)", func(t *testing.T) {
		// A fresh repo rather than this one (TS used its own checkout): the same shape,
		// with fresh cache keys on every run.
		repoRoot := filepath.Join(t.TempDir(), "repo")
		gitT(t, "init", "-q", repoRoot)
		gitT(t, "-C", repoRoot, "commit", "-q", "--allow-empty", "-m", "i")
		for _, d := range []string{"bin", "server"} {
			if err := os.Mkdir(filepath.Join(repoRoot, d), 0o755); err != nil {
				t.Fatal(err)
			}
		}

		t.Run("resolves this repo into the cache (branch, linked-ness, repoKey) matching git, and fires onChange", func(t *testing.T) {
			changed := false
			<-refreshWorktrees([]string{repoRoot}, func() { changed = true })
			if !changed {
				t.Error("onChange did not fire")
			}
			info, _ := worktreeForCwd(repoRoot)
			if info == nil {
				t.Fatal("expected cached worktree info after refresh")
			}
			// Expectations from git rather than hard-coded, as in TS.
			out := strings.Split(strings.TrimSpace(gitT(t, "-C", repoRoot, "rev-parse", "--path-format=absolute",
				"--git-common-dir", "--git-dir", "--abbrev-ref", "HEAD")), "\n")
			commonDir, gitDir, rawBranch := out[0], out[1], strings.TrimSpace(out[2])
			wantBranch := rawBranch
			if rawBranch == "HEAD" {
				wantBranch = "<nil>"
			}
			if info.IsLinkedWorktree != (gitDir != commonDir) || info.RepoKey != commonDir || branchOf(info) != wantBranch {
				t.Errorf("info = %+v, branch %s; git: %q", info, branchOf(info), out)
			}
		})

		t.Run("does not re-resolve or fire onChange within the TTL", func(t *testing.T) {
			cwd := filepath.Join(repoRoot, "bin") // self-contained: primed within this test
			<-refreshWorktrees([]string{cwd}, func() {})
			changed := false
			<-refreshWorktrees([]string{cwd}, func() { changed = true }) // still fresh → no-op
			if changed {
				t.Error("onChange fired within the TTL")
			}
		})

		t.Run("caches null for a path outside any repo", func(t *testing.T) {
			<-refreshWorktrees([]string{"/"}, func() {})
			if info, known := worktreeForCwd("/"); info != nil || !known {
				t.Errorf("got (%+v, %v), want (nil, true)", info, known)
			}
		})

		t.Run("coalesces concurrent refreshes of the same uncached cwd (reserved before await)", func(t *testing.T) {
			cwd := filepath.Join(repoRoot, "server")
			var fires atomic.Int32
			a := refreshWorktrees([]string{cwd}, func() { fires.Add(1) })
			b := refreshWorktrees([]string{cwd}, func() { fires.Add(1) })
			<-a
			<-b
			// The first call reserves the cwd before returning, so the second sees it
			// in flight and does nothing — only one resolution/onChange.
			if n := fires.Load(); n != 1 {
				t.Errorf("onChange fired %d times, want 1", n)
			}
			if info, _ := worktreeForCwd(cwd); info == nil {
				t.Error("expected cached worktree info")
			}
		})
	})
}

func TestPlaceWorktreeNextToRepo(t *testing.T) {
	t.Run("placeWorktreeNextToRepo", func(t *testing.T) {
		top := func(root string) func(string) string { return func(string) string { return root } }

		t.Run("puts the checkout next to the repo as <repo>-wt-<branch>, with a filesystem-safe branch", func(t *testing.T) {
			spec, err := placeWorktreeNextToRepo(map[string]any{"repo": "/src/org/repo/sub", "branch": " feat/x y ", "base": "origin/main"}, nil, top("/src/org/repo"))
			want := map[string]any{"repo": "/src/org/repo/sub", "branch": "feat/x y", "base": "origin/main", "path": "/src/org/repo-wt-feat-x-y"}
			if err != nil || !reflect.DeepEqual(spec, want) {
				t.Errorf("got %v, %v", spec, err)
			}
		})

		t.Run("names a blank branch itself, since the path needs one", func(t *testing.T) {
			spec, err := placeWorktreeNextToRepo(map[string]any{"repo": "/r/repo", "branch": "  "}, nil, top("/r/repo"))
			branch, _ := spec["branch"].(string)
			if err != nil || !regexp.MustCompile(`^worktree/[0-9a-z]+$`).MatchString(branch) {
				t.Errorf("got %v, %v", spec, err)
			}
			if want := "/r/repo-wt-" + strings.Replace(branch, "/", "-", 1); spec["path"] != want {
				t.Errorf("path = %v, want %s", spec["path"], want)
			}
			spec, _ = placeWorktreeNextToRepo(map[string]any{"repo": "/r/repo"}, nil, top("/r/repo"))
			if p, _ := spec["path"].(string); !strings.HasPrefix(p, "/r/repo-wt-worktree-") {
				t.Errorf("path = %v", spec["path"])
			}
		})

		t.Run("leaves alone a spec with its own path, no repo at all, or a non-string branch", func(t *testing.T) {
			for _, spec := range []map[string]any{{"repo": "/r", "path": "/elsewhere"}, {"branch": "b"}, {"repo": "/r", "branch": 7}} {
				if got, err := placeWorktreeNextToRepo(spec, nil, top("/r")); err != nil || !reflect.DeepEqual(got, spec) {
					t.Errorf("%v → %v, %v", spec, got, err)
				}
			}
		})

		t.Run("refuses when git cannot place it, rather than fall back to herdr's dir", func(t *testing.T) {
			_, err := placeWorktreeNextToRepo(map[string]any{"repo": "/tmp/x", "branch": "b"}, nil, top(""))
			wantInvalidParams(t, err, `not the main checkout`)
		})

		t.Run("does not land on a taken dir (feat/x and feat-x share a name)", func(t *testing.T) {
			base := t.TempDir()
			if err := os.Mkdir(filepath.Join(base, "repo-wt-feat-x"), 0o755); err != nil {
				t.Fatal(err)
			}
			repo := filepath.Join(base, "repo")
			spec, err := placeWorktreeNextToRepo(map[string]any{"repo": repo, "branch": "feat/x"}, nil, top(repo))
			p, _ := spec["path"].(string)
			if err != nil || !regexp.MustCompile(`^`+regexp.QuoteMeta(base)+`/repo-wt-feat-x-[0-9a-z]+$`).MatchString(p) {
				t.Errorf("got %v, %v", spec, err)
			}
		})

		t.Run("places from the main checkout (from a subdir too, or with a separate git dir) and refuses a linked worktree (real git)", func(t *testing.T) {
			base := t.TempDir()
			realBase, err := filepath.EvalSymlinks(base)
			if err != nil {
				t.Fatal(err)
			}
			for _, c := range []struct {
				repo string
				sep  bool
			}{{"main", false}, {"sep", true}} {
				repo := filepath.Join(base, c.repo)
				if c.sep {
					gitT(t, "init", "-q", "--separate-git-dir", filepath.Join(base, "gitdir"), repo)
				} else {
					gitT(t, "init", "-q", repo)
				}
				gitT(t, "-C", repo, "commit", "-q", "--allow-empty", "-m", "i")
				gitT(t, "-C", repo, "worktree", "add", "-q", filepath.Join(base, "elsewhere", c.repo), "-b", "w")
				if err := os.Mkdir(filepath.Join(repo, "sub"), 0o755); err != nil {
					t.Fatal(err)
				}
				spec, err := placeWorktreeNextToRepo(map[string]any{"repo": filepath.Join(repo, "sub"), "branch": "next"}, nil, nil)
				if want := realBase + "/" + c.repo + "-wt-next"; err != nil || spec["path"] != want {
					t.Errorf("%s: got %v, %v; want path %s", c.repo, spec, err, want)
				}
				_, err = placeWorktreeNextToRepo(map[string]any{"repo": filepath.Join(base, "elsewhere", c.repo), "branch": "next"}, nil, nil)
				wantInvalidParams(t, err, `not the main checkout`)
			}
			_, err = placeWorktreeNextToRepo(map[string]any{"repo": base, "branch": "next"}, nil, nil) // outside git
			wantInvalidParams(t, err, `not the main checkout`)
		})

		t.Run("places a workspace-only spec from that workspace's dir, then names just the dir; refuses an unknown workspace", func(t *testing.T) {
			ws := []*WorkspaceNode{
				{WorkspaceID: "w1", Cwd: strp("/src/org/repo/sub")},
				{WorkspaceID: "w2", Cwd: strp("/moved"), Worktree: &WorktreeInfo{CheckoutPath: "/src/org/other"}},
			}
			spec, err := placeWorktreeNextToRepo(map[string]any{"workspace": "w1", "branch": "b"}, ws, top("/src/org/repo"))
			// TS's `workspace: undefined` is an absent key here.
			want := map[string]any{"repo": "/src/org/repo/sub", "branch": "b", "path": "/src/org/repo-wt-b"}
			if err != nil || !reflect.DeepEqual(spec, want) {
				t.Errorf("got %v, %v", spec, err)
			}
			asked := ""
			_, _ = placeWorktreeNextToRepo(map[string]any{"workspace": "w2", "branch": "b"}, ws, func(cwd string) string {
				asked = cwd
				return "/src/org/other"
			})
			if asked != "/src/org/other" { // a worktree workspace by its checkout, not its moved cwd
				t.Errorf("asked %q", asked)
			}
			_, err = placeWorktreeNextToRepo(map[string]any{"workspace": "gone", "branch": "b"}, ws, top("/x"))
			wantInvalidParams(t, err, `workspace gone: its directory is not known yet`)
		})
	})
}
