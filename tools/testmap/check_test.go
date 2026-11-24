package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckNames(t *testing.T) {
	if got := goName("describe a › puts it as <repo>-wt-<branch>, safe"); got != "describe_a/puts_it_as_<repo>-wt-<branch>,_safe" {
		t.Errorf("goName = %q", got)
	}
	md := "## To port to Go (2)\n\n| # | file | test |\n|---|---|---|\n" +
		"| 1 | server/test/a.test.ts | x › keeps a \\| and &lt;b&gt; &amp; c |\n" +
		"| 2 | server/test/a.test.ts | y |\n\n## Stay in TypeScript (1)\n\n| 1 | web/test/w.test.ts | z |\n"
	path := filepath.Join(t.TempDir(), "map.md")
	if err := os.WriteFile(path, []byte(md), 0o644); err != nil {
		t.Fatal(err)
	}
	tests, err := readMap(path)
	if err != nil || len(tests) != 2 || tests[0].path != "x › keeps a | and <b> & c" {
		t.Fatalf("readMap = %+v, %v", tests, err)
	}
}
