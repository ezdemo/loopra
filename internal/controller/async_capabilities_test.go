package controller

import (
	"context"
	"iter"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/plugin"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// The operation cannot complete until the parent model sees the running receipt.
// Separate scripts keep parent and child scheduling independent.
type asyncCapabilityModel struct {
	parent, child             model.LLM
	release                   chan struct{}
	once                      sync.Once
	sawPending, sawCompletion atomic.Bool
}

func (m *asyncCapabilityModel) Name() string { return "async-capability" }
func (m *asyncCapabilityModel) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		if _, parent := req.Tools["sub_agent"]; !parent && m.child != nil {
			select {
			case <-m.release:
			case <-ctx.Done():
				yield(nil, ctx.Err())
				return
			}
			m.child.GenerateContent(ctx, req, stream)(yield)
			return
		}
		for _, content := range req.Contents {
			for _, part := range content.Parts {
				if part.FunctionResponse != nil && tools.IsAsyncPlaceholder("async-call", part.FunctionResponse.Response) {
					m.sawPending.Store(true)
					m.once.Do(func() { close(m.release) })
				}
				if strings.Contains(part.Text, "Tool completion notification") {
					m.sawCompletion.Store(true)
				}
			}
		}
		m.parent.GenerateContent(ctx, req, stream)(yield)
	}
}

func TestAsyncDeclaredWebAndSubAgent(t *testing.T) {
	for _, name := range []string{"web", "sub_agent"} {
		t.Run(name, func(t *testing.T) {
			home, workspace := t.TempDir(), t.TempDir()
			reg := tools.NewRegistry(tools.FileTools(workspace)...)
			m := &asyncCapabilityModel{release: make(chan struct{})}
			args := map[string]any{"yield_after_ms": 1}
			if name == "sub_agent" {
				args["name"], args["profile"], args["task"] = "worker", "implement", "write a file"
				m.child = echo.New("child", echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "child-write", Name: "write", Args: map[string]any{"path": "async.txt", "content": "written after yield"}}}}, echo.Script{Text: "child finished"})
			} else {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					select {
					case <-m.release:
					case <-r.Context().Done():
						return
					}
					w.Header().Set("Content-Type", "text/plain")
					_, _ = w.Write([]byte("web evidence"))
				}))
				defer server.Close()
				defer m.once.Do(func() { close(m.release) })
				args["action"], args["url"], args["format"] = "fetch", server.URL, "text"
				host := plugin.New(t.TempDir(), plugin.Hooks{})
				if _, err := host.Install(t.Context(), filepath.Join("..", "..", "plugins", "web")); err != nil {
					t.Fatal(err)
				}
				ctrl := &Controller{}
				for _, entry := range ctrl.materializePluginTools(host.Bound()) {
					reg.Add(entry)
				}
			}
			m.parent = echo.New("parent", echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "async-call", Name: name, Args: args}}}, echo.Script{Text: "waiting"}, echo.Script{Text: "finished"})
			cfg := config.Default()
			cfg.Hitl, cfg.WorkspaceDir = "free", workspace
			a, err := agentpkg.New(home, "async-capability", &cfg, agentpkg.Options{Model: m, Toolsets: []tool.Toolset{reg}})
			if err != nil {
				t.Fatal(err)
			}
			ctrl, key, err := New(a, Options{Registry: reg, Home: home})
			if err != nil {
				t.Fatal(err)
			}
			defer ctrl.Close()
			server := httptest.NewServer(ctrl.Handler())
			defer server.Close()
			defer m.once.Do(func() { close(m.release) })
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/api/chat/stream", strings.NewReader(`{"message":"run","sessionName":"parent"}`))
			req.Header.Set("X-Loopra-Key", key)
			resp, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			events := parseSSE(t, readAll(t, resp))
			results, liveChanges := 0, 0
			for _, event := range events {
				if event["type"] == "error" {
					t.Fatalf("stream error: %v", event)
				}
				if event["type"] == "tool_result" && event["toolCallId"] == "async-call" {
					results++
					if event["status"] != "completed" {
						t.Fatalf("result = %v", event)
					}
				}
				if event["type"] == "file_changes" {
					liveChanges += len(decodeFileChanges(t, event["changes"]))
				}
			}
			if !m.sawPending.Load() || !m.sawCompletion.Load() || results != 1 {
				t.Fatalf("pending=%v completion=%v results=%d", m.sawPending.Load(), m.sawCompletion.Load(), results)
			}
			if name == "sub_agent" {
				replayed := 0
				for _, row := range ctrl.sessionMessages(t.Context(), "parent") {
					if row["file_changes"] != nil {
						replayed += len(decodeFileChanges(t, row["file_changes"]))
					}
				}
				if liveChanges != 1 || replayed != 1 {
					t.Fatalf("file changes live=%d replay=%d", liveChanges, replayed)
				}
			}
		})
	}
}
