package scripts

// plugin-build.sh's two modes: by hand (a linked checkout) it builds from source and
// never downloads; with the manifest's `release` it installs only a release binary
// whose checksum matches release/checksums.txt.

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPluginBuildModes(t *testing.T) {
	manifest, err := os.ReadFile("../herdr-plugin.toml")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(manifest), `command = ["sh", "scripts/plugin-build.sh", "release"]`) {
		t.Error("the manifest's [[build]] must pass release: herdr runs it on install/update")
	}
	if _, err := exec.LookPath("curl"); err != nil {
		t.Skip("needs curl (file:// URLs)")
	}
	script, err := os.ReadFile("plugin-build.sh")
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("agentwebctl_9.9.9_%s_%s", runtime.GOOS, runtime.GOARCH)
	release := []byte("release-binary")

	// setup is a plugin checkout at version 9.9.9 whose checksums.txt says sum, a
	// local release, and stubs for go (writes "source-binary" to -o) and npm
	setup := func(sum string) (root string, run func(args ...string) error) {
		root = t.TempDir()
		files := map[string]string{
			"scripts/plugin-build.sh": string(script),
			"herdr-plugin.toml":       "version = \"9.9.9\"\n",
			"release/checksums.txt":   sum + "  " + name + "\n",
			"rel/v9.9.9/" + name:      string(release),
			"stubs/npm":               "#!/bin/sh\necho npm \"$@\" >>\"$LOG\"\n",
			"stubs/go":                "#!/bin/sh\necho go \"$@\" >>\"$LOG\"\nprintf source-binary >\"$3\"\n",
		}
		for p, body := range files {
			full := filepath.Join(root, p)
			os.MkdirAll(filepath.Dir(full), 0o755)
			if err := os.WriteFile(full, []byte(body), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		return root, func(args ...string) error {
			cmd := exec.Command("sh", append([]string{"scripts/plugin-build.sh"}, args...)...)
			cmd.Dir = root
			cmd.Env = append(os.Environ(), "PATH="+filepath.Join(root, "stubs")+":"+os.Getenv("PATH"),
				"LOG="+filepath.Join(root, "log"), "AGENTWEB_RELEASE_URL=file://"+filepath.Join(root, "rel"))
			out, err := cmd.CombinedOutput()
			if err != nil {
				return fmt.Errorf("%v: %s", err, out)
			}
			return nil
		}
	}
	read := func(p string) string { b, _ := os.ReadFile(p); return string(b) }
	good := fmt.Sprintf("%x", sha256.Sum256(release))

	root, run := setup(good)
	if err := run(); err != nil {
		t.Fatal("by hand:", err)
	}
	if got := read(filepath.Join(root, "bin", "agentwebctl")); got != "source-binary" {
		t.Errorf("by hand, bin/agentwebctl = %q, want the source build", got)
	}
	if err := run("release"); err != nil {
		t.Fatal("release:", err)
	}
	if got := read(filepath.Join(root, "bin", "agentwebctl")); got != string(release) {
		t.Errorf("release, bin/agentwebctl = %q, want the release binary", got)
	}
	if log := read(filepath.Join(root, "log")); strings.Count(log, "go build") != 1 {
		t.Errorf("go build ran %d times, want only by hand:\n%s", strings.Count(log, "go build"), log)
	}

	root, run = setup(strings.Repeat("0", 64)) // the release doesn't match its checksum
	if err := run("release"); err == nil {
		t.Error("release installed a binary whose checksum doesn't match")
	}
	if _, err := os.Stat(filepath.Join(root, "bin", "agentwebctl")); err == nil {
		t.Error("a mismatching binary was left in bin/")
	}
}
