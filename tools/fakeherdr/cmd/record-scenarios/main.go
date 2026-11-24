// Command record-scenarios runs every fakeherdr scenario against the TypeScript herdr
// client (tools/scenario-ts/run.ts) and writes what it reported to
// testdata/scenarios/<name>.json: the behavior the Go client must reproduce.
// Run from the repo root: go run ./tools/fakeherdr/cmd/record-scenarios [name...]
// Delete with the TypeScript server (plan P5 step 6).
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sync"

	"github.com/y011d4/herdr-plugin-agentweb/tools/fakeherdr"
)

func main() {
	failed := false
	for _, sc := range fakeherdr.Scenarios {
		if len(os.Args) > 1 && !slices.Contains(os.Args[1:], sc.Name) {
			continue
		}
		rec, err := record(sc)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v\n", sc.Name, err)
			failed = true
			continue
		}
		b, _ := json.MarshalIndent(rec, "", " ")
		path := filepath.Join("testdata", "scenarios", sc.Name+".json")
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			failed = true
			continue
		}
		fmt.Printf("%s: %d outputs\n", sc.Name, len(rec.Outputs))
	}
	if failed {
		os.Exit(1)
	}
}

type tsClient struct{ stdin io.Writer }

func (c tsClient) Refresh() { fmt.Fprintln(c.stdin, "refresh") }

func record(sc fakeherdr.Scenario) (*fakeherdr.Recording, error) {
	dir, err := os.MkdirTemp("", "fh")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	world := fakeherdr.NewWorld()
	srv, err := fakeherdr.Start(filepath.Join(dir, "h.sock"), world.Handler())
	if err != nil {
		return nil, err
	}
	defer srv.Close()

	var errs []string
	var emu sync.Mutex
	env := &fakeherdr.Env{Srv: srv, World: world, Errorf: func(f string, a ...any) {
		emu.Lock()
		errs = append(errs, fmt.Sprintf(f, a...))
		emu.Unlock()
	}}
	if sc.Setup != nil {
		sc.Setup(env)
	}

	cmd := exec.Command("node", "tools/scenario-ts/run.ts", srv.Path)
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var outs []fakeherdr.Output
	var readErr error
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		for sc.Scan() {
			var o fakeherdr.Output
			if err := json.Unmarshal(sc.Bytes(), &o); err != nil {
				if readErr == nil {
					readErr = fmt.Errorf("malformed output %q: %w", sc.Text(), err)
				}
				continue // keep draining, so the runner can't block on a full pipe
			}
			outs = append(outs, o)
		}
		if err := sc.Err(); err != nil {
			readErr = err
		}
	}()
	env.Client = tsClient{stdin}
	sc.Run(env)
	env.Sleep(int(fakeherdr.Settle.Milliseconds()))
	fmt.Fprintln(stdin, "exit")
	<-done
	// a runner that died early leaves a partial recording: never store one
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("runner: %w", err)
	}
	if readErr != nil {
		return nil, readErr
	}
	if len(errs) > 0 {
		return nil, fmt.Errorf("%v", errs)
	}
	return &fakeherdr.Recording{Scenario: sc.Name, Outputs: outs}, nil
}
