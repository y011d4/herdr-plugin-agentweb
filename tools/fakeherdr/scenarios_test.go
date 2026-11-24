package fakeherdr

import "testing"

func TestCompare(t *testing.T) {
	yes := true
	state := func(status, focused, label string) Output {
		return Output{Kind: "state", Connected: &yes, Panes: map[string]*PaneAgent{"p1": {Status: status}},
			Focused: focused, Tabs: map[string]string{"t1": label}}
	}
	status := func(from, to string) Output { return Output{Kind: "status", PaneID: "p1", From: from, To: to} }
	want := []Output{status("idle", "done"), state("done", "w1/t1/p1", "one")}
	sc := Scenario{Name: "x", CountStates: true}

	cases := []struct {
		name  string
		got   []Output
		opt   CompareOptions
		diffs int
	}{
		{"same", want, CompareOptions{}, 0},
		{"missing transition", []Output{state("done", "w1/t1/p1", "one")}, CompareOptions{}, 1},
		{"focus and label differ", []Output{status("idle", "done"), state("done", "w1/t1/p2", "two")}, CompareOptions{}, 1},
		{"focus and label differ, model skipped", []Output{status("idle", "done"), state("done", "", "")}, CompareOptions{SkipModel: true}, 0},
		{"status differs, model skipped", []Output{status("idle", "done"), state("idle", "", "")}, CompareOptions{SkipModel: true}, 1},
		{"extra state push", []Output{status("idle", "done"), state("done", "w1/t1/p1", "one"), state("done", "w1/t1/p1", "one")}, CompareOptions{}, 1},
	}
	for _, c := range cases {
		if d := Compare(sc, want, c.got, c.opt); len(d) != c.diffs {
			t.Errorf("%s: want %d differences, got %v", c.name, c.diffs, d)
		}
	}
}
