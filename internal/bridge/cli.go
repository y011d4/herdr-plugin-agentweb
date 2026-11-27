package bridge

// yoicks's commands: run | start | stop | status |
// qr | overview | agent | worktree | orchestrator, plus serve (the bridge itself, what
// start launches in the background). herdr's actions and panes call them with cwd =
// the plugin root; an orchestrator calls overview, agent and worktree from its Bash.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const pluginID = "y011d4.yoicks"

// Version is the release this binary was built as (scripts/release.sh sets it with
// -ldflags -X); "dev" for a build from source.
var Version = "dev"

// herdrBin is the herdr CLI: HERDR_BIN_PATH, which herdr sets for plugin commands and
// its panes, else herdr on PATH.
func herdrBin() string { return firstNonEmpty(os.Getenv("HERDR_BIN_PATH"), "herdr") }

// CLI runs yoicks with args (the command line after the program name) and
// returns its exit code. web and rules are what serve and run embed.
func CLI(args []string, web fs.FS, rules string) int {
	c := cli{web: web, rules: rules}
	command := ""
	if len(args) > 0 {
		command, c.args = args[0], args[1:]
	}
	switch command {
	case "serve":
		if err := Serve(web, rules); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		return 0
	case "run":
		return c.run()
	case "start":
		return c.start()
	case "stop":
		return c.stop()
	case "status":
		return c.status()
	case "qr":
		return c.qr()
	case "overview":
		return c.overview()
	case "agent":
		return c.agent()
	case "worktree":
		return c.worktree()
	case "orchestrator":
		return c.orchestrator()
	}
	fmt.Fprintln(os.Stderr, "usage: yoicks <run|start|stop|status|qr|overview|agent|worktree|orchestrator>")
	return 2
}

type cli struct {
	web   fs.FS
	rules string
	args  []string // after the command
}

func (c cli) arg(i int) string {
	if i < len(c.args) {
		return c.args[i]
	}
	return ""
}

// ── state, config ────────────────────────────────────────────────────────────

// defaultStateDir is where herdr keeps this plugin's state (what it passes as
// HERDR_PLUGIN_STATE_DIR), also when yoicks runs outside herdr.
func defaultStateDir() string {
	return filepath.Join(firstNonEmpty(os.Getenv("XDG_STATE_HOME"), filepath.Join(osHomedir(), ".local", "state")), "herdr", "plugins", pluginID)
}

func stateDir() string {
	dir := firstNonEmpty(os.Getenv("HERDR_PLUGIN_STATE_DIR"), defaultStateDir())
	os.MkdirAll(dir, 0o700)
	return dir
}

func configDir() string {
	if d := os.Getenv("HERDR_PLUGIN_CONFIG_DIR"); d != "" {
		return d
	}
	// run outside herdr's plugin env (e.g. from an orchestrator's Bash): ask herdr
	if out, err := exec.Command(herdrBin(), "plugin", "config-dir", pluginID).Output(); err == nil && jsTrim(string(out)) != "" {
		return jsTrim(string(out))
	}
	return stateDir()
}

func readConfig() map[string]any {
	var cfg map[string]any
	if b, err := os.ReadFile(filepath.Join(configDir(), "config.json")); err == nil {
		json.Unmarshal(b, &cfg)
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	return cfg
}

// The detached daemon (start/stop) and the foreground pane (run) own separate pidfiles
// so one lifecycle can't clobber the other's bookkeeping.
func daemonPidFile() string { return filepath.Join(stateDir(), "bridge.pid") }
func runPidFile() string    { return filepath.Join(stateDir(), "bridge-run.pid") }

// ownExe is this binary's real path ("" when unknown).
func ownExe() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		return real
	}
	return exe
}

// isBridgeArgv is whether a command line is a bridge: `yoicks serve|run`, not
// another yoicks command (an orchestrator's background `agent wait` must not get
// a SIGTERM through a reused PID), whatever dir the binary lives in.
func isBridgeArgv(argv []string) bool {
	return len(argv) >= 2 && path.Base(argv[0]) == "yoicks" && (argv[1] == "serve" || argv[1] == "run")
}

// looksLikeBridge checks that a live pid from a pidfile still runs the bridge: the
// file may be stale and the PID reused by an unrelated process. When the command
// line can't be read, the PID is trusted rather than risk ignoring a real bridge.
func looksLikeBridge(pid int) bool {
	exe := ownExe()
	if runtime.GOOS == "linux" {
		b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
		if err != nil || len(b) == 0 {
			return true
		}
		argv := strings.Split(strings.TrimSuffix(string(b), "\x00"), "\x00")
		if isBridgeArgv(argv) {
			return true
		}
		// this very binary under another name (a symlink, a renamed file)
		target, err := os.Readlink("/proc/" + strconv.Itoa(pid) + "/exe")
		return err == nil && exe != "" && target == exe && len(argv) >= 2 && (argv[1] == "serve" || argv[1] == "run")
	}
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "args=").Output()
	cmd := strings.TrimSpace(string(out))
	if err != nil || cmd == "" {
		return true
	}
	return isBridgeCommandLine(cmd)
}

// isBridgeCommandLine is the check for a command line as ps prints it (no /proc): it
// ends in `yoicks serve|run` (a binary path may hold spaces).
func isBridgeCommandLine(cmd string) bool {
	return strings.HasSuffix(cmd, "yoicks serve") || strings.HasSuffix(cmd, "yoicks run")
}

func pidAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func alivePid(file string) int {
	b, err := os.ReadFile(file)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 || !pidAlive(pid) {
		return 0
	}
	if !looksLikeBridge(pid) {
		os.Remove(file) // a stale pidfile whose PID was reused
		return 0
	}
	return pid
}

// jsNumberString is String(Number(v)) for a port from the environment or config.
func jsNumberString(v any) string {
	f := math.NaN()
	switch v := v.(type) {
	case float64:
		f = v
	case string:
		if s := jsTrim(v); s == "" {
			f = 0
		} else if n, err := strconv.ParseFloat(s, 64); err == nil {
			f = n
		}
	}
	if math.IsNaN(f) {
		return "NaN"
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// port is the bridge's port as the CLI reads it (env, else config, else 8390).
func port(cfg map[string]any) string {
	if p := os.Getenv("HERDR_YOICKS_PORT"); p != "" {
		return jsNumberString(p)
	}
	if jsTruthy(cfg["port"]) {
		return jsNumberString(cfg["port"])
	}
	return "8390"
}

func baseURL(cfg map[string]any) string {
	host, _ := cfg["host"].(string)
	return "http://" + firstNonEmpty(os.Getenv("HERDR_YOICKS_HOST"), host, "127.0.0.1") + ":" + port(cfg) + "/"
}

// printConnectInfo never prints the token: herdr captures action stdout into its
// plugin logs. The tokenized link is printed by the bridge itself (the run pane and
// <state dir>/bridge.log) and by qr.
func printConnectInfo() {
	fmt.Println("url: " + baseURL(readConfig()))
	fmt.Println("token file: " + filepath.Join(stateDir(), "token"))
	fmt.Println("full connect link: see the Yoicks bridge pane or " + filepath.Join(stateDir(), "bridge.log"))
}

func notify(title, body string) {
	if herdr := os.Getenv("HERDR_BIN_PATH"); herdr != "" {
		exec.Command(herdr, "notification", "show", title, "--body", body).Run()
	}
}

// waitForExit waits until pid exits or the timeout passes; true if it exited.
func waitForExit(pid int, timeout time.Duration) bool {
	for deadline := time.Now().Add(timeout); pidAlive(pid); time.Sleep(100 * time.Millisecond) {
		if !time.Now().Before(deadline) {
			return false
		}
	}
	return true
}

// livePidFiles is the bridge's pidfiles and their live PIDs.
func livePidFiles() (daemonFile, runFile string, daemon, fg int) {
	daemonFile, runFile = daemonPidFile(), runPidFile()
	return daemonFile, runFile, alivePid(daemonFile), alivePid(runFile)
}

// runningPid is the live bridge's PID.
func runningPid() (pid int, foreground bool) {
	_, _, daemon, fg := livePidFiles()
	if pid = daemon; pid == 0 {
		pid = fg
	}
	return pid, fg != 0
}

func pidLabel(pid int, foreground bool) string {
	if foreground {
		return fmt.Sprintf("pid %d, foreground pane", pid)
	}
	return fmt.Sprintf("pid %d", pid)
}

// ── bridge lifecycle ─────────────────────────────────────────────────────────

func (c cli) start() int {
	if pid, fg := runningPid(); pid != 0 {
		fmt.Printf("bridge already running (%s)\n", pidLabel(pid, fg))
		printConnectInfo()
		return 0
	}
	logPath := filepath.Join(stateDir(), "bridge.log")
	log, err := os.OpenFile(logPath, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// the mode applies only when the file is created; the bridge writes the tokenized
	// connect URL to this log, so tighten an existing log too, or don't start
	if err := os.Chmod(logPath, 0o600); err != nil {
		log.Close()
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fail := func() int {
		os.Remove(daemonPidFile())
		fmt.Fprintf(os.Stderr, "bridge failed to start; see %s\n", logPath)
		return 1
	}
	exe, err := os.Executable()
	if err != nil {
		log.Close()
		return fail()
	}
	child := exec.Command(exe, "serve")
	child.Stdout, child.Stderr = log, log
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // detached: outlives this command
	err = child.Start()
	log.Close()
	if err != nil {
		return fail()
	}
	pid := child.Process.Pid
	exited := make(chan struct{})
	go func() { child.Wait(); close(exited) }()
	// without its pidfile, stop and status couldn't find it: don't leave it running
	if err := os.WriteFile(daemonPidFile(), []byte(strconv.Itoa(pid)), 0o600); err != nil {
		child.Process.Signal(syscall.SIGTERM)
		select {
		case <-exited:
		case <-time.After(5 * time.Second):
		}
		fmt.Fprintln(os.Stderr, err)
		return fail()
	}
	// Give it a moment to bind the port: if it dies at once (e.g. an old bridge still
	// holds the port) say so instead of a false success and a stale pidfile.
	select {
	case <-exited:
		return fail()
	case <-time.After(400 * time.Millisecond):
	}
	fmt.Printf("bridge started (pid %d)\n", pid)
	printConnectInfo()
	fmt.Println("log: " + logPath)
	notify("yoicks started", baseURL(readConfig()))
	return 0
}

func (c cli) stop() int {
	daemonFile, runFile, daemon, fg := livePidFiles()
	pid := daemon
	if pid == 0 {
		pid = fg
	}
	if pid == 0 {
		fmt.Println("bridge is not running")
		os.Remove(daemonPidFile())
		return 0
	}
	if err := syscall.Kill(pid, syscall.SIGTERM); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// Wait for it to release the port, so a following start doesn't race the dying
	// bridge. No SIGKILL: a stale pidfile's PID may belong to something else now.
	ok := waitForExit(pid, 5*time.Second)
	if daemon != 0 {
		os.Remove(daemonFile)
	} else {
		os.Remove(runFile)
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "bridge (pid %d) did not exit within 5s of SIGTERM; not force-killing\n", pid)
		notify("yoicks stop timed out", fmt.Sprintf("pid %d", pid))
		return 1
	}
	fmt.Printf("bridge stopped (pid %d)\n", pid)
	notify("yoicks stopped", fmt.Sprintf("pid %d", pid))
	return 0
}

func (c cli) status() int {
	if pid, fg := runningPid(); pid != 0 {
		fmt.Printf("bridge running (%s)\n", pidLabel(pid, fg))
		printConnectInfo()
		notify("yoicks running", baseURL(readConfig()))
	} else {
		fmt.Println("bridge is not running")
		notify("yoicks stopped", "invoke y011d4.yoicks.start to launch")
	}
	printEnvironment()
	return 0
}

// printEnvironment is status's troubleshooting part: this binary's version, the herdr
// it reaches, and which optional commands it finds (on the PATH herdr gives actions).
func printEnvironment() {
	fmt.Println("yoicks " + Version)
	var pong struct {
		Version  string `json:"version"`
		Protocol int    `json:"protocol"`
	}
	if raw, err := cliRPC("ping", nil, 2*time.Second); err != nil {
		fmt.Printf("herdr: not reachable (%s)\n", err)
	} else if err := json.Unmarshal(raw, &pong); err != nil {
		fmt.Printf("herdr: unexpected ping answer (%s)\n", err)
	} else {
		fmt.Println(herdrVersionText(pong.Version, pong.Protocol))
	}
	var found, missing []string
	for _, name := range []string{"git", "direnv", "gh", "tailscale", "qrencode"} {
		if _, err := exec.LookPath(name); err == nil {
			found = append(found, name)
		} else {
			missing = append(missing, name)
		}
	}
	fmt.Printf("optional commands: found [%s], missing [%s]\n", strings.Join(found, " "), strings.Join(missing, " "))
}

// run serves in the foreground, in this process (the TS ran node in a child).
func (c cli) run() int {
	if pid, _ := runningPid(); pid != 0 {
		fmt.Fprintf(os.Stderr, "bridge already running (pid %d); stop it first\n", pid)
		return 1
	}
	file := runPidFile()
	if err := os.WriteFile(file, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, err) // stop and status couldn't find it
		return 1
	}
	defer os.Remove(file)
	if err := Serve(c.web, c.rules); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// qr shows the connect link as a QR code (pane "connect", or by hand). Unlike start
// and status this is an explicit, interactive surface, so the token is shown here.
func (c cli) qr() int {
	b, err := os.ReadFile(filepath.Join(stateDir(), "token"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "no token yet — start the bridge first (action y011d4.yoicks.start)")
		return 1
	}
	token := jsTrim(string(b))
	cfg := readConfig()
	p := port(cfg)
	// config public_url wins; tailscale detection is a zero-config convenience only
	publicURL := ""
	if s, ok := cfg["public_url"].(string); ok {
		publicURL = strings.TrimRight(jsTrim(s), "/")
	}
	var url, hint string
	if publicURL != "" {
		url = publicURL + "/?token=" + token
	} else {
		dns, ip, serveActive := tailscaleInfo(p)
		switch {
		case serveActive && dns != "":
			url = "https://" + dns + "/?token=" + token
		case ip != "":
			url = "http://" + ip + ":" + p + "/?token=" + token
		default:
			url = baseURL(cfg) + "?token=" + token
		}
		if !serveActive {
			hint = `hint: set "public_url" in config.json (herdr plugin config-dir y011d4.yoicks) to your reverse-proxy / tunnel / VPN address (Cloudflare Tunnel, Caddy, ngrok, ...). Tailscale is auto-detected; for tailnet HTTPS run: tailscale serve --bg ` + p
		}
	}
	// the URL goes to qrencode on stdin: an argument would show the token in ps
	enc := exec.Command("qrencode", "-t", "UTF8")
	enc.Stdin = strings.NewReader(url)
	if out, err := enc.Output(); err == nil {
		fmt.Println(string(out))
	} else {
		fmt.Print("(qrencode not found — install it for a scannable QR code)\n\n")
	}
	fmt.Println(url)
	if hint != "" {
		fmt.Println("\n" + hint)
	}
	if os.Getenv("HERDR_PLUGIN_ENTRYPOINT_ID") != "" {
		fmt.Println("\npress Enter to close")
		os.Stdin.Read(make([]byte, 1024))
	}
	return 0
}

func tailscaleInfo(port string) (dns, ip string, serveActive bool) {
	out, err := exec.Command("tailscale", "status", "--json").Output()
	if err != nil {
		return "", "", false
	}
	var st struct {
		Self *struct {
			DNSName      string   `json:"DNSName"`
			TailscaleIPs []string `json:"TailscaleIPs"`
		} `json:"Self"`
	}
	if json.Unmarshal(out, &st) != nil {
		return "", "", false
	}
	if st.Self != nil {
		dns = strings.TrimSuffix(st.Self.DNSName, ".")
		if len(st.Self.TailscaleIPs) > 0 {
			ip = st.Self.TailscaleIPs[0]
		}
	}
	serve, err := exec.Command("tailscale", "serve", "status").Output()
	return dns, ip, err == nil && strings.Contains(string(serve), ":"+port)
}

// ── herdr ────────────────────────────────────────────────────────────────────

// cliRPC is one herdr request (herdr answers one per connection), with the CLI's own
// timeouts and error texts, and no logging: stderr is the command's output.
func cliRPC(method string, params map[string]any, timeout time.Duration) (json.RawMessage, error) {
	if params == nil {
		params = map[string]any{}
	}
	socket := firstNonEmpty(os.Getenv("HERDR_SOCKET_PATH"), filepath.Join(osHomedir(), ".config", "herdr", "herdr.sock"))
	conn, err := net.DialTimeout("unix", socket, timeout)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))
	req, err := json.Marshal(map[string]any{"type": "request", "id": "yoicks", "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(append(req, '\n')); err != nil {
		return nil, err
	}
	// a whole line: a multi-byte character split across reads stays intact
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		if errors.Is(err, os.ErrDeadlineExceeded) {
			return nil, fmt.Errorf("%s: timeout", method)
		}
		return nil, fmt.Errorf("%s: connection closed", method)
	}
	var msg struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(line, &msg); err != nil {
		return nil, err
	}
	if msg.Error != nil {
		return nil, &HerdrError{Code: msg.Error.Code, Message: firstNonEmpty(msg.Error.Message, method+" failed")}
	}
	return msg.Result, nil
}

func rpcWithin(timeout time.Duration) Rpc {
	return func(method string, params map[string]any) (json.RawMessage, error) {
		return cliRPC(method, params, timeout)
	}
}

var rpc5s = rpcWithin(5 * time.Second)

// ── overview ─────────────────────────────────────────────────────────────────

// overview is a read-only, LLM-facing summary of every other herdr agent of the
// caller's Claude account (for an orchestrator's Bash; agents of other accounts, or
// whose account can't be told, are left out). It touches only the herdr socket and
// the claude transcripts, never the state dir or the bridge token.
func (c cli) overview() int {
	text, err := overviewText(rpc5s, ownAccount(), os.Getenv("HERDR_PANE_ID"), nowMs())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(text)
	return 0
}

// overviewText is the overview of account own's agents but self (own "": none), as of now.
// The CLI and an orchestrator's MCP tool both show it.
func overviewText(rpc Rpc, own, self string, now int64) (string, error) {
	var list struct {
		Agents []OverviewAgent `json:"agents"`
	}
	var snap struct {
		Snapshot OverviewSnapshot `json:"snapshot"`
	}
	for _, q := range []struct {
		method string
		into   any
	}{{"agent.list", &list}, {"session.snapshot", &snap}} {
		raw, err := rpc(q.method, nil)
		if err != nil {
			return "", errors.New("herdr unreachable: " + err.Error())
		}
		json.Unmarshal(raw, q.into)
	}
	var agents []OverviewAgent
	for _, a := range list.Agents {
		if own == "" {
			continue
		}
		if theirs, err := paneAccount(rpc, a.PaneID); err == nil && theirs == own {
			agents = append(agents, a)
		}
	}
	details := map[string]AgentDetail{}
	for _, a := range orderAgents(agents, self) {
		var d AgentDetail
		if s := a.AgentSession; s != nil && strings.HasPrefix(s.Source, "herdr:claude") && s.Value != "" {
			// own: every listed agent runs under it, wherever its CLAUDE_CONFIG_DIR lives
			if file := resolveTranscriptPath(s.Value, firstNonEmpty(a.ForegroundCwd, a.Cwd), []string{own}); file != "" {
				d.Items = readTranscriptTail(file, 1000).Items
				// the request scrolled out of the tail window: look further back for it
				if !slices.ContainsFunc(d.Items, isTaskTurn) {
					if older := findLastItem(file, isTaskTurn, findLastItemMaxBytes); older != nil && older.Kind == "user" {
						d.OlderTask = older.Text
					}
				}
			}
		}
		if len(d.Items) == 0 {
			if raw, err := rpc("pane.read", map[string]any{"pane_id": a.PaneID, "source": "recent", "lines": 40, "format": "text"}); err == nil {
				var res struct {
					Read struct {
						Text string `json:"text"`
					} `json:"read"`
				}
				json.Unmarshal(raw, &res)
				d.Screen = res.Read.Text
			}
		}
		details[a.PaneID] = d
	}
	return formatOverview(agents, snap.Snapshot, details, self, now), nil
}

// ── orchestrator agent commands ──────────────────────────────────────────────
// The herdr agent commands an orchestrator needs, refused for any agent or place
// outside its own Claude account (account.go), so an orchestrator allowed only these
// (not the herdr CLI) can't see or drive another account's agents. Once checked,
// get/read/prompt/wait run herdr's own CLI on the resolved pane, so output, flags and
// --wait behave exactly like `herdr agent …`.

const agentUsage = `usage: yoicks agent get|read|prompt|wait <target> [herdr agent flags]
       yoicks agent start <name> --cwd <dir> [--profile <launch profile>] [--worktree <branch> [--base <ref>]]`

func (c cli) agent() int {
	sub := c.arg(0)
	if sub == "start" {
		return c.agentStart(c.args[1:])
	}
	target := c.arg(1)
	if !slices.Contains([]string{"get", "read", "prompt", "wait"}, sub) || target == "" || strings.HasPrefix(target, "-") {
		fmt.Fprintln(os.Stderr, agentUsage)
		return 2
	}
	paneID, err := ownAgentPane(rpc5s, target, ownAccount())
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// the pane id, not the name: what was checked is what herdr acts on
	herdr := exec.Command(herdrBin(), append([]string{"agent", sub, paneID}, c.args[2:]...)...)
	herdr.Stdin, herdr.Stdout, herdr.Stderr = os.Stdin, os.Stdout, os.Stderr
	return exitCode(herdr.Run())
}

// ownAgentPane is the pane of agent target (a name or a pane id) when it runs under
// account own; refused otherwise, or when its account (or own) can't be told.
func ownAgentPane(rpc Rpc, target, own string) (string, error) {
	raw, err := rpc("agent.get", map[string]any{"target": target})
	if err != nil {
		return "", fmt.Errorf("%s: %s", target, err)
	}
	var got struct {
		Agent *struct {
			PaneID string `json:"pane_id"`
		} `json:"agent"`
	}
	json.Unmarshal(raw, &got)
	paneID, theirs := "", ""
	if got.Agent != nil && got.Agent.PaneID != "" {
		paneID = got.Agent.PaneID
		theirs, _ = paneAccount(rpc, paneID)
	}
	if own == "" || theirs != own {
		return "", fmt.Errorf("refused: %s is not an agent of this Claude account (or its account can't be told)", target)
	}
	return paneID, nil
}

// exitCode is a finished command's exit status as spawnSync reports it: 1 when it
// couldn't run or was killed by a signal.
func exitCode(err error) int {
	var ee *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &ee) && ee.ExitCode() >= 0:
		return ee.ExitCode()
	}
	return 1
}

// agentStart starts an agent from a launch profile (config launch_profiles; never a
// raw command) in a dir of the caller's account: a new tab in the workspace already at
// that dir (else a new workspace), or a new worktree of the repo there. The dir's
// account is checked before anything is created, the started agent's after; a
// mismatch closes it.
func (c cli) agentStart(args []string) int {
	usage := func() int { fmt.Fprintln(os.Stderr, agentUsage); return 2 }
	if len(args) == 0 {
		return usage()
	}
	name, flags := args[0], args[1:]
	opt := map[string]string{}
	for i := 0; i < len(flags); i += 2 {
		if !slices.Contains([]string{"--cwd", "--profile", "--worktree", "--base"}, flags[i]) || i+1 >= len(flags) {
			return usage()
		}
		opt[flags[i][2:]] = flags[i+1]
	}
	if name == "" || strings.HasPrefix(name, "-") || opt["cwd"] == "" || opt["base"] != "" && opt["worktree"] == "" {
		return usage()
	}
	// agent.start waits for the agent to come up, and worktree.create runs git: allow time
	profiles := func() map[string]LaunchProfile { return parseLaunchProfiles(readConfig()["launch_profiles"]) }
	_, started, err := startOwnAgent(rpcWithin(60*time.Second), profiles, ownAccount(), name, opt)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(started)
	return 0
}

// startOwnAgent starts agent name from launch profile opt["profile"] (default claude) in
// dir opt["cwd"], or in a new worktree opt["worktree"] (from opt["base"] when set) of the
// repo there, when that place is under account own (see agentStart): its pane, and where it started.
// profiles is read only once the checks pass (the CLI reads config.json for it).
func startOwnAgent(rpc Rpc, profiles func() map[string]LaunchProfile, own, name string, opt map[string]string) (paneID, started string, err error) {
	dir, _ := filepath.Abs(opt["cwd"])
	profile, ok := opt["profile"]
	if !ok {
		profile = "claude"
	}
	in := StartAgentInput{Profile: profile, Name: name, Cwd: dir}
	places := []string{dir}
	where := dir
	if opt["worktree"] != "" {
		// next to the repo, so an .envrc above it (e.g. one per org dir) sets the checkout's account too
		spec := map[string]any{"repo": dir, "branch": opt["worktree"]}
		if base, ok := opt["base"]; ok {
			spec["base"] = base
		}
		placed, err := placeWorktreeNextToRepo(spec, nil, nil)
		if err != nil {
			return "", "", err
		}
		wt := worktreeInput(placed)
		in.Worktree = &wt
		where, _ = placed["path"].(string)
		places = append(places, filepath.Dir(where))
	}
	// A new tab/workspace starts with the caller's account (CLAUDE_CONFIG_DIR), so it
	// needs no direnv; it is refused only where direnv says another account applies. A
	// worktree gets no env from herdr, so its account must come from the dir itself.
	if in.Worktree == nil {
		in.Env = accountEnv(own, "")
	}
	for _, p := range places {
		theirs := dirAccount(p)
		if own == "" || theirs != own && (theirs != "" || in.Worktree != nil) {
			why := ""
			if in.Worktree != nil {
				why = ", or can't be read"
			}
			return "", "", fmt.Errorf("refused: %s is not under this Claude account (its direnv CLAUDE_CONFIG_DIR differs%s)", p, why)
		}
	}

	if in.Worktree == nil {
		// the workspace already at this dir (a worktree checkout, or any pane launched there)
		raw, err := rpc("session.snapshot", nil)
		if err != nil {
			return "", "", errors.New("start failed: " + err.Error())
		}
		var snap struct {
			Snapshot RawSnapshot `json:"snapshot"`
		}
		json.Unmarshal(raw, &snap)
		ws := ""
		for _, w := range snap.Snapshot.Workspaces {
			if w.Worktree != nil && w.Worktree.CheckoutPath == dir {
				ws = w.WorkspaceID
				break
			}
		}
		for _, p := range snap.Snapshot.Panes {
			if ws == "" && p.Cwd == dir {
				ws = p.WorkspaceID
			}
		}
		if ws != "" {
			in.Workspace = ws
		} else {
			in.NewWorkspace = true
		}
	}
	out, err := startAgent(rpc, profiles(), in, StartAgentOptions{
		Verify: func(paneID string) error {
			if err := waitForDetectedAgent(rpc, paneID); err != nil {
				return err
			}
			theirs, err := paneAccount(rpc, paneID)
			if err != nil {
				return err
			}
			if theirs != own {
				return errors.New("the agent came up under another Claude account")
			}
			return nil
		},
	})
	if err != nil {
		return "", "", errors.New("start failed: " + err.Error())
	}
	return out.PaneID, fmt.Sprintf("started %s (pane %s) in %s", out.Name, out.PaneID, where), nil
}

// worktree removes a finished worker's worktree: the checkout (herdr's
// worktree.remove, which itself refuses uncommitted or untracked files) and its
// branch, only for a linked worktree of the caller's account with no agent left in
// it, whose branch is merged upstream (an ancestor of origin's default branch, or the
// head of a merged PR, for squash merges). A detached HEAD's checkout goes when its
// commit is upstream, the branch named in its dir only when merged. Anything else is
// refused and left as is.
func (c cli) worktree() int {
	if c.arg(0) != "remove" || c.arg(1) == "" {
		fmt.Fprintln(os.Stderr, "usage: yoicks worktree remove <checkout path>")
		return 2
	}
	removed, err := removeOwnWorktree(rpc5s, rpcWithin(60*time.Second), ownAccount(), c.arg(1))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(removed)
	return 0
}

// removeOwnWorktree removes checkout path (see worktree) when it is under account own, and
// says what it removed. rpc reads herdr's state; slow (allowing git time) removes the worktree.
func removeOwnWorktree(rpc, slow Rpc, own, path string) (string, error) {
	dir, _ := filepath.Abs(path)
	refuse := func(why string) (string, error) {
		return "", fmt.Errorf("refused: %s; %s was left as it is", why, dir)
	}
	raw, err := rpc("session.snapshot", nil)
	if err != nil {
		return "", err
	}
	var snap struct {
		Snapshot RawSnapshot `json:"snapshot"`
	}
	json.Unmarshal(raw, &snap)
	var ws *RawWorkspace
	for i, w := range snap.Snapshot.Workspaces {
		if w.Worktree != nil && w.Worktree.CheckoutPath == dir && w.Worktree.IsLinkedWorktree != nil && *w.Worktree.IsLinkedWorktree {
			ws = &snap.Snapshot.Workspaces[i]
			break
		}
	}
	if ws == nil || ws.Worktree.RepoRoot == "" {
		return refuse("not a linked worktree open in herdr")
	}
	if own == "" || dirAccount(dir) != own {
		return refuse("it is not under this Claude account")
	}
	if checkoutInUse(snap.Snapshot.Panes, ws.WorkspaceID, dir) {
		return refuse("an agent still runs in it (end it with /exit first)")
	}

	git := func(args ...string) (string, bool) {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...).Output()
		return string(out), err == nil
	}
	head, _ := git("symbolic-ref", "--short", "HEAD")
	branch := jsTrim(head)
	tipOut, _ := git("rev-parse", "HEAD")
	tip := jsTrim(tipOut)
	git("fetch", "--quiet", "origin") // best effort: judge against what's upstream now
	up, _ := git("rev-parse", "--abbrev-ref", "origin/HEAD")
	upstream := firstNonEmpty(jsTrim(up), "origin/main")
	inUpstream := func(rev string) bool {
		_, ok := git("merge-base", "--is-ancestor", rev, upstream)
		return ok
	}
	// branch at rev is merged: rev is upstream, or the head of a merged PR (a squash merge)
	merged := func(branch, rev string) bool {
		if inUpstream(rev) {
			return true
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		gh := exec.CommandContext(ctx, "gh", "pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid", "--jq", ".[].headRefOid")
		gh.Dir = dir
		out, _ := gh.Output()
		return rev != "" && slices.Contains(strings.Split(string(out), "\n"), rev)
	}
	kept := "" // why a detached HEAD's branch stays
	if branch != "" {
		if !merged(branch, tip) {
			return refuse(branch + " has commits not merged into " + upstream + " (nor the head of a merged PR)")
		}
	} else {
		// detached (a worker that deployed checks out the commit it deployed): the checkout
		// goes once that commit is upstream, the branch it was made for only when that is
		// merged too. That branch is the one its first checkout moved away from, per its
		// HEAD's reflog (git's own record of this worktree), and its dir (<repo>-wt-<branch>)
		// must be named after it (the name alone can't tell feat/x from feat-x)
		if !inUpstream(tip) {
			return refuse("its HEAD is detached at a commit not in " + upstream)
		}
		lp, _ := git("rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD")
		log, _ := os.ReadFile(jsTrim(lp))
		lines := strings.Split(string(log), "\n") // oldest first: "<old id> <new id> <who> <when>\t<message>"
		first := ""
		// only a reflog from HEAD's creation (`git worktree add`'s entry, from the null id):
		// with older entries expired (gc keeps the ids), the oldest checkout left needn't be the first
		if old, _, _ := strings.Cut(lines[0], " "); old != "" && strings.Trim(old, "0") == "" {
			for _, l := range lines {
				_, msg, _ := strings.Cut(l, "\t")
				if from, ok := strings.CutPrefix(msg, "checkout: moving from "); ok {
					first, _, _ = strings.Cut(from, " ")
					break
				}
			}
		}
		name, named := strings.CutPrefix(filepath.Base(dir), filepath.Base(ws.Worktree.RepoRoot)+"-wt-")
		btip, isBranch := git("rev-parse", "-q", "--verify", "refs/heads/"+first)
		switch {
		case first == "" || !isBranch || !named || unsafePathChars.ReplaceAllString(first, "-") != name:
			kept = "no branch deleted: its reflog and name show no local branch it was made for"
		case !merged(first, jsTrim(btip)):
			kept = "branch " + first + " kept: git can't tell it is merged into " + upstream + " (nor gh that it is a merged PR's head)"
		default:
			branch = first
		}
	}

	// herdr closes the worktree's workspace with it, so a shell left there (a worker's pane
	// after /exit) goes too; a shell elsewhere in the dir only loses its cwd
	if _, err := slow("worktree.remove", map[string]any{"workspace_id": ws.WorkspaceID}); err != nil {
		if herdrCode(err) == "dirty_worktree_requires_force" {
			return refuse("it has uncommitted or untracked files")
		}
		return refuse(err.Error())
	}
	if kept != "" {
		return fmt.Sprintf("removed %s (%s)", dir, kept), nil
	}
	// merge verified above (a squash merge isn't an ancestor, so -d would balk)
	del := exec.Command("git", "-C", ws.Worktree.RepoRoot, "branch", "-D", branch)
	var stderr bytes.Buffer
	del.Stderr = &stderr
	if del.Run() != nil {
		return fmt.Sprintf("removed %s (branch %s kept: %s)", dir, branch, jsTrim(stderr.String())), nil
	}
	return fmt.Sprintf("removed %s and branch %s", dir, branch), nil
}

// orchestrator starts a configured orchestrator (config.json `orchestrators`) the way
// the phone's Start button does: write its dir, then start it in a new workspace with
// its env.
func (c cli) orchestrator() int {
	name := c.arg(1)
	if c.arg(0) != "start" || name == "" {
		fmt.Fprintln(os.Stderr, "usage: yoicks orchestrator start <name>")
		return 2
	}
	cfg := readConfig()
	home := osHomedir()
	defs := parseOrchestrators(cfg["orchestrators"], home, dataDir(home))
	i := slices.IndexFunc(defs, func(d OrchestratorDef) bool { return d.Name == name })
	if i == -1 {
		fmt.Fprintf(os.Stderr, "no orchestrator named %s in config.json\n", name)
		return 1
	}
	// the bridge runs a headless one itself; macOS has no /proc to see one running
	if defs[i].Mode == "headless" {
		fmt.Fprintf(os.Stderr, "orchestrator %s is headless: the bridge runs it, so start it from its Home\n", name)
		return 1
	}
	if pid := markedHeadlessChild(stateDir(), name); pid != 0 {
		fmt.Fprintf(os.Stderr, "orchestrator %s runs headless (pid %d): stop it from its Home first\n", name, pid)
		return 1
	}
	paneID, _, err := startOrchestrator(rpcWithin(60*time.Second), defs[i], c.rules)
	if err != nil {
		fmt.Fprintln(os.Stderr, "start failed: "+err.Error())
		return 1
	}
	fmt.Printf("started orchestrator %s (pane %s) in %s\n", name, paneID, defs[i].Dir)
	return 0
}
