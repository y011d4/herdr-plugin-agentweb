package main

import (
	"testing"

	"github.com/y011d4/herdr-plugin-agentweb/tools/fakeherdr"
)

// A runner that dies early or prints something that isn't an output line must fail
// the recording rather than leave a partial one to be written as the baseline.
func TestRecordRefusesABrokenRunner(t *testing.T) {
	quick := fakeherdr.Scenario{Name: "quick", Run: func(*fakeherdr.Env) {}}
	defer func(r []string) { runner = r }(runner)
	for name, script := range map[string]string{
		"exits non-zero":   `echo '{"kind":"conn","connected":true}'; exit 3`,
		"malformed output": `echo 'not json'; read line`,
	} {
		runner = []string{"sh", "-c", script, "runner"}
		if rec, err := record(quick); err == nil {
			t.Errorf("%s: recorded %d outputs, want an error", name, len(rec.Outputs))
		}
	}
	runner = []string{"sh", "-c", `echo '{"kind":"conn","connected":true}'; read line`, "runner"}
	rec, err := record(quick)
	if err != nil || len(rec.Outputs) != 1 || rec.Outputs[0].Kind != "conn" {
		t.Errorf("a well-behaved runner: got %+v, %v", rec, err)
	}
}
