package controller

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"google.golang.org/adk/v2/tool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/model/echo"
	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/model/config"
	"github.com/ezdemo/looprax/internal/service"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func TestRequirementScannerPreservesExplicitToolOutcome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("LOOPRA_JAVA_BACKEND_URL", "")
	t.Setenv("LOOPRA_AGENTS_SKILLS_DIR", filepath.Join(home, "agents-skills"))
	workspace := filepath.Join(home, "project")
	os.MkdirAll(workspace, 0o755)
	cfg := config.Default()
	cfg.WorkspaceDir = workspace
	reg := tools.NewRegistry()
	script := echo.New("requirement-result", echo.Script{ToolCalls: []*genai.FunctionCall{{Name: "finish_requirement", Args: map[string]any{"status": "failed", "summary": "explicit tool outcome"}}}})
	a, err := agentpkg.New(home, service.WorkspaceHash(workspace), &cfg, agentpkg.Options{Model: script, Toolsets: []tool.Toolset{reg}})
	if err != nil {
		t.Fatal(err)
	}
	s, key, err := New(a, Options{Home: home, Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(func() { s.Close(); ts.Close() })
	_, env := call(t, ts, "POST", "/api/requirements", key, map[string]any{"title": "Scheduled fixture", "projectHash": a.App(), "scheduleMode": "scheduled", "scheduledAt": time.Now().Add(time.Hour).UnixMilli()})
	id := env["data"].(map[string]any)["id"].(string)
	s.scanRequirements()
	item, _, _ := s.requirementByID(id)
	if item.Status != "todo" {
		t.Fatal("scanner ran a future requirement")
	}
	s.requirementsMutate(id, func(item *model.Requirement) { item.ScheduledAt = time.Now().Add(-time.Second).UnixMilli() })
	s.scanRequirements()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		item, _, _ = s.requirementByID(id)
		running := s.reqs.Running(id)
		if !running {
			if item.Status != "failed" || item.Summary != "explicit tool outcome" {
				t.Fatalf("fallback replaced explicit completion: %+v", item)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("scheduled requirement did not finish")
}
