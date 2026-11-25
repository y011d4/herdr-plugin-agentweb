// Package yoicks holds the files the yoicks binary carries: the built web UI
// and the orchestrator rules. Build the web UI first (npm run build:web): the
// pattern below fails the Go build when web/dist is missing, so a binary never
// ships without it.
package yoicks

import "embed"

// Web is the web UI as built by Vite (web/dist: index.html, sw.js, assets/, and
// web/public's files).
//
//go:embed all:web/dist
var Web embed.FS

// Rules is orchestrator/rules.md, written into each managed orchestrator's dir.
//
//go:embed orchestrator/rules.md
var Rules string
