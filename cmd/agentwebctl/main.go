// Command agentwebctl is the herdr-agentweb bridge and its CLI (internal/bridge/cli.go):
// run | start | stop | status | qr | overview | agent | worktree | orchestrator, and
// serve, the bridge itself.
package main

import (
	"io/fs"
	"os"

	agentweb "github.com/y011d4/herdr-plugin-agentweb"
	"github.com/y011d4/herdr-plugin-agentweb/internal/bridge"
)

func main() {
	os.Exit(bridge.CLI(os.Args[1:], webFS(), agentweb.Rules))
}

// webFS is the embedded web UI, or AGENTWEB_WEB_DIR's files when set (development:
// rebuild the web UI without rebuilding the binary).
func webFS() fs.FS {
	if dir := os.Getenv("AGENTWEB_WEB_DIR"); dir != "" {
		return os.DirFS(dir)
	}
	web, err := fs.Sub(agentweb.Web, "web")
	if err != nil {
		panic(err) // "web" is a valid path, so never
	}
	return web
}
