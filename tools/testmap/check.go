package main

// -check: which tests of the map the Go port already reproduces.
//
//	go test -json ./internal/bridge/ | go run ./tools/testmap -check docs/go-migration/test-map.md
//
// A map test counts when a Go subtest with the same path passed: any top-level test
// function, then t.Run per describe level and per test, with the exact names (Go
// shows spaces in subtest names as underscores; that is accounted for).

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var row = regexp.MustCompile(`^\| (\d+) \| (\S+) \| (.*) \|$`)

var uncell = strings.NewReplacer(`\|`, "|", "&lt;", "<", "&gt;", ">", "&amp;", "&")

// readMap returns the "To port to Go" tests of a test-map.md.
func readMap(path string) ([]test, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []test
	in := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "## ") {
			in = strings.HasPrefix(line, "## To port")
			continue
		}
		if m := row.FindStringSubmatch(line); in && m != nil {
			out = append(out, test{file: m[2], path: uncell.Replace(m[3])})
		}
	}
	return out, sc.Err()
}

// goName is the name `go test` reports for a subtest path (testing's rewrite:
// spaces become underscores, unprintable runes are quoted).
func goName(path string) string {
	segs := strings.Split(path, " › ")
	for i, s := range segs {
		var b strings.Builder
		for _, r := range s {
			switch {
			case unicode.IsSpace(r):
				b.WriteByte('_')
			case !strconv.IsPrint(r):
				b.WriteString(strings.Trim(strconv.QuoteRune(r), "'"))
			default:
				b.WriteRune(r)
			}
		}
		segs[i] = b.String()
	}
	return strings.Join(segs, "/")
}

func check(mapPath string, r io.Reader) error {
	want, err := readMap(mapPath)
	if err != nil {
		return err
	}
	if len(want) == 0 {
		return fmt.Errorf("no tests to port in %s", mapPath)
	}
	passed := map[string]bool{}
	var failed []string // any failure fails the run, even with every mapped subtest passed
	dec := json.NewDecoder(r)
	for {
		var ev struct{ Action, Test string }
		if err := dec.Decode(&ev); err == io.EOF {
			break
		} else if err != nil {
			return fmt.Errorf("reading go test -json: %w", err)
		}
		if ev.Action == "fail" {
			failed = append(failed, firstNonEmpty(ev.Test, "(the package)"))
		}
		if i := strings.IndexByte(ev.Test, '/'); ev.Action == "pass" && i > 0 {
			passed[ev.Test[i+1:]] = true
		}
	}
	type tally struct{ done, all int }
	perFile := map[string]*tally{}
	var files []string
	var missing []test
	for _, t := range want {
		if perFile[t.file] == nil {
			perFile[t.file] = &tally{}
			files = append(files, t.file)
		}
		perFile[t.file].all++
		if passed[goName(t.path)] {
			perFile[t.file].done++
		} else {
			missing = append(missing, t)
		}
	}
	for _, f := range files {
		fmt.Printf("%3d/%-3d %s\n", perFile[f].done, perFile[f].all, f)
	}
	fmt.Printf("%d/%d ported and passing\n", len(want)-len(missing), len(want))
	for _, t := range missing {
		fmt.Printf("missing: %s: %s\n", t.file, t.path)
	}
	if len(missing) > 0 {
		return fmt.Errorf("%d tests not ported or failing", len(missing))
	}
	if len(failed) > 0 {
		return fmt.Errorf("go test reported failures: %s", strings.Join(failed, ", "))
	}
	return nil
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
