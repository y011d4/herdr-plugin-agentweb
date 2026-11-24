// Command agentwebctl is the herdr-agentweb bridge and its CLI. For now (the Go
// migration's P2, docs/go-migration-plan.md) it has only `serve`, the bridge itself
// (server/main.ts); the other subcommands come with P3.
package main

import (
	"fmt"
	"io/fs"
	"os"

	agentweb "github.com/y011d4/herdr-plugin-agentweb"
	"github.com/y011d4/herdr-plugin-agentweb/internal/bridge"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		fmt.Fprintln(os.Stderr, "usage: agentwebctl serve")
		os.Exit(2)
	}
	if err := bridge.Serve(webFS(), agentweb.Rules); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
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
