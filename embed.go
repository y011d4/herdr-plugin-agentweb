// Package agentweb holds the files the agentwebctl binary carries: the built web UI
// and the orchestrator rules. Build the web UI first (npm run build:web): the
// patterns below fail the Go build when it is missing, so a binary never ships
// without it.
package agentweb

import "embed"

// Web is web/'s built files, by extension (the web UI isn't frozen and may gain files).
//
//go:embed web/*.html web/*.js web/*.css web/*.webmanifest web/icons/*.png
var Web embed.FS

// Rules is orchestrator/rules.md, written into each managed orchestrator's dir.
//
//go:embed orchestrator/rules.md
var Rules string
