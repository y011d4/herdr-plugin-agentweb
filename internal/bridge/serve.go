package bridge

// The bridge process, a port of server/main.ts.

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

// Serve runs the bridge until SIGINT or SIGTERM: it writes the managed orchestrators'
// dirs, reads (or makes) the token, serves HTTP + WS on the configured address and
// keeps a herdr connection. web is the built web UI, rules the bundled
// orchestrator/rules.md.
func Serve(web fs.FS, rules string) error {
	log.SetFlags(0) // the lines go to bridge.log as they are, like console.error's
	cfg := loadConfig()

	// managed orchestrators' dirs exist from the start, so their local.md can be
	// edited before the first start (each start writes them again)
	for _, def := range cfg.Orchestrators {
		if !def.Managed {
			continue
		}
		if err := ensureOrchestratorDir(def, rules); err != nil {
			log.Printf("orchestrator %s: could not write %s: %s", def.Name, def.Dir, err)
		}
	}
	token, err := initAuth(cfg.StateDir)
	if err != nil {
		return err
	}

	var srv *server // set before the client starts, which is when callbacks begin
	client := NewHerdrClient(cfg.SocketPath, HerdrClientCallbacks{
		OnState: func(*State) { srv.broadcastState() },
		OnAgentStatus: func(change StatusChange, st *State) {
			srv.broadcastAgentStatus(change, st)
			go sendNtfyNotification(change, st, cfg.NotifyURL)
		},
		OnConnectionChange: func(connected bool) {
			fmt.Printf("[herdr] %s\n", map[bool]string{true: "connected", false: "disconnected"}[connected])
		},
	})
	srv = newServer(cfg, client, web, rules)
	defer srv.close()

	ln, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)))
	if err != nil {
		client.Destroy()
		return err
	}
	base := fmt.Sprintf("http://%s:%d", cfg.Host, cfg.Port)
	fmt.Printf("herdr-agentweb listening on %s\n", base)
	fmt.Printf("connect: %s?token=%s\n", base, token)
	client.Start()

	hs := &http.Server{
		Handler: srv,
		// Node's defaults (headersTimeout 60 s, keepAliveTimeout 5 s; its 5 min
		// requestTimeout is set per request in ServeHTTP). WS connections are hijacked,
		// so none of these apply to them.
		ReadHeaderTimeout: 60 * time.Second,
		IdleTimeout:       5 * time.Second,
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	served := make(chan error, 1)
	go func() { served <- hs.Serve(ln) }()
	select {
	case err := <-served:
		client.Destroy()
		return err
	case <-ctx.Done():
	}
	fmt.Println("[herdr-agentweb] shutting down")
	client.Destroy()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = hs.Shutdown(shutdownCtx) // whatever is still open after 3 s is cut off
	return nil
}
