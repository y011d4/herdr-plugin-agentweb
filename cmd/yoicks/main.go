// Command yoicks is the yoicks bridge and its CLI (internal/bridge/cli.go):
// run | start | stop | status | qr | overview | agent | worktree | orchestrator, and
// serve, the bridge itself.
package main

import (
	"io/fs"
	"os"

	yoicks "github.com/y011d4/herdr-plugin-yoicks"
	"github.com/y011d4/herdr-plugin-yoicks/internal/bridge"
)

func main() {
	os.Exit(bridge.CLI(os.Args[1:], webFS(), yoicks.Rules))
}

// webFS is the embedded web UI, or YOICKS_WEB_DIR's files when set (development:
// rebuild the web UI without rebuilding the binary).
func webFS() fs.FS {
	if dir := os.Getenv("YOICKS_WEB_DIR"); dir != "" {
		return os.DirFS(dir)
	}
	web, err := fs.Sub(yoicks.Web, "web")
	if err != nil {
		panic(err) // "web" is a valid path, so never
	}
	return web
}
