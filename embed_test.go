package yoicks

import (
	"bytes"
	"compress/gzip"
	"io/fs"
	"strings"
	"testing"
)

// The size budgets of a cold open (index.html, the JS, the CSS and the manifest), sized
// for Mantine and Tailwind: a prototype of this UI on them measured ~181 KB gzipped and
// ~538 KB of JS; about a third more is room for the screens still to come. Over either,
// look at what grew before raising it.
const (
	// what a phone downloads: the bridge serves these gzipped (internal/bridge/http.go)
	coldOpenGzipBudget = 240_000
	// what it parses and compiles, whatever the transfer
	jsRawBudget = 700_000
)

// TestWebBuild checks the embedded web/dist (npm run build:web): the files the app
// and its SW name, one JS and one CSS file (no chunks, vite.config.ts), a filled-in
// sw.js, and the size budgets.
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
	gzipped, jsRaw := 0, 0
	for _, name := range cold {
		data, err := fs.ReadFile(web, name)
		if err != nil {
			t.Fatal(err)
		}
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression) // the bridge's level
		zw.Write(data)
		zw.Close()
		gzipped += min(buf.Len(), len(data)) // the bridge sends whichever is smaller
		if strings.HasSuffix(name, ".js") {
			jsRaw += len(data)
		}
	}
	t.Logf("a cold open: %d bytes gzipped, %d bytes of JS", gzipped, jsRaw)
	if gzipped > coldOpenGzipBudget {
		t.Errorf("a cold open is %d bytes gzipped (%v), over the %d budget", gzipped, cold, coldOpenGzipBudget)
	}
	if jsRaw > jsRawBudget {
		t.Errorf("the JS is %d bytes raw, over the %d budget", jsRaw, jsRawBudget)
	}
}
