package controller

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
	"github.com/ezdemo/looprax/internal/service/tools"
)

//go:embed builtin_skills/*/SKILL.md
var builtinSkills embed.FS

func (s *Controller) agentsSkillsRoot() string {
	if root := os.Getenv("LOOPRA_AGENTS_SKILLS_DIR"); root != "" {
		return root
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".agents", "skills")
}

func (s *Controller) globalSkillMetadata() []map[string]any {
	out := []map[string]any{}
	dirs, _ := builtinSkills.ReadDir("builtin_skills")
	for _, dir := range dirs {
		data, err := builtinSkills.ReadFile("builtin_skills/" + dir.Name() + "/SKILL.md")
		if err != nil {
			continue
		}
		name, description := skillFrontmatter(data, dir.Name())
		out = append(out, map[string]any{"name": name, "description": description, "scope": "@builtin-skills/" + dir.Name(), "runAs": "", "directoryName": dir.Name()})
	}
	for _, source := range []struct{ root, alias string }{{filepath.Join(s.home, "skills"), "@loopra-skills"}, {s.agentsSkillsRoot(), "@agents-skills"}} {
		if source.root == "" {
			continue
		}
		for _, entry := range scanSkills(source.root, source.alias) {
			out = append(out, map[string]any{"name": entry["name"], "description": entry["description"], "scope": entry["scope"], "runAs": "", "directoryName": entry["directoryName"]})
		}
	}
	if s.plugins != nil {
		for _, skill := range s.plugins.Skills() {
			out = append(out, map[string]any{"name": skill.Name, "description": skill.Description, "scope": "@plugin-skills/" + skill.PluginID, "runAs": "", "directoryName": skill.PluginID})
		}
	}
	return out
}

func (s *Controller) availableSkillMetadata() []map[string]any {
	out := s.globalSkillMetadata()
	for _, entry := range scanSkills(filepath.Join(s.workspaceRoot(), ".loopra", "skills"), "@project-skills") {
		out = append(out, map[string]any{"name": entry["name"], "description": entry["description"], "scope": entry["scope"], "runAs": "", "directoryName": entry["directoryName"]})
	}
	return out
}

func (s *Controller) readSkill(name, path string) (string, error) {
	alias, relative, ok := strings.Cut(name, "/")
	if !ok || relative == "" || strings.ContainsAny(relative, `/\`) || relative == "." || relative == ".." {
		return "", fmt.Errorf("请使用技能清单中的完整标识")
	}
	if path == "" {
		path = "SKILL.md"
	}
	if alias == "@builtin-skills" {
		if path != "SKILL.md" {
			return "", fmt.Errorf("内置技能资源不存在")
		}
		data, err := builtinSkills.ReadFile("builtin_skills/" + relative + "/SKILL.md")
		return string(data), err
	}
	root := ""
	switch alias {
	case "@loopra-skills":
		root = filepath.Join(s.home, "skills")
	case "@agents-skills":
		root = s.agentsSkillsRoot()
	case "@project-skills":
		root = filepath.Join(s.workspaceRoot(), ".loopra", "skills")
	case "@plugin-skills":
		if s.plugins == nil {
			return "", fmt.Errorf("技能来源不存在")
		}
		return s.plugins.ReadSkill(relative, path)
	default:
		return "", fmt.Errorf("技能来源不存在")
	}
	if root == "" {
		return "", fmt.Errorf("技能来源不可用")
	}
	directory, err := fsutil.SafeJoin(root, relative)
	if err != nil {
		return "", err
	}
	target, err := fsutil.SafeJoin(directory, path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > 4<<20 {
		return "", fmt.Errorf("技能文件不可读取或超过 4 MiB")
	}
	data, err := os.ReadFile(target)
	return string(data), err
}

func (s *Controller) installSkillTools() {
	type readInput struct {
		Name string `json:"name"`
		Path string `json:"path,omitempty"`
	}
	read, _ := functiontool.New[readInput, map[string]any](functiontool.Config{Name: "skillread", Description: "使用清单中的完整标识读取技能规约；path 可读取该技能内的配套文件，默认 SKILL.md。"}, func(ctx agentctx.Context, in readInput) (map[string]any, error) {
		text, err := s.readSkill(in.Name, in.Path)
		if err != nil {
			return nil, err
		}
		return map[string]any{"name": in.Name, "content": text}, nil
	})
	list, _ := functiontool.New[struct{}, []map[string]any](functiontool.Config{Name: "skilllist", Description: "列出当前可用的内置、用户、通用和项目技能。"}, func(agentctx.Context, struct{}) ([]map[string]any, error) { return s.availableSkillMetadata(), nil })
	type searchInput struct {
		Query string `json:"query"`
	}
	search, _ := functiontool.New[searchInput, []map[string]any](functiontool.Config{Name: "skillsearch", Description: "按名称、描述和完整标识搜索当前可用技能。"}, func(ctx agentctx.Context, in searchInput) ([]map[string]any, error) {
		out := []map[string]any{}
		for _, entry := range s.availableSkillMetadata() {
			haystack := strings.ToLower(fmt.Sprint(entry["name"], " ", entry["description"], " ", entry["scope"]))
			match := true
			for _, word := range strings.Fields(strings.ToLower(in.Query)) {
				if !strings.Contains(haystack, word) {
					match = false
					break
				}
			}
			if match {
				out = append(out, entry)
			}
		}
		return out, nil
	})
	refresh, _ := functiontool.New[struct{}, []map[string]any](functiontool.Config{Name: "skillrefresh", Description: "重新扫描技能目录并返回最新清单。"}, func(agentctx.Context, struct{}) ([]map[string]any, error) { return s.availableSkillMetadata(), nil })
	for _, entry := range []tools.Tool{
		{Tool: read, Meta: tools.Metadata{Name: read.Name(), Description: read.Description(), ReadOnly: true, AutoApprove: true}},
		{Tool: list, Meta: tools.Metadata{Name: list.Name(), Description: list.Description(), ReadOnly: true, AutoApprove: true}},
		{Tool: search, Meta: tools.Metadata{Name: search.Name(), Description: search.Description(), ReadOnly: true, AutoApprove: true}},
		{Tool: refresh, Meta: tools.Metadata{Name: refresh.Name(), Description: refresh.Description(), ReadOnly: true, AutoApprove: true}},
	} {
		s.registry.Add(entry)
	}
}

func nativeCommandMetadata() []map[string]any {
	out := []map[string]any{}
	for _, command := range []struct{ cmd, desc, args string }{
		{"/agree", "批准 HITL 待执行的工具调用", ""},
		{"/compact", "折叠历史消息（语义摘要）", ""},
		{"/continue", "让 AI 继续生成/推理（HITL 模式下等同于 /agree）", ""},
		{"/deny", "拒绝 HITL 待执行的工具调用", ""},
		{"/execute", "退出计划模式（有待审查计划时批准并按计划执行）", ""},
		{"/goal", "<create|status|pause|resume|done|block|complete|cancel>  管理当前会话 Goal", "create <目标> | status | done <步骤号> <证据>"},
		{"/help", "显示此帮助信息", ""},
		{"/hitl", "切换 HITL 模式（free/approval/auto）", ""},
		{"/init", "自动分析项目生成 loopra.md", ""},
		{"/plan", "[任务]   进入计划模式（只读探索，用 submit_plan 提交计划供审查）", "任务描述（可选）"},
		{"/plugin", "在设置页安装插件。来源是 npm 包名或 GitHub 地址，由 moejs 执行。插件可以提供工具和对话钩子，也可以 fetch 或用 node:fs 读写本机文件", "left-pad | @scope/pkg | github:owner/repo"},
		{"/sessions", "列出历史会话", ""},
	} {
		entry := map[string]any{"cmd": command.cmd, "desc": command.desc}
		if command.args != "" {
			entry["args"] = command.args
		}
		out = append(out, entry)
	}
	return out
}
