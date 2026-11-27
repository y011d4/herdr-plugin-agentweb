package fakeherdr

import (
	"slices"
	"testing"
	"time"
)

// Advance fires what falls due in order of its time, AfterFunc's before it returns, one armed
// meanwhile within the window too; Stop keeps a timer from firing; Pending is about now.
func TestFakeClock(t *testing.T) {
	c := NewFakeClock()
	start := c.Now()
	var fired []string
	at := func(name string) func() { return func() { fired = append(fired, name+" "+c.Now().Sub(start).String()) } }
	c.AfterFunc(3*time.Second, at("3s"))
	c.AfterFunc(time.Second, func() {
		at("1s")()
		c.AfterFunc(time.Second, at("1s+1s")) // armed at 1s: due at 2s, within the window
	})
	stopped := c.AfterFunc(2*time.Second, at("stopped"))
	ch := c.After(5 * time.Second)
	if !c.Pending(5*time.Second) || c.Pending(4*time.Second) {
		t.Error("Pending before a move")
	}
	if !stopped.Stop() || stopped.Stop() {
		t.Error("Stop: true once, while it waits")
	}
	c.Advance(4 * time.Second)
	if want := []string{"1s 1s", "1s+1s 2s", "3s 3s"}; !slices.Equal(fired, want) {
		t.Errorf("fired %q, want %q", fired, want)
	}
	if c.Now().Sub(start) != 4*time.Second || c.Pending(time.Second) || c.Pending(5*time.Second) {
		t.Error("now, or Pending after the move (the 5 s one was armed before it)")
	}
	select {
	case <-ch:
		t.Fatal("After fired early")
	default:
	}
	c.Advance(time.Second)
	if got := (<-ch).Sub(start); got != 5*time.Second {
		t.Errorf("After's time %s", got)
	}
	done := make(chan struct{})
	c.AfterFunc(0, func() { close(done) }) // at once, on its own goroutine
	<-done
}
