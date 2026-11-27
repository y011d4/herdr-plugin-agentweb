package bridge

// The CLI (cli.go) beyond what the wire recordings compare with the TypeScript
// (tools/fakeherdr/cmd/record-wire): its own choices: the state dir outside herdr and the bridge check.

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/y011d4/herdr-yoicks/tools/fakeherdr"
)

// A binary built before the web UI (embed.go's placeholder only) doesn't start a bridge.
func TestServeNeedsTheWebUI(t *testing.T) {
	t.Setenv("YOICKS_WEB_DIR", "")
	err := Serve(fstest.MapFS{"dist-placeholder.txt": {}}, "")
	if err == nil || !strings.Contains(err.Error(), "this binary has no web UI") {
		t.Fatalf("Serve without index.html: %v, want the no web UI error", err)
	}
	// a dev web dir without the build (Vite between its emptying and its writes): that dir named
	t.Setenv("YOICKS_WEB_DIR", "/w/dist")
	if err := Serve(fstest.MapFS{}, ""); err == nil || !strings.Contains(err.Error(), "no web UI in YOICKS_WEB_DIR (/w/dist)") {
		t.Fatalf("Serve with an empty YOICKS_WEB_DIR: %v", err)
	}
}

// Only a bridge gets a SIGTERM through a pidfile: yoicks serve|run wherever it is
// installed; never another yoicks command, such as an orchestrator's background
// `agent wait`, nor the deleted TypeScript bridge (node …/server/main.js).
func TestIsBridgeArgv(t *testing.T) {
	for argv, want := range map[string]bool{
		"./bin/yoicks serve": true,
		"/home/u/.config/herdr/plugins/x/checkout/bin/yoicks run": true,
		"yoicks serve --extra":                           true,
		"/usr/bin/node /home/u/repo/dist/server/main.js": false,
		"/x/yoicks agent wait p1 --status done":          false,
		"/x/yoicks overview":                             false,
		"/x/yoicks-old serve":                            false,
		"sleep 600":                                      false,
		"":                                               false,
	} {
		if got := isBridgeArgv(strings.Fields(argv)); got != want {
			t.Errorf("isBridgeArgv(%q) = %v, want %v", argv, got, want)
		}
	}
}

// Outside herdr the state dir is herdr's own for the plugin.
func TestDefaultStateDir(t *testing.T) {
	t.Setenv("HOME", "/home/u")
	t.Setenv("XDG_STATE_HOME", "")
	if got, want := defaultStateDir(), "/home/u/.local/state/herdr/plugins/y011d4.yoicks"; got != want {
		t.Errorf("%s, want %s", got, want)
	}
	t.Setenv("XDG_STATE_HOME", "/xdg")
	if got, want := defaultStateDir(), "/xdg/herdr/plugins/y011d4.yoicks"; got != want {
		t.Errorf("XDG_STATE_HOME: %s, want %s", got, want)
	}
}

// The CLI's herdr errors name the method that failed: they reach the orchestrator.
func TestCliRPCErrors(t *testing.T) {
	dir, _ := os.MkdirTemp("", "fh")
	defer os.RemoveAll(dir)
	srv, err := fakeherdr.Start(filepath.Join(dir, "h.sock"), func(method string, _ json.RawMessage) fakeherdr.Reply {
		switch method {
		case "pane.read":
			return fakeherdr.Reply{Close: true}
		case "agent.wait":
			return fakeherdr.Reply{Hang: true}
		case "agent.get":
			return fakeherdr.Reply{Code: "not_found"}
		}
		return fakeherdr.Reply{Result: map[string]any{"ok": true}}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	t.Setenv("HERDR_SOCKET_PATH", srv.Path)
	for method, want := range map[string]string{
		"pane.read":  "pane.read: connection closed",
		"agent.wait": "agent.wait: timeout",
		"agent.get":  "agent.get failed",
	} {
		if _, err := cliRPC(method, nil, 300*time.Millisecond); err == nil || err.Error() != want {
			t.Errorf("%s: %v, want %q", method, err, want)
		}
	}
	if _, err := cliRPC("agent.get", nil, time.Second); herdrCode(err) != "not_found" {
		t.Errorf("herdr's code is lost: %v", err)
	}
	if res, err := cliRPC("agent.list", nil, time.Second); err != nil || string(res) != `{"ok":true}` {
		t.Errorf("agent.list: %s %v", res, err)
	}
	if got := srv.Requests(); len(got) == 0 || string(got[0].Params) != "{}" {
		t.Errorf("params sent: %+v, want {}", got)
	}
}

// The port as `Number(env || config.port || 8390)` reads it.
func TestCLIPort(t *testing.T) {
	t.Setenv("HERDR_YOICKS_PORT", "")
	for cfg, want := range map[string]string{`{}`: "8390", `{"port":8391}`: "8391", `{"port":"8392"}`: "8392", `{"port":0}`: "8390", `{"port":"x"}`: "NaN"} {
		var m map[string]any
		json.Unmarshal([]byte(cfg), &m)
		if got := port(m); got != want {
			t.Errorf("config %s: %s, want %s", cfg, got, want)
		}
	}
	t.Setenv("HERDR_YOICKS_PORT", " 8393 ")
	if got := port(map[string]any{"port": 8391.0}); got != "8393" {
		t.Errorf("the environment wins: %s", got)
	}
}

// Without /proc, ps prints the command line in one piece: only yoicks serve|run
// counts (a path with spaces too).
func TestIsBridgeCommandLine(t *testing.T) {
	for cmd, want := range map[string]bool{
		"/Users/u/Library/herdr plugins/bin/yoicks serve": true,
		"./bin/yoicks run":        true,
		"/x/yoicks agent wait p1": false,
		"/x/yoicks overview":      false,
		"/opt/homebrew/bin/node /Users/u/repo/dist/server/main.js": false,
		"sleep 600": false,
	} {
		if got := isBridgeCommandLine(cmd); got != want {
			t.Errorf("isBridgeCommandLine(%q) = %v, want %v", cmd, got, want)
		}
	}
}

// worktree remove on real git: herdr's worktree.remove stood in for by the `git worktree
// remove` it runs; direnv and gh faked (no .envrc: the default account; gh's merged PR
// heads from a file).
func TestRemoveOwnWorktree(t *testing.T) {
	tmp := t.TempDir()
	bin := filepath.Join(tmp, "bin")
	os.Mkdir(bin, 0o755)
	os.WriteFile(filepath.Join(bin, "direnv"), []byte("#!/bin/sh\ncd \"$2\" && shift 2 && exec \"$@\"\n"), 0o755)
	os.WriteFile(filepath.Join(bin, "gh"), []byte("#!/bin/sh\ncat \""+tmp+"/gh-heads\" 2>/dev/null\n"), 0o755)
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	own := accountForConfigDir("", "")
	eq := func(t *testing.T, got, want any) {
		t.Helper()
		if got != want {
			t.Errorf("got %#v, want %#v", got, want)
		}
	}

	// a repo with an origin and a worktree <repo>-wt-<branch> one commit ahead, its
	// idle shell left in it, and an ignored build output
	setup := func(t *testing.T, branch string) (repo, wt string, rpc, slow Rpc) {
		os.Remove(filepath.Join(tmp, "gh-heads"))
		dir := t.TempDir()
		repo = filepath.Join(dir, "repo")
		gitT(t, "init", "-q", "--bare", "-b", "main", filepath.Join(dir, "origin.git"))
		gitT(t, "init", "-q", "-b", "main", repo)
		os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("bin/\n"), 0o644)
		gitT(t, "-C", repo, "add", ".gitignore")
		gitT(t, "-C", repo, "commit", "-q", "-m", "init")
		gitT(t, "-C", repo, "remote", "add", "origin", filepath.Join(dir, "origin.git"))
		gitT(t, "-C", repo, "push", "-q", "origin", "main")
		gitT(t, "-C", repo, "remote", "set-head", "origin", "main")
		wt = repo + "-wt-" + unsafePathChars.ReplaceAllString(branch, "-")
		gitT(t, "-C", repo, "worktree", "add", "-q", "-b", branch, wt)
		gitT(t, "-C", wt, "commit", "-q", "--allow-empty", "-m", "work")
		os.MkdirAll(filepath.Join(wt, "bin"), 0o755)
		os.WriteFile(filepath.Join(wt, "bin", "yoicks"), nil, 0o755)
		linked := true
		rpc = func(string, map[string]any) (json.RawMessage, error) {
			return json.Marshal(map[string]any{"snapshot": RawSnapshot{
				Workspaces: []RawWorkspace{{WorkspaceID: "w1", Worktree: &RawWorktree{RepoRoot: repo, CheckoutPath: wt, IsLinkedWorktree: &linked}}},
				Panes:      []RawPane{{PaneID: "p1", WorkspaceID: "w1", Cwd: wt}},
			}})
		}
		slow = func(method string, params map[string]any) (json.RawMessage, error) {
			if method != "worktree.remove" || params["workspace_id"] != "w1" {
				t.Fatalf("slow %s %v", method, params)
			}
			if out, err := exec.Command("git", "-C", repo, "worktree", "remove", wt).CombinedOutput(); err != nil {
				if strings.Contains(string(out), "contains modified or untracked files") {
					return nil, &HerdrError{Code: "dirty_worktree_requires_force", Message: string(out)}
				}
				return nil, errors.New(string(out))
			}
			return json.RawMessage(`{}`), nil
		}
		return
	}
	mergeAndDetach := func(t *testing.T, repo, wt, branch string) {
		gitT(t, "-C", repo, "merge", "-q", "--no-ff", "-m", "merge", branch)
		gitT(t, "-C", repo, "push", "-q", "origin", "main")
		gitT(t, "-C", wt, "checkout", "-q", "--detach", "origin/main")
	}
	hasBranch := func(repo, branch string) bool {
		return exec.Command("git", "-C", repo, "rev-parse", "-q", "--verify", "refs/heads/"+branch).Run() == nil
	}
	gone := func(dir string) bool { _, err := os.Stat(dir); return os.IsNotExist(err) }

	t.Run("on its merged branch: the checkout and the branch go", func(t *testing.T) {
		repo, wt, rpc, slow := setup(t, "done")
		gitT(t, "-C", repo, "merge", "-q", "--no-ff", "-m", "merge", "done")
		gitT(t, "-C", repo, "push", "-q", "origin", "main")
		out, err := removeOwnWorktree(rpc, slow, own, wt)
		eq(t, err, nil)
		eq(t, out, "removed "+wt+" and branch done")
		eq(t, gone(wt), true)
		eq(t, hasBranch(repo, "done"), false)
	})
	t.Run("detached in origin/main, its branch (named in the dir) merged: both go", func(t *testing.T) {
		repo, wt, rpc, slow := setup(t, "feat/x")
		mergeAndDetach(t, repo, wt, "feat/x")
		out, err := removeOwnWorktree(rpc, slow, own, wt)
		eq(t, err, nil)
		eq(t, out, "removed "+wt+" and branch feat/x")
		eq(t, gone(wt), true)
		eq(t, hasBranch(repo, "feat/x"), false)
	})
	t.Run("detached in origin/main, its branch squash-merged (a merged PR's head per gh): both go", func(t *testing.T) {
		repo, wt, rpc, slow := setup(t, "sq")
		gitT(t, "-C", repo, "merge", "-q", "--squash", "sq")
		gitT(t, "-C", repo, "commit", "-q", "--allow-empty", "-m", "squash")
		gitT(t, "-C", repo, "push", "-q", "origin", "main")
		gitT(t, "-C", wt, "checkout", "-q", "--detach", "origin/main")
		os.WriteFile(filepath.Join(tmp, "gh-heads"), []byte(gitT(t, "-C", repo, "rev-parse", "sq")), 0o644)
		out, err := removeOwnWorktree(rpc, slow, own, wt)
		eq(t, err, nil)
		eq(t, out, "removed "+wt+" and branch sq")
		eq(t, hasBranch(repo, "sq"), false)
	})
	t.Run("detached in origin/main, its branch not merged: the checkout goes, the branch stays", func(t *testing.T) {
		repo, wt, rpc, slow := setup(t, "wip")
		gitT(t, "-C", wt, "checkout", "-q", "--detach", "origin/main")
		out, err := removeOwnWorktree(rpc, slow, own, wt)
		eq(t, err, nil)
		eq(t, out, "removed "+wt+" (branch wip kept: git can't tell it is merged into origin/main (nor gh that it is a merged PR's head))")
		eq(t, gone(wt), true)
		eq(t, hasBranch(repo, "wip"), true)
	})
	t.Run("detached in origin/main, no branch named after it: the checkout goes", func(t *testing.T) {
		repo, wt, rpc, slow := setup(t, "old")
		mergeAndDetach(t, repo, wt, "old")
		gitT(t, "-C", repo, "branch", "-q", "-D", "old")
		out, err := removeOwnWorktree(rpc, slow, own, wt)
		eq(t, err, nil)
		eq(t, out, "removed "+wt+" (no local branch both is named after it and was checked out in it, per its reflog)")
		eq(t, gone(wt), true)
	})
	t.Run("detached, its branch feat/x gone: a merged feat-x, named alike but never checked out in it, stays", func(t *testing.T) {
		repo, wt, rpc, slow := setup(t, "feat/x")
		mergeAndDetach(t, repo, wt, "feat/x")
		gitT(t, "-C", repo, "branch", "-q", "-D", "feat/x")
		gitT(t, "-C", repo, "branch", "-q", "feat-x", "origin/main")
		out, err := removeOwnWorktree(rpc, slow, own, wt)
		eq(t, err, nil)
		eq(t, out, "removed "+wt+" (no local branch both is named after it and was checked out in it, per its reflog)")
		eq(t, hasBranch(repo, "feat-x"), true)
	})
	t.Run("detached at a commit not in origin/main: refused", func(t *testing.T) {
		repo, wt, rpc, slow := setup(t, "ahead")
		gitT(t, "-C", wt, "checkout", "-q", "--detach")
		_, err := removeOwnWorktree(rpc, slow, own, wt)
		eq(t, err.Error(), "refused: its HEAD is detached at a commit not in origin/main; "+wt+" was left as it is")
		eq(t, gone(wt), false)
		eq(t, hasBranch(repo, "ahead"), true)
	})
	t.Run("detached in origin/main with an untracked file: refused, the branch kept", func(t *testing.T) {
		repo, wt, rpc, slow := setup(t, "dirty")
		mergeAndDetach(t, repo, wt, "dirty")
		os.WriteFile(filepath.Join(wt, "notes.txt"), []byte("x"), 0o644)
		_, err := removeOwnWorktree(rpc, slow, own, wt)
		eq(t, err.Error(), "refused: it has uncommitted or untracked files; "+wt+" was left as it is")
		eq(t, gone(wt), false)
		eq(t, hasBranch(repo, "dirty"), true)
	})
}
