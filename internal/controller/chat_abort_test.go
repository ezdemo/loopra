package controller

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"iter"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

type abortStreamingModel struct {
	parts      []*genai.Part
	prior      model.LLM
	priorCalls int
	ready      chan struct{}
	calls      int
	resumed    []*genai.Content
}

func (*abortStreamingModel) Name() string { return "abort-stream" }

func (m *abortStreamingModel) GenerateContent(ctx context.Context, req *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	return func(yield func(*model.LLMResponse, error) bool) {
		m.calls++
		if m.calls <= m.priorCalls {
			m.prior.GenerateContent(ctx, req, stream)(yield)
			return
		}
		if m.calls > m.priorCalls+1 {
			m.resumed = req.Contents
			echo.New("", echo.Script{Text: "继续回复"}).GenerateContent(ctx, req, stream)(yield)
			return
		}
		for _, part := range m.parts {
			if !yield(&model.LLMResponse{
				Content: &genai.Content{Role: genai.RoleModel, Parts: []*genai.Part{part}},
				Partial: true,
			}, nil) {
				return
			}
		}
		close(m.ready)
		<-ctx.Done()
		yield(nil, ctx.Err())
	}
}

func TestAbortPersistsStreamedReplyAndResumesWithIt(t *testing.T) {
	for _, tc := range []struct {
		name  string
		parts []*genai.Part
		prior bool
	}{
		{name: "text_and_reasoning", parts: []*genai.Part{{Text: "正在", Thought: true}, {Text: "分析", Thought: true}, {Text: "已经"}, {Text: "生成的内容"}}},
		{name: "reasoning_only", parts: []*genai.Part{{Text: "只产生思考", Thought: true}}},
		{name: "before_first_token"},
		{name: "after_tool", prior: true, parts: []*genai.Part{{Text: "工具之后的"}, {Text: "部分回复"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			m := &abortStreamingModel{parts: tc.parts, ready: make(chan struct{})}
			probe, err := functiontool.New[struct{}, map[string]any](functiontool.Config{Name: "probe"},
				func(adkagent.Context, struct{}) (map[string]any, error) {
					return map[string]any{"result": "tool done"}, nil
				})
			if err != nil {
				t.Fatal(err)
			}
			if tc.prior {
				m.priorCalls = 2
				m.prior = echo.New("",
					echo.Script{Text: "先前正文一", Thought: "先前思考一",
						ToolCalls: []*genai.FunctionCall{{ID: "probe-1", Name: "probe"}}},
					echo.Script{Text: "先前正文二", Thought: "先前思考二",
						ToolCalls: []*genai.FunctionCall{{ID: "probe-2", Name: "probe"}}})
			}
			cfg := config.Default()
			a, err := agentpkg.New(home, "abort-stream", &cfg, agentpkg.Options{Model: m, Tools: []tool.Tool{probe}})
			if err != nil {
				t.Fatal(err)
			}
			ctrl, key, err := New(a, Options{Home: home})
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(ctrl.Handler())
			t.Cleanup(func() { ctrl.Close(); server.Close() })
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/api/chat/stream",
				strings.NewReader(`{"message":"start","sessionName":"stopped","requestId":"stop-stream"}`))
			req.Header.Set("X-Loopra-Key", key)
			resp, err := server.Client().Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			select {
			case <-m.ready:
			case <-ctx.Done():
				t.Fatal("model did not stream its partial response")
			}
			code, result := call(t, server, http.MethodPost, "/api/chat/abort", key,
				map[string]any{"requestId": "stop-stream", "sessionName": "stopped"})
			if code != http.StatusOK || result["data"].(map[string]any)["matched"] != float64(1) {
				t.Fatalf("abort = %d %v", code, result)
			}
			events := parseSSE(t, readAll(t, resp))
			var streamed string
			for _, ev := range events {
				if ev["type"] == "error" {
					t.Fatalf("stream error: %v", ev)
				}
				if ev["type"] == "content" {
					streamed += ev["content"].(string)
				}
			}
			if !strings.HasSuffix(streamed, userStoppedReply) || strings.Count(streamed, userStoppedReply) != 1 {
				t.Fatalf("streamed reply = %q", streamed)
			}
			code, history := call(t, server, http.MethodGet, "/api/agent/history?sessionName=stopped", key, nil)
			if code != http.StatusOK {
				t.Fatalf("history = %d %v", code, history)
			}
			var stored, storedReasoning string
			var userMessages, toolCalls, toolResults int
			for _, row := range history["data"].([]any) {
				message := row.(map[string]any)
				if text, ok := message["content"].(string); ok {
					stored += text
				}
				if reasoning, ok := message["reasoning_content"].(string); ok {
					storedReasoning += reasoning
				}
				switch message["role"] {
				case "user":
					userMessages++
				case "tool":
					toolResults++
				}
				if calls, ok := message["tool_calls"].([]any); ok {
					toolCalls += len(calls)
				}
			}
			if !strings.HasSuffix(stored, userStoppedReply) || strings.Count(stored, userStoppedReply) != 1 {
				t.Fatalf("stored reply = %q", stored)
			}
			if userMessages != 1 || toolCalls != m.priorCalls || toolResults != m.priorCalls {
				t.Fatalf("incomplete turn: users=%d tool calls=%d results=%d", userMessages, toolCalls, toolResults)
			}
			if tc.prior {
				for _, text := range []string{"先前正文一", "先前正文二"} {
					if strings.Count(stored, text) != 1 {
						t.Fatalf("completed model event was lost or duplicated: %q", stored)
					}
				}
				if storedReasoning != "先前思考一先前思考二" || strings.Count(stored, "tool done") != 2 {
					t.Fatalf("earlier reasoning or tool output was lost: reasoning=%q transcript=%q", storedReasoning, stored)
				}
			}
			log, err := os.ReadFile(ctrl.sessionLogPath("stopped"))
			if err != nil {
				t.Fatal(err)
			}
			audit, err := os.ReadFile(ctrl.sessionEventsPath("stopped"))
			if err != nil || !bytes.Equal(log, audit) {
				t.Fatalf("audit differs from transcript: %v", err)
			}
			fresh := jsonl.NewService(home)
			reloaded, err := fresh.Get(ctx, getReq(a, "stopped"))
			if err != nil {
				t.Fatal(err)
			}
			var text, reasoning string
			for ev := range reloaded.Session.Events().All() {
				text += eventText(ev)
				if ev.Content == nil {
					continue
				}
				for _, part := range ev.Content.Parts {
					if part.Thought {
						reasoning += part.Text
					}
				}
			}
			var wantText, wantReasoning string
			for _, part := range tc.parts {
				if part.Thought {
					wantReasoning += part.Text
				} else {
					wantText += part.Text
				}
			}
			wantStoppedText := wantText
			if wantStoppedText != "" {
				wantStoppedText += "\n\n"
			}
			wantStoppedText += userStoppedReply
			if !strings.Contains(text, wantStoppedText) ||
				!strings.Contains(reasoning, wantReasoning) {
				t.Fatalf("reloaded text=%q reasoning=%q", text, reasoning)
			}
			response := httptest.NewRecorder()
			ctrl.runTurn(ctx, newSSEWriter(response), &chatRequest{SessionName: "stopped", Message: "continue"})
			var resumed string
			for _, content := range m.resumed {
				for _, part := range content.Parts {
					resumed += part.Text
				}
			}
			if !strings.Contains(resumed, wantText) || !strings.Contains(resumed, userStoppedReply) {
				t.Fatalf("next model request lost interrupted reply: %q", resumed)
			}
			if tc.prior {
				for _, text := range []string{"先前正文一", "先前正文二", "先前思考一", "先前思考二"} {
					if strings.Count(resumed, text) != 1 {
						t.Fatalf("next model request lost or duplicated earlier turn content: %q", resumed)
					}
				}
				var resumedCalls, resumedResults int
				for _, content := range m.resumed {
					for _, part := range content.Parts {
						if part.FunctionCall != nil {
							resumedCalls++
						}
						if part.FunctionResponse != nil {
							resumedResults++
						}
					}
				}
				if resumedCalls != 2 || resumedResults != 2 {
					t.Fatalf("next model request lost tool history: calls=%d results=%d", resumedCalls, resumedResults)
				}
			}
		})
	}
}

func TestAbortBeforeAdmissionIsRetained(t *testing.T) {
	server, key, s, _ := parityServer(t, "")
	_, response := call(t, server, http.MethodPost, "/api/chat/abort", key,
		map[string]any{"requestId": "early-stop", "sessionName": "early"})
	if response["data"].(map[string]any)["status"] != "pending" {
		t.Fatalf("abort = %v", response)
	}
	job, err := s.admitChat(&chatRequest{RequestID: "early-stop", SessionName: "early"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.releaseChat(job)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	job.setCancel(cancel)
	if ctx.Err() != context.Canceled {
		t.Fatal("admission lost the earlier cancellation")
	}
	if len(s.state.pendingAborts) != 0 {
		t.Fatal("admission did not consume the pending cancellation")
	}
}

func TestStaleAbortCannotCancelReplacementTurn(t *testing.T) {
	server, key, s, _ := parityServer(t, "")
	job, err := s.admitChat(&chatRequest{RequestID: "current", SessionName: "same"})
	if err != nil {
		t.Fatal(err)
	}
	defer s.releaseChat(job)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	job.setCancel(cancel)
	code, response := call(t, server, http.MethodPost, "/api/chat/abort", key,
		map[string]any{"requestId": "previous", "sessionName": "same"})
	if code != http.StatusConflict || response["reason"] != "chat_run_changed" {
		t.Fatalf("stale abort = %d %v", code, response)
	}
	if ctx.Err() != nil {
		t.Fatal("stale abort cancelled the replacement turn")
	}
}

func TestAbortByRequestIDFindsOtherWorkspace(t *testing.T) {
	server, key, s, _ := parityServer(t, "")
	other := *s
	var err error
	other.agent, err = s.agent.Derive("another-workspace", s.cfg, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	job, err := other.admitChat(&chatRequest{RequestID: "other-workspace-request", SessionName: "other"})
	if err != nil {
		t.Fatal(err)
	}
	defer other.releaseChat(job)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	job.setCancel(cancel)
	code, result := call(t, server, http.MethodPost, "/api/chat/abort", key,
		map[string]any{"requestId": job.ID})
	if code != http.StatusOK || result["data"].(map[string]any)["matched"] != float64(1) || ctx.Err() != context.Canceled {
		t.Fatalf("requestId-only abort missed other workspace: %d %v err=%v", code, result, ctx.Err())
	}
}

type abortOnFlushWriter struct {
	*httptest.ResponseRecorder
	once sync.Once
	stop func()
}

func (w *abortOnFlushWriter) Flush() {
	w.ResponseRecorder.Flush()
	w.once.Do(w.stop)
}

func TestAbortDuringStreamHeaderFlushStopsBeforePreparation(t *testing.T) {
	_, _, s, _ := parityServer(t, "")
	response, stopResponse := httptest.NewRecorder(), httptest.NewRecorder()
	w := &abortOnFlushWriter{ResponseRecorder: response, stop: func() {
		s.abortHandler(stopResponse, httptest.NewRequest(http.MethodPost, "/api/chat/abort",
			strings.NewReader(`{"requestId":"header-race","sessionName":"header-race"}`)))
	}}
	// An invalid channel would fail if turn preparation were reached.
	s.chatStreamHandler(w, httptest.NewRequest(http.MethodPost, "/api/chat/stream",
		strings.NewReader(`{"message":"probe","requestId":"header-race","sessionName":"header-race","modelChannelId":"missing-channel"}`)))
	if !strings.Contains(stopResponse.Body.String(), `"matched":1`) {
		t.Fatalf("stop = %s", stopResponse.Body.String())
	}
	if strings.Contains(response.Body.String(), "event: error") || !strings.Contains(response.Body.String(), "event: done") {
		t.Fatalf("cancelled stream = %s", response.Body.String())
	}
	if s.sessionRunning("header-race") != "" {
		t.Fatal("cancelled stream retained its admission")
	}
}

func TestReleaseWaitsForAbortCleanupAndRejectsLateAbort(t *testing.T) {
	_, _, s, _ := parityServer(t, "")
	job, err := s.admitChat(&chatRequest{RequestID: "old", SessionName: "same"})
	if err != nil {
		t.Fatal(err)
	}
	cleaning, finishCleanup, aborted, released := make(chan struct{}), make(chan struct{}), make(chan struct{}), make(chan struct{})
	job.stop = func() { close(cleaning); <-finishCleanup }
	var finishOnce sync.Once
	unblock := func() { finishOnce.Do(func() { close(finishCleanup) }) }
	defer unblock()
	go func() { job.abort(); close(aborted) }()
	<-cleaning
	go func() { s.releaseChat(job); close(released) }()
	select {
	case <-released:
		t.Fatal("session was released before its process cleanup")
	case <-time.After(30 * time.Millisecond):
	}
	unblock()
	<-aborted
	<-released
	if job.abort() {
		t.Fatal("a finished job accepted a late abort")
	}
	next, err := s.admitChat(&chatRequest{RequestID: "next", SessionName: "same"})
	if err != nil {
		t.Fatal(err)
	}
	s.releaseChat(next)
}

func TestChatAbortStopsExecutingShellAndReleasesSession(t *testing.T) {
	for _, interactive := range []bool{false, true} {
		name := "foreground"
		if interactive {
			name = "interactive"
		}
		t.Run(name, func(t *testing.T) {
			home, workspace := t.TempDir(), t.TempDir()
			reg := tools.NewRegistry(tools.ShellTools(workspace)...)
			command := "sleep 30"
			switch shellenv.Current.Name {
			case "powershell":
				command = "Write-Output 'cancel-ready'; Start-Sleep -Seconds 30"
			case "CMD":
				command = "echo cancel-ready & ping -n 31 127.0.0.1 >NUL"
			default:
				command = "echo cancel-ready; sleep 30"
			}
			toolName := shellenv.Current.Name
			if interactive {
				toolName += "_start"
			}
			model := echo.New("abort-shell", echo.Script{ToolCalls: []*genai.FunctionCall{{
				ID: "long-command", Name: toolName, Args: map[string]any{"command": command, "timeout_ms": 3600000},
			}}}, echo.Script{Text: "finished"})
			cfg := config.Default()
			cfg.WorkspaceDir, cfg.Hitl = workspace, "free"
			a, err := agentpkg.New(home, "abort-project", &cfg, agentpkg.Options{Model: model, Toolsets: []tool.Toolset{reg}})
			if err != nil {
				t.Fatal(err)
			}
			ctrl, key, err := New(a, Options{Home: home, Registry: reg})
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(ctrl.Handler())
			t.Cleanup(func() { ctrl.Close(); server.Close() })
			owner := tools.SessionOwner{Workspace: a.App(), Session: "executing"}
			t.Cleanup(func() { tools.BashSessionTerminate("", owner) })
			request, _ := http.NewRequest(http.MethodPost, server.URL+"/api/chat/stream",
				strings.NewReader(`{"message":"run","sessionName":"executing","requestId":"executing"}`))
			request.Header.Set("X-Loopra-Key", key)
			response, err := server.Client().Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			scanner := bufio.NewScanner(response.Body)
			readUntilEvent(t, scanner, "tool_call")
			if interactive {
				deadline := time.Now().Add(5 * time.Second)
				ready := false
				for time.Now().Before(deadline) {
					for _, row := range tools.BashSessionsSnapshot(owner) {
						entry, _ := tools.BashSessionEntry(row["sessionId"].(string), owner)
						ready = strings.Contains(entry["output"].(string), "cancel-ready")
					}
					if ready {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				if !ready {
					t.Fatal("interactive command did not start executing")
				}
			} else {
				time.Sleep(500 * time.Millisecond)
			}
			started := time.Now()
			code, result := call(t, server, http.MethodPost, "/api/chat/abort", key,
				map[string]any{"requestId": "executing", "sessionName": "executing"})
			if code != http.StatusOK || result["data"].(map[string]any)["matched"] != float64(1) {
				t.Fatalf("abort = %d %v", code, result)
			}
			done := make(chan error, 1)
			go func() {
				for scanner.Scan() {
				}
				done <- scanner.Err()
			}()
			select {
			case err := <-done:
				if err != nil && err != io.EOF {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("chat stream remained blocked after stopping its command")
			}
			deadline := time.Now().Add(time.Second)
			for ctrl.sessionRunning("executing") != "" && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			if ctrl.sessionRunning("executing") != "" || len(tools.BashSessionsSnapshot(owner)) != 0 {
				t.Fatal("stopped command left the session or its background shell running")
			}
			t.Logf("stopped command and released session in %s", time.Since(started))
		})
	}
}
