package bridge

// A port of server/notify.ts: the WS agent_status message and the optional ntfy POST.

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

var ntfyErrorLogged atomic.Bool

// Node's fetch (undici) gives up waiting for response headers after 300 s.
var ntfyClient = &http.Client{Timeout: 300 * time.Second}

// buildAgentStatusMessage is the WS agent_status message for a status transition.
func buildAgentStatusMessage(change StatusChange, state *State) WsAgentStatusMessage {
	var workspaceLabel, tabLabel *string
outer:
	for _, ws := range state.Workspaces {
		for _, tab := range ws.Tabs {
			for _, pane := range tab.Panes {
				if pane.PaneID == change.PaneID {
					workspaceLabel, tabLabel = new(ws.Label), new(tab.Label)
					break outer
				}
			}
		}
	}
	// contract: agent is the display string, not the internal agent object
	var agent *string
	if a := change.Agent; a != nil {
		agent = a.DisplayName
		if agent == nil {
			agent = a.Name
		}
	}
	return WsAgentStatusMessage{
		Type:           "agent_status",
		PaneID:         change.PaneID,
		Agent:          agent,
		From:           change.From,
		To:             change.To,
		WorkspaceLabel: workspaceLabel,
		TabLabel:       tabLabel,
	}
}

// sendNtfyNotification posts an ntfy-style notification if notifyURL is set, for a
// change to blocked or done. Failures are logged once (until a success) and never
// crash the server. It waits for the POST, so run it in a goroutine (main.ts doesn't
// await it either).
func sendNtfyNotification(change StatusChange, state *State, notifyURL *string) {
	if notifyURL == nil || *notifyURL == "" {
		return
	}
	if change.To != "blocked" && change.To != "done" {
		return
	}

	msg := buildAgentStatusMessage(change, state)
	rawName := "agent"
	if a := change.Agent; a != nil && a.DisplayName != nil && *a.DisplayName != "" {
		rawName = *a.DisplayName
	} else if a != nil && a.Name != nil && *a.Name != "" {
		rawName = *a.Name
	}
	// HTTP header values must be ISO-8859-1: replace what isn't printable ASCII, one
	// ? per UTF-16 unit like the TypeScript regexp (an emoji is two).
	var agentName strings.Builder
	for _, r := range rawName {
		switch {
		case r >= 0x20 && r <= 0x7e:
			agentName.WriteRune(r)
		case r >= 0x10000:
			agentName.WriteString("??")
		default:
			agentName.WriteByte('?')
		}
	}
	title := agentName.String() + " -> " + change.To
	body := "pane " + change.PaneID
	if wl := msg.WorkspaceLabel; wl != nil && *wl != "" { // then TabLabel is set too
		label := *wl
		if *msg.TabLabel != "" {
			label += "/" + *msg.TabLabel
		}
		body = label + " · " + body
	}
	postNtfy(*notifyURL, title, body)
}

// postNtfy posts one notification (title: printable ASCII). Failures are logged once
// (until a success); it waits for the POST, so run it in a goroutine.
func postNtfy(notifyURL, title, body string) {
	err := func() error {
		req, err := http.NewRequest("POST", notifyURL, strings.NewReader(body))
		if err != nil {
			return err
		}
		req.Header.Set("Title", title)
		req.Header.Set("Content-Type", "text/plain")
		res, err := ntfyClient.Do(req)
		if err != nil {
			return err
		}
		res.Body.Close()
		// an HTTP 4xx/5xx from ntfy is no transport error, so check the status or a
		// broken notify_url would look healthy
		if res.StatusCode < 200 || res.StatusCode > 299 {
			return fmt.Errorf("ntfy responded %d", res.StatusCode)
		}
		return nil
	}()
	if err == nil {
		ntfyErrorLogged.Store(false)
		return
	}
	// like fetch's message, leave the URL out: an ntfy topic in it is a secret
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	if !ntfyErrorLogged.Swap(true) {
		logf("[notify] ntfy POST failed: %s", err)
	}
}
