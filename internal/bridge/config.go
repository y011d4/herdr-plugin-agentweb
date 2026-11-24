package bridge

// The bridge's configuration, a port of server/config.ts: config.json in
// $HERDR_PLUGIN_CONFIG_DIR, overridden by environment variables.

import (
	"encoding/json"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// osHomedir is Node's os.homedir(): $HOME when set (even empty), else the passwd entry.
func osHomedir() string {
	if home, ok := os.LookupEnv("HOME"); ok {
		return home
	}
	if u, err := user.Current(); err == nil {
		return u.HomeDir
	}
	return ""
}

func loadFileConfig() map[string]any {
	configDir := os.Getenv("HERDR_PLUGIN_CONFIG_DIR")
	if configDir == "" {
		return nil
	}
	b, err := os.ReadFile(filepath.Join(configDir, "config.json"))
	if err != nil {
		return nil
	}
	var file map[string]any
	if json.Unmarshal(b, &file) != nil {
		return nil
	}
	return file
}

// dataDir is where the plugin keeps its data, the managed orchestrators' dirs among it.
func dataDir(home string) string {
	return filepath.Join(firstNonEmpty(os.Getenv("XDG_DATA_HOME"), filepath.Join(home, ".local", "share")), "herdr-agentweb")
}

// nonEmpty is v as a string when it is one with more than white space.
func nonEmpty(v any) (string, bool) {
	s, ok := v.(string)
	return s, ok && jsTrim(s) != ""
}

// expandHome trims v and expands a leading ~ (alone or before a /) to home.
func expandHome(v, home string) string {
	v = jsTrim(v)
	if v == "~" || strings.HasPrefix(v, "~/") {
		return home + v[1:]
	}
	return v
}

func expandDir(dir, home string) string { return strings.TrimRight(expandHome(dir, home), "/") }

var (
	orchestratorNameRE = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	envNameRE          = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// parseOrchestrators reads config `orchestrators: [{ name, label?, env? }]`, in
// order. Each is managed by the plugin in <data>/orchestrators/<name> and started
// with its env (string values; a leading ~ is expanded, so
// "CLAUDE_CONFIG_DIR": "~/.config/claude/work" works). An entry that still has the
// earlier format's dir is that dir, unmanaged. Malformed entries and repeated names
// are dropped. With none left, the older setup stays as it was: the single
// orchestrator_dir, else the old default dir (<data>/dispatcher) when it exists,
// both unmanaged as the user's own dir, else one managed orchestrator named default.
func parseOrchestrators(raw, legacyDir any, home, data string, exists func(string) bool) []OrchestratorDef {
	var out []OrchestratorDef
	entries, _ := raw.([]any)
	for _, e := range entries {
		entry, _ := e.(map[string]any)
		// name is a dir name and goes into the app's #/home/<name> route: keep it a plain slug
		name, ok := nonEmpty(entry["name"])
		if !ok || !orchestratorNameRE.MatchString(name) || slices.ContainsFunc(out, func(o OrchestratorDef) bool { return o.Name == name }) {
			continue
		}
		vars := map[string]string{}
		env, _ := entry["env"].(map[string]any)
		for k, v := range env {
			if s, ok := v.(string); ok && envNameRE.MatchString(k) {
				vars[k] = expandHome(s, home)
			}
		}
		label := name
		if l, ok := nonEmpty(entry["label"]); ok {
			label = jsTrim(l)
		}
		// an entry with its own dir (the earlier format) stays that unmanaged dir
		if dir, ok := nonEmpty(entry["dir"]); ok {
			out = append(out, OrchestratorDef{Name: name, Label: label, Dir: expandDir(dir, home), Env: vars})
		} else {
			out = append(out, OrchestratorDef{Name: name, Label: label, Dir: filepath.Join(data, "orchestrators", name), Env: vars, Managed: true})
		}
	}
	if len(out) > 0 {
		return out
	}
	legacy, configured := nonEmpty(legacyDir)
	if configured {
		legacy = expandDir(legacy, home)
	} else {
		legacy = filepath.Join(data, "dispatcher")
	}
	if configured || exists(legacy) {
		return []OrchestratorDef{{Name: "default", Dir: legacy, Env: map[string]string{}}}
	}
	return []OrchestratorDef{{Name: "default", Dir: filepath.Join(data, "orchestrators", "default"), Env: map[string]string{}, Managed: true}}
}

// jsParseInt is parseInt(s, 10), or -1 for NaN and for a number too big for an int:
// as a port, Node refuses to listen on those too.
func jsParseInt(s string) int {
	s = strings.TrimLeftFunc(s, isJSSpace)
	neg := strings.HasPrefix(s, "-")
	if neg || strings.HasPrefix(s, "+") {
		s = s[1:]
	}
	end := 0
	for end < len(s) && '0' <= s[end] && s[end] <= '9' {
		end++
	}
	n, err := strconv.Atoi(s[:end])
	if err != nil {
		return -1
	}
	if neg {
		return -n
	}
	return n
}

func loadConfig() Config {
	file := loadFileConfig()
	home := osHomedir()

	fileHost, _ := file["host"].(string)
	port := 8390
	if v := os.Getenv("HERDR_AGENTWEB_PORT"); v != "" {
		port = jsParseInt(v)
	} else if f, ok := file["port"].(float64); ok {
		// a fraction stays unusable, as it is for Node: -1
		if port = int(f); float64(port) != f {
			port = -1
		}
	}
	var notifyURL, publicURL *string
	if s, ok := file["notify_url"].(string); ok {
		notifyURL = &s
	}
	if s, ok := nonEmpty(file["public_url"]); ok {
		u := strings.TrimRight(jsTrim(s), "/")
		publicURL = &u
	}

	return Config{
		Host:           firstNonEmpty(os.Getenv("HERDR_AGENTWEB_HOST"), fileHost, "127.0.0.1"),
		Port:           port,
		NotifyURL:      notifyURL,
		PublicURL:      publicURL,
		StateDir:       firstNonEmpty(os.Getenv("HERDR_PLUGIN_STATE_DIR"), filepath.Join(home, ".local", "state", "herdr-agentweb")),
		SocketPath:     firstNonEmpty(os.Getenv("HERDR_SOCKET_PATH"), filepath.Join(home, ".config", "herdr", "herdr.sock")),
		LaunchProfiles: parseLaunchProfiles(file["launch_profiles"]),
		Orchestrators: parseOrchestrators(file["orchestrators"], file["orchestrator_dir"], home, dataDir(home),
			func(p string) bool { _, err := os.Stat(p); return err == nil }),
	}
}
