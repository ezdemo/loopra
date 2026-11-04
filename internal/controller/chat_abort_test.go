package controller

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

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
