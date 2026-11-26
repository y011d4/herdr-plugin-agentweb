package main

// The MCP side, as Claude Code does it: the server from --mcp-config (its headers), its tools
// listed at start (the --permission-prompt-tool one hidden, S0 row 19), calls with a
// progressToken, and an interrupt cancelling a call.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync/atomic"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type headerRT struct{ headers map[string]string }

func (h headerRT) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	for k, v := range h.headers {
		r.Header.Set(k, v)
	}
	return http.DefaultTransport.RoundTrip(r)
}

var progress atomic.Int64

// connectMCP connects to the config's yoicks server; its tool names as Claude Code reports
// them, nil when it couldn't connect.
func (f *fake) connectMCP(configPath, permissionTool string) []string {
	b, err := os.ReadFile(configPath)
	if err != nil {
		return nil
	}
	var cfg struct {
		MCPServers map[string]struct {
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	json.Unmarshal(b, &cfg)
	srv, ok := cfg.MCPServers["yoicks"]
	if !ok {
		return nil
	}
	c := mcp.NewClient(&mcp.Implementation{Name: "fakeclaude", Version: "0"}, &mcp.ClientOptions{
		ProgressNotificationHandler: func(context.Context, *mcp.ProgressNotificationClientRequest) {
			logLine(map[string]any{"progress": progress.Add(1)})
		}})
	cs, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: srv.URL, HTTPClient: &http.Client{Transport: headerRT{srv.Headers}}}, nil)
	if err != nil {
		logLine(map[string]any{"mcp": "connect failed: " + err.Error()})
		return nil
	}
	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		return nil
	}
	f.mcp = cs
	var names []string
	for _, t := range tools.Tools {
		if name := "mcp__yoicks__" + t.Name; name != permissionTool {
			names = append(names, name)
		}
	}
	return names
}

// call calls a yoicks tool for the tool_use id (with a progress token and the id in _meta, as
// Claude Code does); its text, or the error's, and whether it is an error.
func (f *fake) call(ctx context.Context, tool, id string, args map[string]any) (string, bool, error) {
	if f.mcp == nil {
		return "", true, context.Canceled
	}
	params := &mcp.CallToolParams{Name: tool, Arguments: args, Meta: mcp.Meta{"claudecode/toolUseId": id}}
	params.SetProgressToken("fake-" + tool)
	res, err := f.mcp.CallTool(ctx, params)
	if err != nil {
		return "", true, err
	}
	var text []string
	for _, c := range res.Content {
		if t, ok := c.(*mcp.TextContent); ok {
			text = append(text, t.Text)
		}
	}
	return strings.Join(text, "\n"), res.IsError, nil
}

// askMCP: an AskUserQuestion through the permission tool, its decision the tool_result.
func (f *fake) askMCP(ctx context.Context) {
	input := map[string]any{"questions": []any{map[string]any{"question": "Which fruit?", "header": "Fruit", "multiSelect": false,
		"options": []any{map[string]any{"label": "apple", "description": "red"}, map[string]any{"label": "cherry", "description": ""}}}}}
	f.emit(assistant([]any{map[string]any{"type": "tool_use", "id": "toolu_ask", "name": "AskUserQuestion", "input": input}}))
	result, _, err := f.call(ctx, "approve", "toolu_ask", map[string]any{"tool_name": "AskUserQuestion", "input": input, "tool_use_id": "toolu_ask"})
	if err != nil {
		result = "the permission call failed: " + err.Error()
	}
	f.toolResult("toolu_ask", result, false)
}

// toolResult emits a tool_result and writes it to the transcript.
func (f *fake) toolResult(id, text string, isError bool) {
	msg := map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": id, "content": text, "is_error": isError}}}
	f.emit(map[string]any{"type": "user", "message": msg})
	f.record(map[string]any{"type": "user", "message": msg})
}
