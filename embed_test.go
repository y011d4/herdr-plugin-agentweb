package yoicks

import (
	"io/fs"
	"strings"
	"testing"
)

// TestWebBuild checks the embedded web/dist (npm run build:web): the files the app
// and its SW name, one JS and one CSS file (no chunks, vite.config.ts), a filled-in
// sw.js, and the raw size of a cold open.
func TestWebBuild(t *testing.T) {
	web, err := fs.Sub(Web, "web/dist")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"index.html", "sw.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"} {
		if _, err := fs.Stat(web, name); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	cold := []string{"index.html", "manifest.webmanifest"}
	for _, pattern := range []string{"assets/*.js", "assets/*.css"} {
		names, _ := fs.Glob(web, pattern)
		if len(names) != 1 {
			t.Errorf("%s: %v, want exactly one file", pattern, names)
		}
		cold = append(cold, names...)
	}
	if sw, err := fs.ReadFile(web, "sw.js"); err == nil && strings.Contains(string(sw), "__SW_") {
		t.Error("sw.js still has a __SW_ placeholder")
	}
	// Raw bytes (the bridge serves no compression): about 85 KB today, with room for
	// React and the screens' code. Over it, consider serving gzip before raising it.
	total := 0
	for _, name := range cold {
		data, err := fs.ReadFile(web, name)
		if err != nil {
			t.Fatal(err)
		}
		total += len(data)
	}
	if total > 360_000 {
		t.Errorf("a cold open is %d bytes raw (%v), over the 360000 budget", total, cold)
	}
}
