package controller

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// /api/agent/bash-sessions 的面板注册表是进程级的，所有接口都必须按
// sessionName 归属过滤：无归属的会话看不到别人的进程，也不能终止它们。
func TestBashSessionsControllerScopesToSession(t *testing.T) {
	server, key := newTestServer(t)

	// 带会话名的列表只返回该会话的进程（空注册表时为空数组）。
	code, env := call(t, server, http.MethodGet, "/api/agent/bash-sessions?sessionName="+url.QueryEscape("sess-a"), key, nil)
	if code != http.StatusOK {
		t.Fatalf("list status = %d (%v)", code, env)
	}
	if data, ok := env["data"].([]any); !ok || len(data) != 0 {
		t.Fatalf("list data = %v", env["data"])
	}

	// 未知进程的日志与终止都必须失败，且不能泄漏其它会话的条目。
	if code, _ := call(t, server, http.MethodGet, "/api/agent/bash-sessions/log?sessionName=sess-a&sessionId=nope", key, nil); code != http.StatusBadRequest {
		t.Fatalf("log status = %d", code)
	}
	if code, _ := call(t, server, http.MethodPost, "/api/agent/bash-sessions/terminate", key,
		map[string]any{"sessionId": "nope", "sessionName": "sess-a"}); code != http.StatusBadRequest {
		t.Fatalf("terminate status = %d", code)
	}

	// 终止「全部」必须带上会话名，否则会跨会话误杀。
	if code, _ := call(t, server, http.MethodPost, "/api/agent/bash-sessions/terminate", key, map[string]any{}); code != http.StatusBadRequest {
		t.Fatalf("unscoped terminate-all status = %d", code)
	}
}

func TestBashSessionsControllerSeparatesSameNamedSessionsAcrossProjects(t *testing.T) {
	home, workspace := t.TempDir(), t.TempDir()
	reg := tools.NewRegistry(tools.BashTools(workspace)...)
	cfg := config.Default()
	cfg.Hitl, cfg.WorkspaceDir = "free", workspace
	model := echo.New("shell-owner",
		echo.Script{ToolCalls: []*genai.FunctionCall{{
			ID: "start", Name: shellenv.Current.Name + "_start",
			Args: map[string]any{"command": "echo owner-probe", "timeout_ms": 100},
		}}},
		echo.Script{Text: "started"},
	)
	a, err := agentpkg.New(home, "project-a", &cfg, agentpkg.Options{Model: model, Toolsets: []tool.Toolset{reg}})
	if err != nil {
		t.Fatal(err)
	}
	ctrl, key, err := New(a, Options{Registry: reg, Home: home})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(ctrl.Handler())
	t.Cleanup(func() { ctrl.Close(); server.Close() })
	other := addProject(t, server, key, t.TempDir())
	hashes := []string{a.App(), other}
	ids := make([]string, len(hashes))
	for i, hash := range hashes {
		owner := tools.SessionOwner{Workspace: hash, Session: "default"}
		t.Cleanup(func() { tools.BashSessionTerminate("", owner) })
		req, _ := http.NewRequest(http.MethodPost, server.URL+"/api/chat/stream",
			strings.NewReader(mustJSON(t, map[string]any{
				"message": "start a shell", "sessionName": "default", "workspaceHash": hash,
			})))
		req.Header.Set("X-Loopra-Key", key)
		resp, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		events := parseSSE(t, readAll(t, resp))
		resp.Body.Close()
		for _, event := range events {
			if event["type"] == "error" {
				t.Fatalf("chat failed: %v", event)
			}
		}
		path := "/api/agent/bash-sessions?workspaceHash=" + hash + "&sessionName=default"
		code, body := call(t, server, http.MethodGet, path, key, nil)
		if code != http.StatusOK {
			t.Fatalf("list %s: %d %v", hash, code, body)
		}
		rows := body["data"].([]any)
		if len(rows) != 1 || rows[0].(map[string]any)["workspaceHash"] != hash {
			t.Fatalf("project %s sees another project's shell: %v", hash, rows)
		}
		ids[i] = rows[0].(map[string]any)["sessionId"].(string)
	}
	if code, _ := call(t, server, http.MethodGet,
		"/api/agent/bash-sessions/log?workspaceHash="+hashes[0]+"&sessionName=default&sessionId="+ids[1], key, nil); code != http.StatusBadRequest {
		t.Fatalf("cross-project log status=%d", code)
	}
	if code, _ := call(t, server, http.MethodPost, "/api/agent/bash-sessions/terminate", key,
		map[string]any{"workspaceHash": hashes[0], "sessionName": "default", "sessionId": ids[1]}); code != http.StatusBadRequest {
		t.Fatalf("cross-project termination status=%d", code)
	}
	call(t, server, http.MethodPost, "/api/agent/bash-sessions/terminate", key,
		map[string]any{"workspaceHash": hashes[0], "sessionName": "default"})
	if _, ok := tools.BashSessionEntry(ids[1], tools.SessionOwner{Workspace: other, Session: "default"}); !ok {
		t.Fatal("terminating project-a also removed project-b's shell")
	}
}
