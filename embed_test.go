package yoicks

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"strings"
	"testing"
)

// The size budgets of a cold open (index.html, the JS, the CSS and the manifest), sized
// for Mantine and Tailwind: a prototype of this UI on them measured ~181 KB gzipped and
// ~538 KB of JS; about a third more is room for the screens still to come (the transfer
// budget was 240 KB gzipped, scaled here by brotli's ratio to gzip on this build, 0.85).
// Over either, look at what grew before raising it.
const (
	// what a phone downloads: the bridge sends these files' brotli copies to a browser over
	// HTTPS (all of them accept br there; internal/bridge/http.go)
	coldOpenBudget = 205_000
	// what it parses and compiles, whatever the transfer
	jsRawBudget = 700_000
)

// TestWebBuild checks the embedded web/dist (npm run build:web): the files the app
// and its SW name, one JS and one CSS file (no chunks, vite.config.ts), a filled-in
// sw.js, each text file's .br and .gz copy (vite.config.ts's precompress), and the size
// budgets.
func TestWebBuild(t *testing.T) {
	web, err := fs.Sub(Web, "web/dist")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"index.html", "sw.js", "manifest.webmanifest", "favicon.ico", "favicon.svg",
		"icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png", "icons/lockup.svg"} {
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
	sent, jsRaw := 0, 0
	for _, name := range append(cold, "sw.js") {
		data, err := fs.ReadFile(web, name)
		if err != nil {
			t.Fatal(err)
		}
		br, err := fs.ReadFile(web, name+".br")
		if err != nil {
			t.Errorf("%s: no brotli copy: %v", name, err)
		}
		// a gzip copy of another file (or of an older build) would break the page; the
		// brotli one comes from the same loop
		if gz, err := fs.ReadFile(web, name+".gz"); err != nil {
			t.Errorf("%s: no gzip copy: %v", name, err)
		} else if zr, err := gzip.NewReader(bytes.NewReader(gz)); err != nil {
			t.Errorf("%s.gz: %v", name, err)
		} else if plain, err := io.ReadAll(zr); err != nil || !bytes.Equal(plain, data) {
			t.Errorf("%s.gz isn't %s gzipped (%v)", name, name, err)
		}
		if name == "sw.js" {
			continue
		}
		if strings.HasSuffix(name, ".js") {
			jsRaw += len(data)
		}
		if br != nil {
			data = br
		}
		sent += len(data)
	}
	t.Logf("a cold open: %d bytes sent (brotli), %d bytes of JS", sent, jsRaw)
	if sent > coldOpenBudget {
		t.Errorf("a cold open sends %d bytes (%v), over the %d budget", sent, cold, coldOpenBudget)
	}
	if jsRaw > jsRawBudget {
		t.Errorf("the JS is %d bytes raw, over the %d budget", jsRaw, jsRawBudget)
	}
}
