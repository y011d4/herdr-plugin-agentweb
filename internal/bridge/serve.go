package bridge

// The bridge process, a port of server/main.ts.

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os/exec"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

// verifiedProtocol is the herdr socket protocol the bridge was verified against
// (herdr 0.9.5). Another one may well work; nobody has checked it.
const verifiedProtocol = 22

// herdrVersionText names a herdr and warns when its protocol isn't verifiedProtocol.
func herdrVersionText(version string, protocol int) string {
	text := fmt.Sprintf("herdr %s, protocol %d", firstNonEmpty(version, "(unknown version)"), protocol)
	if protocol != verifiedProtocol {
		text += fmt.Sprintf(" (warning: only protocol %d is verified; if something fails, report it with the output of `herdr api schema --json`)", verifiedProtocol)
	}
	return text
}

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
	lastHerdr := "" // OnState runs on the client's one goroutine
	client := NewHerdrClient(cfg.SocketPath, HerdrClientCallbacks{
		OnState: func(st *State) {
			// herdr's version on connect, and again when it changes (herdr updated)
			if p := st.Herdr.Protocol; p != nil {
				version := ""
				if st.Herdr.Version != nil {
					version = *st.Herdr.Version
				}
				if line := herdrVersionText(version, *p); line != lastHerdr {
					fmt.Println("[herdr] " + line)
					lastHerdr = line
				}
			}
			srv.broadcastState()
		},
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
	fmt.Printf("yoicks %s listening on %s\n", Version, base)
	fmt.Printf("connect: %s?token=%s\n", base, token)
	// direnv picks the accounts of dirs (dirAccount): without it, a dir's account is unknown
	if p, err := exec.LookPath("direnv"); err == nil {
		fmt.Println("[yoicks] direnv: " + p)
	} else {
		fmt.Println("[yoicks] direnv: not found (dirs' Claude accounts can't be read)")
	}
	client.Start()
	srv.startHeadless()

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
		srv.shutdownHeadless()
		client.Destroy()
		return err
	case <-ctx.Done():
	}
	fmt.Println("[yoicks] shutting down")
	// all within yoicks stop's 5 s: the headless children (≤2 s, in parallel), then the rest
	began := time.Now()
	srv.shutdownHeadless()
	client.Destroy()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), max(500*time.Millisecond, 3*time.Second-time.Since(began)))
	defer cancel()
	_ = hs.Shutdown(shutdownCtx) // whatever is still open then is cut off
	return nil
}
