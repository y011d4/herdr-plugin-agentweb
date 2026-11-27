package fakeherdr

import (
	"sync"
	"time"
)

// Clock is the time a World's waits run on (their deadlines): the real one unless SetClock
// gives it a test's FakeClock.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// FakeClock is a test's time: it stands still until Advance moves it on, firing what falls
// due on the way. It also has AfterFunc, so the bridge's headless runner can run on it.
type FakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	clock *FakeClock
	d     time.Duration
	armed time.Time // the clock's time then
	at    time.Time
	f     func()         // AfterFunc's
	c     chan time.Time // After's (buffered: a fire never blocks)
}

func NewFakeClock() *FakeClock { return &FakeClock{now: time.Now()} }

func (c *FakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *FakeClock) After(d time.Duration) <-chan time.Time {
	return c.add(d, nil).c
}

// AfterFunc runs f once the clock has moved d on: in Advance, before it returns (at once, on
// its own goroutine, for d <= 0, as time.AfterFunc does).
func (c *FakeClock) AfterFunc(d time.Duration, f func()) interface{ Stop() bool } {
	return c.add(d, f)
}

func (c *FakeClock) add(d time.Duration, f func()) *fakeTimer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{clock: c, d: d, armed: c.now, at: c.now.Add(d), f: f}
	if f == nil {
		t.c = make(chan time.Time, 1)
	}
	if d <= 0 {
		if f != nil {
			go f()
		} else {
			t.c <- c.now
		}
		return t
	}
	c.timers = append(c.timers, t)
	return t
}

// Stop keeps t from firing; false when it already has (or was stopped).
func (t *fakeTimer) Stop() bool {
	c := t.clock
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, o := range c.timers {
		if o == t {
			c.timers = append(c.timers[:i], c.timers[i+1:]...)
			return true
		}
	}
	return false
}

// Pending: something began to wait d at the clock's present time (since it last moved), and
// waits still: a test moves the clock on once what it means to pass is waiting.
func (c *FakeClock) Pending(d time.Duration) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, t := range c.timers {
		if t.d == d && t.armed.Equal(c.now) {
			return true
		}
	}
	return false
}

// Advance moves the clock d on, firing each timer due by then in order of its time (Now
// then reads that time): After's get it on their channel, AfterFunc's run before Advance
// returns. A timer armed meanwhile that falls due within d fires too. Two may run at once (a
// clock kept at the real time's pace, and a jump): the clock never goes back.
func (c *FakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	end := c.now.Add(d)
	for {
		next := -1
		for i, t := range c.timers {
			if !t.at.After(end) && (next < 0 || t.at.Before(c.timers[next].at)) {
				next = i
			}
		}
		if next < 0 {
			break
		}
		t := c.timers[next]
		c.timers = append(c.timers[:next], c.timers[next+1:]...)
		if t.at.After(c.now) {
			c.now = t.at
		}
		now := c.now
		c.mu.Unlock()
		if t.f != nil {
			t.f()
		} else {
			t.c <- now
		}
		c.mu.Lock()
	}
	if end.After(c.now) {
		c.now = end
	}
	c.mu.Unlock()
}
