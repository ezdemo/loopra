package controller

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

func TestChatCompactCommandContract(t *testing.T) {
	for _, history := range []bool{true, false} {
		t.Run(fmt.Sprint("history=", history), func(t *testing.T) {
			cfg := config.Default()
			cfg.ContextCompaction.RetainEvents = 2
			home := t.TempDir()
			a, err := agentpkg.New(home, "compact", &cfg, agentpkg.Options{
				Model: echo.New("compact-test", echo.Script{Text: "Checkpoint: preserve exact evidence."}),
			})
			if err != nil {
				t.Fatal(err)
			}
			sess, err := a.Session(t.Context(), "manual")
			if err != nil {
				t.Fatal(err)
			}
			if history {
				for i := range 6 {
					event := &session.Event{
						ID: fmt.Sprintf("history-%d", i), Author: "user",
						InvocationID: fmt.Sprintf("turn-%d", i),
						Timestamp:    time.Now().Add(time.Duration(i-6) * time.Second),
					}
					event.Content = genai.NewContentFromText(strings.Repeat("exact evidence ", 50), genai.RoleUser)
					if err := a.Sessions.AppendEvent(t.Context(), sess, event); err != nil {
						t.Fatal(err)
					}
				}
			}
			ctrl, key, err := New(a, Options{Home: home})
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(ctrl.Handler())
			t.Cleanup(func() { ctrl.Close(); server.Close() })
			req, err := http.NewRequest(http.MethodPost, server.URL+"/api/chat/stream",
				strings.NewReader(`{"message":"/compact","sessionName":"manual"}`))
			if err != nil {
				t.Fatal(err)
			}
			req.Header.Set("X-Loopra-Key", key)
			resp, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			events := parseSSE(t, readAll(t, resp))
			types := eventTypes(events)
			if resp.StatusCode != http.StatusOK || len(types) < 3 || types[0] != "snapshot" || types[len(types)-1] != "done" {
				t.Fatalf("status=%d events=%v", resp.StatusCode, events)
			}
			complete := ""
			for _, event := range events {
				switch event["type"] {
				case "error", "tool_call", "tool_result":
					t.Fatalf("unexpected event: %v", event)
				case "complete":
					complete, _ = event["content"].(string)
				}
			}
			wantReply := "没有可压缩"
			if history {
				wantReply = "上下文已压缩"
			}
			if !strings.Contains(complete, wantReply) {
				t.Fatalf("complete=%q", complete)
			}
			current, err := a.Sessions.Get(t.Context(), &session.GetRequest{
				AppName: a.App(), UserID: a.User(), SessionID: "manual",
			})
			if err != nil {
				t.Fatal(err)
			}
			checkpoints := 0
			for event := range current.Session.Events().All() {
				if event.Actions.Compaction != nil {
					checkpoints++
				}
			}
			if history && checkpoints != 1 || !history && checkpoints != 0 {
				t.Fatalf("persisted checkpoints=%d", checkpoints)
			}
			messages := ctrl.sessionMessages(t.Context(), "manual")
			if len(messages) < 2 || messages[len(messages)-1]["content"] != complete {
				t.Fatalf("command reply did not survive history reload: %v", messages)
			}
		})
	}
}
