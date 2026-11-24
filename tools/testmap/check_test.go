package main

import (
	"os"
	"path/filepath"
	"strings"
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

func TestCheck(t *testing.T) {
	md := "## To port to Go (2)\n\n| # | file | test |\n|---|---|---|\n" +
		"| 1 | server/test/a.test.ts | x › first one |\n| 2 | server/test/a.test.ts | second |\n"
	path := filepath.Join(t.TempDir(), "map.md")
	if err := os.WriteFile(path, []byte(md), 0o644); err != nil {
		t.Fatal(err)
	}
	ev := func(action, test string) string {
		return `{"Action":"` + action + `","Test":"` + test + `"}` + "\n"
	}
	both := ev("pass", "TestA/x/first_one") + ev("pass", "TestB/second")
	cases := []struct {
		name, events string
		ok           bool
	}{
		{"every mapped subtest passed", both + ev("pass", "TestA") + ev("pass", ""), true},
		{"one missing", ev("pass", "TestA/x/first_one"), false},
		{"one failing", ev("pass", "TestA/x/first_one") + ev("fail", "TestB/second"), false},
		{"all mapped passed but the package failed", both + ev("fail", ""), false},
		{"all mapped passed but another test failed", both + ev("fail", "TestOther"), false},
	}
	for _, c := range cases {
		if err := check(path, strings.NewReader(c.events)); (err == nil) != c.ok {
			t.Errorf("%s: err = %v", c.name, err)
		}
	}
}
