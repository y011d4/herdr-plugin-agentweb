// Package yoicks holds the files the yoicks binary carries: the built web UI
// and the orchestrator rules. The Go code compiles without the web UI, so go vet
// and go test need no Node: the pattern below also matches the committed
// web/dist-placeholder.txt. A binary built before the web UI (npm run build:web)
// has no web/dist, and its bridge refuses to start (Serve), so it never ships.
package yoicks

import "embed"

// Web is the web UI as built by Vite (web/dist: index.html, sw.js, assets/, and
// web/public's files), when it was built, and web/dist-placeholder.txt.
//
//go:embed all:web/dist*
var Web embed.FS

// Rules is orchestrator/rules.md, written into each orchestrator's dir.
//
//go:embed orchestrator/rules.md
var Rules string
