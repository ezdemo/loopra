package agent

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"iter"
	"os"
	"path/filepath"
	"testing"

	"google.golang.org/adk/v2/model"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/service/tools"
)

type imageRecordingModel struct {
	delegate model.LLM
	requests []*model.LLMRequest
}

func (m *imageRecordingModel) Name() string { return m.delegate.Name() }
func (m *imageRecordingModel) GenerateContent(ctx context.Context, request *model.LLMRequest, stream bool) iter.Seq2[*model.LLMResponse, error] {
	copy, err := cloneRequest(request)
	if err != nil {
		return func(yield func(*model.LLMResponse, error) bool) { yield(nil, err) }
	}
	m.requests = append(m.requests, copy)
	return m.delegate.GenerateContent(ctx, request, stream)
}

func TestReadImageReachesNextModelRequestAndSurvivesRestart(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	var imageData bytes.Buffer
	if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 2, 3))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "screen.png"), imageData.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.Model = "visual"
	cfg.ModelChannels[0].Models = []config.ModelEntry{{Name: "visual", ImageInput: true}}
	registry := tools.NewRegistry(tools.FileTools(root)...)
	m := &imageRecordingModel{delegate: echo.New("visual", echo.Script{ToolCalls: []*genai.FunctionCall{{ID: "screen", Name: "read_image", Args: map[string]any{"path": "screen.png", "prompt": "描述布局"}}}}, echo.Script{Text: "image understood"})}
	a, err := New(home, "project", &cfg, Options{Model: m, Toolsets: []tool.Toolset{registry}})
	if err != nil {
		t.Fatal(err)
	}
	sess := createSession(t, a, "image").Session
	for _, err := range a.Run(t.Context(), sess, genai.NewContentFromText("look at screen", genai.RoleUser)) {
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(m.requests) != 2 {
		t.Fatalf("requests=%d", len(m.requests))
	}
	assertImage := func(request *model.LLMRequest) {
		t.Helper()
		for _, content := range request.Contents {
			for _, part := range content.Parts {
				if part.FunctionResponse != nil && part.FunctionResponse.Name == "read_image" {
					parts := part.FunctionResponse.Parts
					if len(parts) != 1 || parts[0].InlineData == nil || !bytes.Equal(parts[0].InlineData.Data, imageData.Bytes()) {
						t.Fatalf("missing image in model context: %+v", part.FunctionResponse)
					}
					return
				}
			}
		}
		t.Fatal("read_image result missing from model request")
	}
	assertImage(m.requests[1])
	if got := contentChars(m.requests[1].Contents); got > 10000 {
		t.Fatalf("counted media bytes as context text: %d", got)
	}
	restarted := &imageRecordingModel{delegate: echo.New("visual", echo.Script{Text: "continued"})}
	a, err = New(home, "project", &cfg, Options{Model: restarted, Sessions: jsonl.NewService(home)})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := a.Sessions.Get(t.Context(), &session.GetRequest{AppName: a.App(), UserID: a.User(), SessionID: "image"})
	if err != nil {
		t.Fatal(err)
	}
	for _, err := range a.Run(t.Context(), loaded.Session, genai.NewContentFromText("continue", genai.RoleUser)) {
		if err != nil {
			t.Fatal(err)
		}
	}
	assertImage(restarted.requests[0])
}
