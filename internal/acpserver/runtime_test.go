package acpserver

import (
	"context"
	"io"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/adk/model/echo"
	modelconfig "github.com/ezdemo/looprax/internal/model/config"
)

type recordingClient struct {
	texts []string
}

func (c *recordingClient) RequestPermission(context.Context, acpsdk.RequestPermissionRequest) (acpsdk.RequestPermissionResponse, error) {
	return acpsdk.RequestPermissionResponse{Outcome: acpsdk.RequestPermissionOutcome{
		Cancelled: &acpsdk.RequestPermissionOutcomeCancelled{Outcome: "cancelled"},
	}}, nil
}

func (c *recordingClient) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
	if chunk := params.Update.AgentMessageChunk; chunk != nil && chunk.Content.Text != nil {
		c.texts = append(c.texts, chunk.Content.Text.Text)
	}
	return nil
}

func (c *recordingClient) ReadTextFile(context.Context, acpsdk.ReadTextFileRequest) (acpsdk.ReadTextFileResponse, error) {
	return acpsdk.ReadTextFileResponse{}, nil
}
func (c *recordingClient) WriteTextFile(context.Context, acpsdk.WriteTextFileRequest) (acpsdk.WriteTextFileResponse, error) {
	return acpsdk.WriteTextFileResponse{}, nil
}
func (c *recordingClient) CreateTerminal(context.Context, acpsdk.CreateTerminalRequest) (acpsdk.CreateTerminalResponse, error) {
	return acpsdk.CreateTerminalResponse{}, nil
}
func (c *recordingClient) KillTerminal(context.Context, acpsdk.KillTerminalRequest) (acpsdk.KillTerminalResponse, error) {
	return acpsdk.KillTerminalResponse{}, nil
}
func (c *recordingClient) TerminalOutput(context.Context, acpsdk.TerminalOutputRequest) (acpsdk.TerminalOutputResponse, error) {
	return acpsdk.TerminalOutputResponse{}, nil
}
func (c *recordingClient) ReleaseTerminal(context.Context, acpsdk.ReleaseTerminalRequest) (acpsdk.ReleaseTerminalResponse, error) {
	return acpsdk.ReleaseTerminalResponse{}, nil
}
func (c *recordingClient) WaitForTerminalExit(context.Context, acpsdk.WaitForTerminalExitRequest) (acpsdk.WaitForTerminalExitResponse, error) {
	return acpsdk.WaitForTerminalExitResponse{}, nil
}

func TestRuntimeSpeaksACP(t *testing.T) {
	clientRead, agentWrite := io.Pipe()
	agentRead, clientWrite := io.Pipe()
	cfg := modelconfig.Default()
	cfg.Hitl = "free"
	runtime := New(t.TempDir(), &cfg)
	runtime.UseModel(echo.New("echo", echo.Script{Text: "pong"}))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = ServeStreams(ctx, runtime, agentWrite, agentRead) }()

	peer := &recordingClient{}
	conn := acpsdk.NewClientSideConnection(peer, clientWrite, clientRead)
	callCtx, callCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer callCancel()
	initialized, err := conn.Initialize(callCtx, acpsdk.InitializeRequest{
		ProtocolVersion: acpsdk.ProtocolVersionNumber,
		ClientInfo:      &acpsdk.Implementation{Name: "test", Version: "0"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !initialized.AgentCapabilities.McpCapabilities.Http {
		t.Fatal("LoopraX should accept HTTP MCP servers")
	}
	if initialized.AgentCapabilities.SessionCapabilities.Fork == nil {
		t.Fatal("LoopraX should advertise session/fork")
	}
	created, err := conn.NewSession(callCtx, acpsdk.NewSessionRequest{
		Cwd: t.TempDir(), McpServers: []acpsdk.McpServer{},
	})
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, option := range created.ConfigOptions {
		if option.Select != nil {
			ids[string(option.Select.Id)] = true
		}
	}
	for _, id := range []string{"model", "mode", "effort", "fast", "plan"} {
		if !ids[id] {
			t.Fatalf("config option %s missing from %#v", id, created.ConfigOptions)
		}
	}
	result, err := conn.Prompt(callCtx, acpsdk.PromptRequest{
		SessionId: created.SessionId,
		Prompt:    []acpsdk.ContentBlock{acpsdk.TextBlock("ping")},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.StopReason != acpsdk.StopReasonEndTurn {
		t.Fatalf("stop = %q", result.StopReason)
	}
	joined := ""
	for _, text := range peer.texts {
		joined += text
	}
	if joined == "" {
		t.Fatal("agent produced no text")
	}
}
