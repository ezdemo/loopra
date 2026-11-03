package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/infrastructure/filediff"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func TestNativeFileChangesStreamPersistAndRevert(t *testing.T) {
	home, workspace := t.TempDir(), t.TempDir()
	original := "old\r\ntext\r\n"
	if err := os.WriteFile(filepath.Join(workspace, "existing.txt"), []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	calls := []*genai.FunctionCall{
		{ID: "create", Name: "write", Args: map[string]any{"path": "nested/new.txt", "content": "a\nb"}},
		{ID: "edit", Name: "edit", Args: map[string]any{"path": "nested/new.txt", "edits": []any{map[string]any{"old": "b", "new": "B"}}}},
		{ID: "overwrite", Name: "write", Args: map[string]any{"path": "existing.txt", "content": "new\r\ntext\r\n"}},
		{ID: "noop", Name: "write", Args: map[string]any{"path": "existing.txt", "content": "new\r\ntext\r\n"}},
		{ID: "failed", Name: "edit", Args: map[string]any{"path": "existing.txt", "edits": []any{map[string]any{"old": "missing", "new": "replacement"}}}},
		{ID: "empty", Name: "write", Args: map[string]any{"path": "empty.txt", "content": ""}},
	}
	var scripts []echo.Script
	for _, call := range calls {
		scripts = append(scripts, echo.Script{ToolCalls: []*genai.FunctionCall{call}})
	}
	scripts = append(scripts, echo.Script{Text: "done"})
	var nativeTools []tool.Tool
	for _, entry := range tools.FileTools(workspace) {
		nativeTools = append(nativeTools, entry.Tool)
	}
	cfg := config.Default()
	cfg.WorkspaceDir = workspace
	a, err := agentpkg.New(home, "native-files", &cfg, agentpkg.Options{
		Model: echo.New("file-changes", scripts...), Tools: nativeTools,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctrl, key, err := New(a, Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(ctrl.Handler())
	t.Cleanup(func() { ctrl.Close(); server.Close() })

	req, _ := http.NewRequest(http.MethodPost, server.URL+"/api/chat/stream",
		strings.NewReader(`{"message":"update files","sessionName":"files"}`))
	req.Header.Set("X-Loopra-Key", key)
	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	events := parseSSE(t, readAll(t, resp))
	var streamed []filediff.FileChange
	for _, event := range events {
		if event["type"] == "error" {
			t.Fatalf("stream error: %v", event)
		}
		if event["type"] == "file_changes" {
			raw, _ := json.Marshal(event["changes"])
			var changes []filediff.FileChange
			if err := json.Unmarshal(raw, &changes); err != nil {
				t.Fatal(err)
			}
			streamed = append(streamed, changes...)
		}
	}
	if len(streamed) != 4 {
		t.Fatalf("changes = %+v, events = %v", streamed, events)
	}
	if streamed[0].Path != "nested/new.txt" || !streamed[0].Created || streamed[0].Additions != 2 ||
		streamed[1].Created || streamed[1].Additions != 1 || streamed[1].Deletions != 1 ||
		streamed[2].Created || !streamed[3].Created || streamed[3].Path != "empty.txt" {
		t.Fatalf("changes = %+v", streamed)
	}
	var persisted []filediff.FileChange
	for _, row := range ctrl.sessionMessages(t.Context(), "files") {
		if row["file_changes"] == nil {
			continue
		}
		raw, _ := json.Marshal(row["file_changes"])
		var changes []filediff.FileChange
		if err := json.Unmarshal(raw, &changes); err != nil {
			t.Fatal(err)
		}
		persisted = append(persisted, changes...)
	}
	got, _ := json.Marshal(persisted)
	want, _ := json.Marshal(streamed)
	if string(got) != string(want) {
		t.Fatalf("history = %s, stream = %s", got, want)
	}
	// Reloading metadata rows must not replay the rich tool event twice or
	// inject empty assistant messages/diffs into the model's tool responses.
	reloaded, err := a.Session(t.Context(), "files")
	if err != nil {
		t.Fatal(err)
	}
	results := 0
	for event := range reloaded.Events().All() {
		if event.Content == nil {
			continue
		}
		for _, part := range event.Content.Parts {
			if part.FunctionResponse != nil {
				results++
				if part.FunctionResponse.Response["file_changes"] != nil {
					t.Fatal("diff leaked into model-facing tool response")
				}
			}
		}
	}
	if results != len(calls) {
		t.Fatalf("reloaded tool results = %d, want %d", results, len(calls))
	}
	// Undo each edit in reverse order, using the exact patches sent to the UI.
	for i := len(streamed) - 1; i >= 0; i-- {
		status, body := call(t, server, http.MethodPost, "/api/sessions/file-changes/revert", key,
			map[string]any{"workspaceHash": a.App(), "changes": []filediff.FileChange{streamed[i]}})
		if status != http.StatusOK {
			t.Fatalf("revert %s: %d %v", streamed[i].Path, status, body)
		}
	}
	data, err := os.ReadFile(filepath.Join(workspace, "existing.txt"))
	if err != nil || string(data) != original {
		t.Fatalf("restored content = %q, err = %v", data, err)
	}
	for _, path := range []string{"nested/new.txt", "empty.txt"} {
		if _, err := os.Stat(filepath.Join(workspace, path)); !os.IsNotExist(err) {
			t.Fatalf("new file survived undo: %s (%v)", path, err)
		}
	}
}

func TestGeneratedFileDiffRoundTrip(t *testing.T) {
	texts := []string{"", "\n", "a", "a\n", "a\r\n", "a\nb", "a\nB\n", "a\r\nb\r\n", "\n\n", "---\n+++\n",
		strings.Repeat("line\r\n", 4001), strings.Repeat("line\n", 4001) + "last"}
	for _, before := range texts {
		for _, after := range texts {
			change := filediff.CompareFile("file.txt", &before, after)
			parsed, err := parseWholeFileDiff(change.Diff)
			if err != nil || parsed.before != before || parsed.after != after {
				t.Fatalf("round trip (%d -> %d bytes): err=%v before=%q after=%q",
					len(before), len(after), err, parsed.before, parsed.after)
			}
		}
	}
}
