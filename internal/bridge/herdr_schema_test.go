package bridge

// What the bridge sends to herdr and reads back, against herdr's own API schema
// (`herdr api schema --json`). testdata/herdr-schema/protocol-22.json is herdr
// 0.9.5's. To check another herdr, save its schema there and point schemaFile at it:
// a missing method, parameter, field or event is what would break with it.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

var schemaFile = filepath.Join("..", "..", "testdata", "herdr-schema", "protocol-22.json")

type jsonSchema = map[string]any

func loadHerdrSchema(t *testing.T) jsonSchema {
	t.Helper()
	b, err := os.ReadFile(schemaFile)
	if err != nil {
		t.Fatal(err)
	}
	var s jsonSchema
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

// schemaDef is schemas.<section>.$defs.<name>, or what a "#/schemas/…" ref points at.
func schemaDef(t *testing.T, s jsonSchema, section, name string) jsonSchema {
	t.Helper()
	d, _ := dig(s, "schemas", section, "$defs", name).(jsonSchema)
	if d == nil {
		t.Fatalf("schema has no %s.%s", section, name)
	}
	return d
}

func dig(v any, path ...string) any {
	for _, p := range path {
		m, _ := v.(jsonSchema)
		v = m[p]
	}
	return v
}

func resolveRef(t *testing.T, s jsonSchema, d jsonSchema) jsonSchema {
	t.Helper()
	ref, _ := d["$ref"].(string)
	if ref == "" {
		return d
	}
	parts := strings.Split(strings.TrimPrefix(ref, "#/schemas/"), "/") // section, $defs, name
	return schemaDef(t, s, parts[0], parts[2])
}

func properties(d jsonSchema) jsonSchema {
	p, _ := d["properties"].(jsonSchema)
	return p
}

// oneOfByConst is the oneOf variant whose property key is the constant value.
func oneOfByConst(d jsonSchema, key, value string) jsonSchema {
	variants, _ := d["oneOf"].([]any)
	for _, v := range variants {
		if vm, _ := v.(jsonSchema); dig(vm, "properties", key, "const") == value {
			return vm
		}
	}
	return nil
}

// jsonFields is a struct type's JSON field names.
func jsonFields(t reflect.Type) []string {
	var out []string
	for i := range t.NumField() {
		if name, _, _ := strings.Cut(t.Field(i).Tag.Get("json"), ","); name != "" && name != "-" {
			out = append(out, name)
		}
	}
	return out
}

// notInProtocol22 are fields the bridge reads (ported from the TypeScript) that
// herdr 0.9.5 doesn't send: absent, they leave their part of the state empty.
var notInProtocol22 = []string{"custom_status", "agent_message"}

func checkFields(t *testing.T, what string, fields []string, d jsonSchema) {
	t.Helper()
	props := properties(d)
	for _, f := range fields {
		if _, ok := props[f]; !ok && !slices.Contains(notInProtocol22, f) {
			t.Errorf("%s reads %q, which the schema doesn't have", what, f)
		}
	}
}

// The answers the bridge decodes into structs.
func TestHerdrSchemaResponseFields(t *testing.T) {
	s := loadHerdrSchema(t)
	for _, c := range []struct {
		goType reflect.Type
		def    string // in success_response
	}{
		{reflect.TypeFor[RawSnapshot](), "SessionSnapshot"},
		{reflect.TypeFor[RawWorkspace](), "WorkspaceInfo"},
		{reflect.TypeFor[RawWorktree](), "WorkspaceWorktreeInfo"},
		{reflect.TypeFor[RawTab](), "TabInfo"},
		{reflect.TypeFor[RawPane](), "PaneInfo"},
		{reflect.TypeFor[RawAgentSession](), "AgentSessionInfo"},
		{reflect.TypeFor[RawAgentSeqs](), "AgentInfo"},
		{reflect.TypeFor[OverviewAgent](), "AgentInfo"},
		{reflect.TypeFor[OverviewSnapshot](), "SessionSnapshot"},
		{reflect.TypeFor[rawPaneInfo](), "PaneInfo"},
		{reflect.TypeFor[rawPaneInfo]().Field(1).Type.Elem(), "PaneScrollInfo"}, // Scroll
	} {
		checkFields(t, c.goType.String(), jsonFields(c.goType), schemaDef(t, s, "success_response", c.def))
	}
	// pane.process_info's answer is decoded into anonymous structs (account.go,
	// http.go claudeConfigRoots)
	checkFields(t, "pane.process_info", []string{"foreground_process_group_id", "shell_pid", "foreground_processes"},
		schemaDef(t, s, "success_response", "PaneProcessInfo"))
	checkFields(t, "pane.process_info process", []string{"pid", "name", "argv"},
		schemaDef(t, s, "success_response", "PaneProcessInfoProcess"))
}

// Every request the bridge and CLI send (testdata/wire holds them all, per
// operation, but events.subscribe and status's ping): the method exists and takes
// each parameter.
func TestHerdrSchemaRequests(t *testing.T) {
	s := loadHerdrSchema(t)
	request, _ := dig(s, "schemas", "request").(jsonSchema)
	files, err := filepath.Glob(filepath.Join("..", "..", "testdata", "wire", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatal("no wire recordings", err)
	}
	type call struct {
		Method string         `json:"method"`
		Params map[string]any `json:"params"`
	}
	calls := []call{{Method: "ping", Params: map[string]any{}}}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var rec struct {
			Herdr []call `json:"herdr"`
		}
		if err := json.Unmarshal(b, &rec); err != nil {
			t.Fatal(f, err)
		}
		calls = append(calls, rec.Herdr...)
	}
	for _, c := range calls {
		variant := oneOfByConst(request, "method", c.Method)
		if variant == nil {
			t.Errorf("method %s isn't in the schema", c.Method)
			continue
		}
		params := resolveRef(t, s, dig(variant, "properties", "params").(jsonSchema))
		for k := range c.Params {
			if _, ok := properties(params)[k]; !ok {
				t.Errorf("%s: parameter %q isn't in the schema", c.Method, k)
			}
		}
	}
}

// events.subscribe: each subscription type exists and takes its fields.
func TestHerdrSchemaSubscriptions(t *testing.T) {
	s := loadHerdrSchema(t)
	sub := schemaDef(t, s, "request", "Subscription")
	for _, want := range buildSubscriptions([]string{"p1"}) {
		variant := oneOfByConst(sub, "type", want["type"])
		if variant == nil {
			t.Errorf("subscription %s isn't in the schema", want["type"])
			continue
		}
		for k := range want {
			if _, ok := properties(variant)[k]; !ok {
				t.Errorf("subscription %s: field %q isn't in the schema", want["type"], k)
			}
		}
	}
}

// The event data fields applyEvent (state.go) and the client read; keep in step
// with them.
func TestHerdrSchemaEventFields(t *testing.T) {
	s := loadHerdrSchema(t)
	checkFields(t, "pane.agent_status_changed",
		[]string{"pane_id", "agent_status", "agent", "display_agent", "custom_status", "title"},
		schemaDef(t, s, "subscription_event", "PaneAgentStatusChangedEvent"))
	data := schemaDef(t, s, "event", "EventData")
	for event, fields := range map[string][]string{
		"workspace_focused": {"workspace_id"},
		"tab_focused":       {"tab_id"},
		"pane_focused":      {"pane_id"},
		"workspace_renamed": {"workspace_id", "label"},
		"tab_renamed":       {"tab_id", "label"},
	} {
		variant := oneOfByConst(data, "type", event)
		if variant == nil {
			t.Errorf("event %s isn't in the schema", event)
			continue
		}
		checkFields(t, event, fields, variant)
	}
}

// The requests a headless orchestrator's tools and wake-ups send (mcp.go, http.go), and the
// bridge closing a finished worker's pane (worker_exit.go), which no wire recording has: each
// method takes each parameter, agent.prompt's wait its until, and the statuses they wait for
// are herdr's.
func TestHerdrSchemaHeadlessRequests(t *testing.T) {
	s := loadHerdrSchema(t)
	request, _ := dig(s, "schemas", "request").(jsonSchema)
	for method, params := range map[string][]string{
		"agent.get":         {"target"},
		"agent.read":        {"target", "source", "lines"},
		"agent.prompt":      {"target", "text", "wait"},
		"agent.wait":        {"target", "until", "timeout_ms"},
		"notification.show": {"title", "body", "sound"},
		"workspace.get":     {"workspace_id"},
	} {
		variant := oneOfByConst(request, "method", method)
		if variant == nil {
			t.Errorf("method %s isn't in the schema", method)
			continue
		}
		checkFields(t, method, params, resolveRef(t, s, dig(variant, "properties", "params").(jsonSchema)))
	}
	checkFields(t, "agent.prompt wait", []string{"until"}, schemaDef(t, s, "request", "AgentPromptWaitOptions"))
	statuses, _ := schemaDef(t, s, "request", "AgentStatus")["enum"].([]any)
	for _, st := range slices.Concat(untilSettled, untilMoved) {
		if !slices.Contains(statuses, any(st)) {
			t.Errorf("status %s isn't herdr's", st)
		}
	}
	sounds, _ := schemaDef(t, s, "request", "NotificationShowSound")["enum"].([]any)
	for _, sound := range []string{"done", "request"} {
		if !slices.Contains(sounds, any(sound)) {
			t.Errorf("sound %s isn't herdr's", sound)
		}
	}
	// the answers they read
	checkFields(t, "agent.get/agent.wait agent", []string{"agent_status", "state_change_seq", "cwd", "pane_id"},
		schemaDef(t, s, "success_response", "AgentInfo"))
	checkFields(t, "workspace.get workspace", []string{"pane_count", "worktree"}, schemaDef(t, s, "success_response", "WorkspaceInfo"))
}
