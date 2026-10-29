package hitl

import (
	"strings"
	"testing"
)

func TestAutoWhitelistOnlySkipsAutoReview(t *testing.T) {
	mode := "auto"
	p := &Policy{Mode: func() string { return mode }, AutoApproved: func(name string) bool { return name == "custom" }}
	if p.Require("s", "custom", nil) {
		t.Fatal("auto-approved tool was sent to human review")
	}
	mode = "approval"
	if !p.Require("s", "custom", nil) {
		t.Fatal("auto whitelist bypassed explicit approval mode")
	}
}

func TestPolicyRequire(t *testing.T) {
	p := &Policy{
		Mode:      func() string { return "approval" },
		Workspace: func() string { return "/w" },
	}
	if p.Require("s", "read", map[string]any{"path": "a.go"}) {
		t.Fatal("read-only tool must pass")
	}
	if p.Require("s", "finish", nil) {
		t.Fatal("control tool must pass")
	}
	if p.Require("s", "write", map[string]any{"path": "a.go"}) {
		t.Fatal("workspace-local write must pass in approval mode")
	}
	if !p.Require("s", "bash", map[string]any{"command": "rm -rf /"}) {
		t.Fatal("mutating bash must require review")
	}
	if !p.Require("s", "danger", nil) {
		t.Fatal("unknown write tool must require review")
	}
	// free 模式放行一切
	p.Mode = func() string { return "free" }
	if p.Require("s", "danger", nil) {
		t.Fatal("free mode must skip the chain")
	}
	// 会话覆盖可在全局为 free 时锁定单个会话
	p.Mode = func() string { return "free" }
	p.SessionMode = func(session string) string {
		if session == "strict" {
			return "approval"
		}
		return ""
	}
	if !p.Require("strict", "danger", nil) {
		t.Fatal("session approval override must gate")
	}
	if p.Require("loose", "danger", nil) {
		t.Fatal("other sessions keep the global mode")
	}
}

func TestShellNamesKeepApprovalPolicy(t *testing.T) {
	p := &Policy{Mode: func() string { return ModeApproval }}
	for _, name := range []string{"bash", "sh", "powershell", "CMD"} {
		if p.Require("s", name, map[string]any{"command": "git status"}) {
			t.Errorf("%s: read-only query requires approval", name)
		}
		if !p.Require("s", name, map[string]any{"command": "rm -rf /"}) {
			t.Errorf("%s: destructive command bypassed approval", name)
		}
	}
}

func TestPolicyAutoAIStage(t *testing.T) {
	p := &Policy{
		Mode:      func() string { return "auto" },
		Workspace: func() string { return "/w" },
	}
	// 没有审查钩子时 auto 回退到人工审批
	if !p.Require("s", "danger", nil) {
		t.Fatal("auto without AI hook must fall to human")
	}
	calls := 0
	p.AIReview = func(session, tool string, args map[string]any) (bool, bool, error) {
		calls++
		if tool == "safe" {
			return true, false, nil
		}
		return false, true, nil // 需要人工
	}
	if p.Require("s", "safe", nil) {
		t.Fatal("AI-approved call must run")
	}
	if !p.Require("s", "danger", nil) {
		t.Fatal("AI-flagged call must require human")
	}
	if calls != 2 {
		t.Fatalf("AI review calls = %d", calls)
	}
}

func TestPolicyBlockedPaths(t *testing.T) {
	p := &Policy{
		Mode:         func() string { return "approval" },
		BlockedPaths: func() []string { return []string{"secrets"} },
	}
	if !p.Require("s", "write", map[string]any{"path": "secrets/key.pem"}) {
		t.Fatal("blocked path must require review")
	}
	if p.Require("s", "write", map[string]any{"path": "public/readme.md"}) {
		t.Fatal("non-blocked workspace write passes without review")
	}
}

func TestPolicyEscapesWorkspace(t *testing.T) {
	p := &Policy{Workspace: func() string { return "/w" }}
	for _, rel := range []string{"../x", "@file", "~/z", "/abs"} {
		if !p.escapesWorkspace(rel) {
			t.Fatalf("%q must escape", rel)
		}
	}
	for _, rel := range []string{"a/b.go", "./x", ""} {
		if p.escapesWorkspace(rel) {
			t.Fatalf("%q must stay inside", rel)
		}
	}
}

func TestReadOnlyShell(t *testing.T) {
	queries := []string{
		"git status", "git diff HEAD", "git log --oneline", "git show abc",
		"ls -la", "pwd", "cat a.txt", "find . -name x",
		"ls | wc -l", "git status; git diff",
	}
	for _, q := range queries {
		if !isReadOnlyShell(q) {
			t.Fatalf("%q must classify read-only", q)
		}
	}
	mutators := []string{
		"rm -rf /", "git push", "npm install", "echo hi > /etc/hosts",
		"cat x $(whoami)", "ls; rm x", "git log --format=%x41`id`",
		"find . -exec rm {} ;",
		// 通配符与带引号的 glob 会绕过只读白名单
		"rg pattern -g '*.go'", "ls *",
	}
	for _, m := range mutators {
		if isReadOnlyShell(m) {
			t.Fatalf("%q must not classify read-only", m)
		}
	}
}

func TestWorkspaceLocalShell(t *testing.T) {
	local := []string{
		"mkdir -p build", "touch x.txt", "cp a.txt b.txt",
		"echo hi > out.txt", "printf ok > log", "ls && cat a.txt",
	}
	for _, c := range local {
		if !isWorkspaceLocalShell(c) {
			t.Fatalf("%q must classify workspace-local", c)
		}
	}
	outside := []string{
		"cp a.txt /etc/passwd", "mv x ..", "rm -rf build", "echo hi > /etc/x",
		"git push origin main", "npm run build",
	}
	for _, c := range outside {
		if isWorkspaceLocalShell(c) {
			t.Fatalf("%q must not classify workspace-local", c)
		}
	}
}

func TestRegistryLifecycle(t *testing.T) {
	g := NewRegistry()
	req := g.Register("s1", "bash", map[string]any{"command": "rm"}, "hint", "c1")
	if len(g.Pending("s1")) != 1 {
		t.Fatal("pending must list the request")
	}
	// 会话不匹配即为过期
	if err := g.Resolve(req.ID, "s2", "allow_once"); err != ErrStale {
		t.Fatalf("wrong session = %v", err)
	}
	// 非法选项被拒绝
	if err := g.Resolve(req.ID, "s1", "bogus"); err == nil || !strings.Contains(err.Error(), "选项") {
		t.Fatalf("bogus option = %v", err)
	}
	if err := g.Resolve(req.ID, "s1", "allow_once"); err != nil {
		t.Fatal(err)
	}
	if err := g.Resolve(req.ID, "s1", "allow_once"); err != ErrStale {
		t.Fatalf("double resolve = %v", err)
	}
	if len(g.Pending("s1")) != 0 {
		t.Fatal("resolved request must leave the pending list")
	}
}
