package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/testutil"
)

type imageTestContext struct {
	adkagent.Context
	base context.Context
}

func (c imageTestContext) Value(key any) any           { return c.base.Value(key) }
func (c imageTestContext) Err() error                  { return c.base.Err() }
func (c imageTestContext) Done() <-chan struct{}       { return c.base.Done() }
func (c imageTestContext) Deadline() (time.Time, bool) { return c.base.Deadline() }
func (c imageTestContext) FunctionCallID() string      { return "image-call" }
func (c imageTestContext) InvocationID() string        { return "image-turn" }

func imageFixture(t *testing.T, root string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 3, 2))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "fixture.png"), buffer.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func imageConfig() config.Loopra {
	cfg := config.Default()
	cfg.Model = "main"
	cfg.ModelChannels[0].Models = []config.ModelEntry{{Name: "main", ImageInput: true}}
	return cfg
}

func TestReadImageDirectAttachesMediaWithoutTextBase64(t *testing.T) {
	root := t.TempDir()
	data := imageFixture(t, root)
	cfg := imageConfig()
	ctx := imageTestContext{base: WithImageRuntime(t.Context(), &cfg, nil)}
	out, err := runReadImage(ctx, root, readImageInput{Path: "fixture.png", Prompt: "图里有什么文字？"})
	if err != nil || out["mode"] != "direct" || out["width"] != 3 || out["height"] != 2 {
		t.Fatalf("result=%v err=%v", out, err)
	}
	raw, _ := json.Marshal(out)
	if bytes.Contains(raw, []byte(base64.StdEncoding.EncodeToString(data))) {
		t.Fatal("image bytes leaked into tool text")
	}
	event := &session.Event{Content: &genai.Content{Role: genai.RoleUser, Parts: []*genai.Part{{FunctionResponse: &genai.FunctionResponse{ID: "image-call", Name: "read_image", Response: out}}}}}
	AttachImageResults(ctx, event)
	AttachImageResults(ctx, event)
	parts := event.Content.Parts[0].FunctionResponse.Parts
	if len(parts) != 1 || parts[0].InlineData.MIMEType != "image/png" || !bytes.Equal(parts[0].InlineData.Data, data) {
		t.Fatalf("media=%v", parts)
	}
}

func TestReadImageUsesConfiguredVisionChannelAndQuestion(t *testing.T) {
	root := t.TempDir()
	data := imageFixture(t, root)
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer vision-key" {
			t.Error("wrong channel credentials")
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"图片上的文字是 Loopra"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()
	cfg := imageConfig()
	cfg.ModelChannels[0].Models[0].ImageInput = false
	cfg.ImageUnderstandingModel, cfg.ImageUnderstandingModelChannelID = "vision", "pictures"
	cfg.ModelChannels = append(cfg.ModelChannels, config.Channel{ID: "pictures", BaseURL: server.URL, APIKey: "vision-key", Models: []config.ModelEntry{{Name: "vision", ImageInput: true}}})
	ctx := imageTestContext{base: WithImageRuntime(t.Context(), &cfg, server.Client())}
	out, err := runReadImage(ctx, root, readImageInput{Path: "fixture.png", Prompt: "只读出标题"})
	if err != nil || out["mode"] != "vision_model" || out["result"] != "图片上的文字是 Loopra" {
		t.Fatalf("result=%v err=%v", out, err)
	}
	if body["model"] != "vision" || body["tools"] != nil {
		t.Fatalf("vision request=%v", body)
	}
	raw, _ := json.Marshal(body)
	for _, want := range []string{"只读出标题", "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("missing %q", want)
		}
	}
	runtime := ctx.Value(imageRuntimeKey{}).(*imageRuntime)
	if len(runtime.pending) != 0 {
		t.Fatal("fallback added an image to text-only main model")
	}
}

func TestReadImageRejectsInvalidInputsAndMissingVisionModel(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	imageFixture(t, root)
	imageFixture(t, outside)
	if err := os.WriteFile(filepath.Join(root, "bad.png"), []byte("not an image"), 0o600); err != nil {
		t.Fatal(err)
	}
	testutil.DirectoryLink(t, filepath.Join(root, "escape"), outside)
	file, err := os.Create(filepath.Join(root, "large.png"))
	if err != nil {
		t.Fatal(err)
	}
	err = file.Truncate(maxReadImageBytes + 1)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	cfg := imageConfig()
	ctx := imageTestContext{base: WithImageRuntime(t.Context(), &cfg, nil)}
	for _, path := range []string{"bad.png", "missing.png", "large.png", ".", "../fixture.png", "escape/fixture.png", filepath.Join(outside, "fixture.png")} {
		if _, err := runReadImage(ctx, root, readImageInput{Path: path}); err == nil {
			t.Fatalf("accepted %q", path)
		}
	}
	cfg.ModelChannels[0].Models[0].ImageInput = false
	for _, name := range []string{"", "missing", "main"} {
		cfg.ImageUnderstandingModel = name
		ctx.base = WithImageRuntime(t.Context(), &cfg, nil)
		if _, err := runReadImage(ctx, root, readImageInput{Path: "fixture.png"}); err == nil || !strings.Contains(err.Error(), "图片理解模型") {
			t.Fatalf("missing capability=%v", err)
		}
	}
	ctx.base = WithLinkedProjects(WithImageRuntime(t.Context(), func() *config.Loopra { c := imageConfig(); return &c }(), nil), []string{outside})
	if _, err := runReadImage(ctx, root, readImageInput{Path: filepath.Join(outside, "fixture.png")}); err != nil {
		t.Fatalf("linked project rejected: %v", err)
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	ctx.base = canceled
	if _, err := runReadImage(ctx, root, readImageInput{Path: "fixture.png"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel=%v", err)
	}
}
