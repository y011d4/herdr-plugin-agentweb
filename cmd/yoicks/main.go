// Command yoicks is the yoicks bridge and its CLI (internal/bridge/cli.go):
// run | start | stop | status | qr | overview | agent | worktree | orchestrator, and
// serve, the bridge itself.
package main

import (
	"io/fs"
	"os"

	yoicks "github.com/y011d4/herdr-yoicks"
	"github.com/y011d4/herdr-yoicks/internal/bridge"
)

func main() {
	os.Exit(bridge.CLI(os.Args[1:], webFS(), yoicks.Rules))
}

// webFS is the embedded web UI, or YOICKS_WEB_DIR's files when set (development:
// YOICKS_WEB_DIR=web/dist with `npx vite build --watch` rebuilds the web UI without
// rebuilding the binary).
func webFS() fs.FS {
	if dir := os.Getenv("YOICKS_WEB_DIR"); dir != "" {
		return os.DirFS(dir)
	}
	web, err := fs.Sub(yoicks.Web, "web/dist")
	if err != nil {
		panic(err) // "web/dist" is a valid path, so never
	}
	return web
}
