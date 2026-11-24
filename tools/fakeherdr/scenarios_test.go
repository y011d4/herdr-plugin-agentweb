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
		diffs int
	}{
		{"same", want, 0},
		{"missing transition", []Output{state("done", "w1/t1/p1", "one")}, 1},
		{"focus and label differ", []Output{status("idle", "done"), state("done", "w1/t1/p2", "two")}, 1},
		{"status differs", []Output{status("idle", "done"), state("idle", "w1/t1/p1", "one")}, 1},
		{"extra state push", []Output{status("idle", "done"), state("done", "w1/t1/p1", "one"), state("done", "w1/t1/p1", "one")}, 1},
	}
	for _, c := range cases {
		if d := Compare(sc, want, c.got); len(d) != c.diffs {
			t.Errorf("%s: want %d differences, got %v", c.name, c.diffs, d)
		}
	}
}
