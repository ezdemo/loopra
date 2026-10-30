package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestContributionsFollowEnabled(t *testing.T) {
	home := t.TempDir()
	h := New(home, Hooks{})
	dir := h.pkgDir("demo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("package.json", `{
		"name":"demo",
		"description":"示例",
		"loopra":{
			"plugin":"./plugin.js",
			"skill":"./SKILL.md",
			"subagent":{"name":"复查","description":"只读","instructions":"只报告问题。"},
			"schedule":{"name":"每日回顾","message":"总结一下","intervalSec":120}
		}
	}`)
	write("SKILL.md", "---\nname: 复查清单\ndescription: 提交前看一遍\n---\n正文\n")
	write("plugin.js", "secret")
	if err := h.upsert(record{ID: "demo", Name: "demo", DisplayName: "示例", Description: "示例", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	skills := h.Skills()
	if len(skills) != 1 || skills[0].PluginID != "demo" || skills[0].Name != "复查清单" || skills[0].Description != "提交前看一遍" {
		t.Fatalf("skills = %+v", skills)
	}
	body, err := h.ReadSkill("demo", "")
	if err != nil || !strings.Contains(body, "正文") {
		t.Fatalf("skill = %q %v", body, err)
	}
	if _, err := h.ReadSkill("demo", "../plugin.js"); err == nil {
		t.Fatal("skill path escaped")
	}
	agents := h.Subagents()
	if len(agents) != 1 || agents[0].ID != "plugin-demo" || !agents[0].ReadOnly || !strings.Contains(agents[0].Instructions, "只报告问题") {
		t.Fatalf("agents = %+v", agents)
	}
	tasks := h.ScheduledTasks()
	if len(tasks) != 1 || tasks[0].ID != "plugin-demo" || !tasks[0].Plugin || tasks[0].IntervalSec != 120 || tasks[0].NextRunAt <= time.Now().UnixMilli() {
		t.Fatalf("tasks = %+v", tasks)
	}
	if err := h.upsert(record{ID: "demo", Name: "demo", DisplayName: "示例"}); err != nil {
		t.Fatal(err)
	}
	if len(h.Skills()) != 0 || len(h.Subagents()) != 0 || len(h.ScheduledTasks()) != 0 {
		t.Fatal("disabled contributions still listed")
	}
}

func TestContributionRejectsInvalidDeclaration(t *testing.T) {
	home := t.TempDir()
	h := New(home, Hooks{})
	dir := h.pkgDir("demo")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{
		"name":"demo",
		"loopra":{
			"skill":"../plugin.js",
			"schedule":{"message":"跑","cron":"not a cron"}
		}
	}`
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plugin.js"), []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := h.upsert(record{ID: "demo", Name: "demo", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if len(h.Skills()) != 0 || len(h.ScheduledTasks()) != 0 {
		t.Fatalf("skills=%v tasks=%v", h.Skills(), h.ScheduledTasks())
	}
}
