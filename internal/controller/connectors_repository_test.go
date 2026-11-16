package controller

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/service/connector"
)

func repoTestController(t *testing.T, svc *connector.Service) *Controller {
	t.Helper()
	t.Cleanup(svc.Close)
	s := &Controller{home: t.TempDir(), mcp: &mcpStore{}, connectors: svc}
	s.state = newRuntimeState(s)
	return s
}

func TestRepositoryAuthNoneConnects(t *testing.T) {
	ts := newTokenMcpServer(t, "")
	catalog := connector.Catalog{
		Version:    1,
		Categories: []connector.Category{{ID: "dev", Name: "开发"}},
		Connectors: []connector.Connector{{
			ID: "pub", Name: "公开服务", Category: "dev",
			Transport: connector.Transport{Type: "streamable", URL: ts.URL + "/mcp"},
			Auth:      connector.Auth{Type: "none"},
		}},
	}
	if err := catalog.Validate(); err != nil {
		t.Fatal(err)
	}
	svc := connector.New(catalog, t.TempDir())
	s := repoTestController(t, svc)

	status, resp := callAPI(t, s, http.MethodPost, "/api/connectors/pub/connect", `{"fields":{}}`)
	if status != http.StatusOK || !resp.Success {
		t.Fatalf("connect failed: %d %+v", status, resp)
	}
	if view := svc.View("pub"); !view.Connected || !view.Enabled {
		t.Fatalf("view = %+v", view)
	}
}

func TestRepositoryOptionalDefaultPersisted(t *testing.T) {
	ts := newTokenMcpServer(t, "good-token")
	catalog := connector.Catalog{
		Version:    1,
		Categories: []connector.Category{{ID: "dev", Name: "开发"}},
		Connectors: []connector.Connector{{
			ID: "tok", Name: "令牌服务", Category: "dev",
			Transport: connector.Transport{
				Type:    "streamable",
				URL:     ts.URL + "/mcp?region={{region}}",
				Headers: map[string]string{"Authorization": "Bearer {{token}}"},
			},
			Auth: connector.Auth{Type: "token", Fields: []connector.Field{
				{Key: "token", Secret: true},
				{Key: "region", Optional: true, Default: "cn"},
			}},
		}},
	}
	if err := catalog.Validate(); err != nil {
		t.Fatal(err)
	}
	svc := connector.New(catalog, t.TempDir())
	s := repoTestController(t, svc)

	status, resp := callAPI(t, s, http.MethodPost, "/api/connectors/tok/connect", `{"fields":{"token":"good-token"}}`)
	if status != http.StatusOK || !resp.Success {
		t.Fatalf("connect failed: %d %+v", status, resp)
	}
	view := svc.View("tok")
	if !view.Connected {
		t.Fatal("not persisted")
	}
	found := map[string]bool{}
	for _, key := range view.ConfiguredFields {
		found[key] = true
	}
	if !found["token"] || !found["region"] {
		t.Fatalf("configuredFields = %v", view.ConfiguredFields)
	}
}

func TestRepositoryFailedProbeNoState(t *testing.T) {
	ts := newTokenMcpServer(t, "good-token")
	catalog := connector.Catalog{
		Version:    1,
		Categories: []connector.Category{{ID: "dev", Name: "开发"}},
		Connectors: []connector.Connector{{
			ID: "pub", Name: "公开服务", Category: "dev",
			Transport: connector.Transport{Type: "streamable", URL: ts.URL + "/missing"},
			Auth:      connector.Auth{Type: "none"},
		}},
	}
	if err := catalog.Validate(); err != nil {
		t.Fatal(err)
	}
	svc := connector.New(catalog, t.TempDir())
	s := repoTestController(t, svc)

	callAPI(t, s, http.MethodPost, "/api/connectors/pub/connect", `{"fields":{}}`)
	if view := svc.View("pub"); view.Connected {
		t.Fatal("failed probe must not persist connected state")
	}
}

func TestRepositoryListSafeMetadata(t *testing.T) {
	catalog := connector.Catalog{
		Version:    1,
		Categories: []connector.Category{{ID: "dev", Name: "开发"}},
		Connectors: []connector.Connector{{
			ID: "tok", Name: "令牌服务", Category: "dev", Requires: []string{"node"},
			Methods: []string{"mcp"},
			Transport: connector.Transport{
				Type:    "streamable",
				URL:     "https://x.example/mcp?region={{region}}",
				Headers: map[string]string{"Authorization": "Bearer {{token}}"},
			},
			Auth: connector.Auth{Type: "token", Fields: []connector.Field{
				{Key: "token", Secret: true},
				{Key: "region", Optional: true, Default: "cn", Type: "text"},
			}},
		}},
	}
	if err := catalog.Validate(); err != nil {
		t.Fatal(err)
	}
	svc := connector.New(catalog, t.TempDir())
	s := repoTestController(t, svc)

	status, resp := callAPI(t, s, http.MethodGet, "/api/connectors", "")
	if status != http.StatusOK || !resp.Success {
		t.Fatalf("list failed: %d %+v", status, resp)
	}
	data, _ := resp.Data.(map[string]any)
	list, _ := data["connectors"].([]any)
	if len(list) != 1 {
		t.Fatalf("connectors = %v", list)
	}
	entry, _ := list[0].(map[string]any)
	for _, key := range []string{"transport", "url", "headers", "command", "args", "env", "guide", "kind"} {
		if _, ok := entry[key]; ok {
			t.Fatalf("unsafe key %q exposed", key)
		}
	}
	fields, _ := entry["fields"].([]any)
	seen := map[string]map[string]any{}
	for _, f := range fields {
		fm, _ := f.(map[string]any)
		seen[fm["key"].(string)] = fm
	}
	if seen["region"] == nil || seen["region"]["optional"] != true || seen["region"]["default"] != "cn" {
		t.Fatalf("field metadata = %v", fields)
	}
	reqs, _ := entry["requires"].([]any)
	if len(reqs) != 1 || reqs[0] != "node" {
		t.Fatalf("requires = %v", entry["requires"])
	}
	if _, ok := entry["missingRequirements"]; !ok {
		t.Fatalf("missingRequirements absent: %v", entry)
	}
	if b, _ := json.Marshal(entry); strings.Contains(string(b), "{{token}}") || strings.Contains(string(b), "Bearer ") {
		t.Fatalf("template leaked: %s", b)
	}
}
