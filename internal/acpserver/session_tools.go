package acpserver

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	acpsdk "github.com/coder/acp-go-sdk"
	"go.yaml.in/yaml/v3"
	agentctx "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
	"github.com/ezdemo/looprax/internal/service/tools"
)

func (s *liveSession) installSessionTools(r *Runtime) {
	s.registry.SetFilter(func(_ agentctx.ReadonlyContext, meta tools.Metadata) bool {
		s.mu.Lock()
		plan := s.plan
		s.mu.Unlock()
		if !plan {
			return true
		}
		return meta.ReadOnly || meta.Name == "ask_choice" || meta.Name == "submit_plan"
	})
	plan, _ := functiontool.New[struct {
		Steps   string `json:"steps"`
		Summary string `json:"summary,omitempty"`
		Risks   string `json:"risks,omitempty"`
	}, map[string]any](functiontool.Config{
		Name:        "submit_plan",
		Description: "计划模式下提交有序执行步骤供用户审查。steps 可以是 JSON 字符串数组或每行一步的文本。",
	}, func(ctx agentctx.Context, in struct {
		Steps   string `json:"steps"`
		Summary string `json:"summary,omitempty"`
		Risks   string `json:"risks,omitempty"`
	}) (map[string]any, error) {
		s.mu.Lock()
		planning := s.plan
		s.mu.Unlock()
		if !planning {
			return nil, fmt.Errorf("当前不在计划模式")
		}
		text, entries := formatPlan(in.Steps, in.Summary, in.Risks)
		if len(entries) == 0 {
			return nil, fmt.Errorf("执行步骤不能为空")
		}
		s.emit(ctx, r, acpsdk.UpdatePlan(entries...))
		s.emit(ctx, r, acpsdk.UpdateAgentMessageText(text))
		return map[string]any{"status": "submitted", "message": "计划已提交，等待用户确认。请结束本轮，不要执行修改操作。"}, nil
	})
	choice, _ := functiontool.New[struct {
		Question string   `json:"question"`
		Options  []string `json:"options"`
	}, map[string]any](functiontool.Config{
		Name: "ask_choice", Description: "向用户展示选择菜单并等待回答。",
	}, func(ctx agentctx.Context, in struct {
		Question string   `json:"question"`
		Options  []string `json:"options"`
	}) (map[string]any, error) {
		answer, err := s.askChoice(ctx, r, in.Question, in.Options)
		if err != nil {
			return map[string]any{"result": err.Error(), "status": "failed"}, nil
		}
		return map[string]any{"result": answer, "status": "answered"}, nil
	})
	read, _ := functiontool.New[skillReadInput, map[string]any](functiontool.Config{
		Name: "skillread", Description: skillReadDescription,
	}, func(_ agentctx.Context, in skillReadInput) (map[string]any, error) {
		text, err := readSkill(r.home, s.cwd, in.Name, in.Path)
		if err != nil {
			return nil, err
		}
		return map[string]any{"name": in.Name, "content": text}, nil
	})
	list, _ := functiontool.New[struct{}, []map[string]any](functiontool.Config{
		Name: "skilllist", Description: "列出当前可用的用户、通用和项目技能。",
	}, func(agentctx.Context, struct{}) ([]map[string]any, error) {
		return skillMetadata(r.home, s.cwd), nil
	})
	for _, entry := range []tools.Tool{
		{Tool: plan, Meta: tools.Metadata{Name: "submit_plan", Description: plan.Description(), ReadOnly: true, AutoApprove: true}},
		{Tool: choice, Meta: tools.Metadata{Name: "ask_choice", Description: choice.Description(), ReadOnly: true, AutoApprove: true}},
		{Tool: read, Meta: tools.Metadata{Name: "skillread", Description: read.Description(), ReadOnly: true, AutoApprove: true}},
		{Tool: list, Meta: tools.Metadata{Name: "skilllist", Description: list.Description(), ReadOnly: true, AutoApprove: true}},
	} {
		s.registry.Add(entry)
	}
}

func (s *liveSession) askChoice(ctx agentctx.Context, r *Runtime, question string, options []string) (string, error) {
	if len(options) == 0 {
		return "", fmt.Errorf("选项不能为空")
	}
	r.mu.Lock()
	conn := r.conn
	r.mu.Unlock()
	if conn == nil {
		return "", fmt.Errorf("当前没有可以提问的客户端")
	}
	props := map[string]any{"choice": map[string]any{"type": "string", "enum": options}}
	request := acpsdk.NewUnstableCreateElicitationRequestForm(acpsdk.UnstableElicitationSchema{
		Type: "object", Properties: props, Required: []string{"choice"},
	})
	request.Form.Message = question
	response, err := conn.UnstableCreateElicitation(ctx, request)
	if err != nil {
		return "", err
	}
	if response.Accept == nil {
		return "", fmt.Errorf("用户取消了选择")
	}
	choice, _ := response.Accept.Content["choice"].(string)
	if choice == "" {
		return "", fmt.Errorf("用户没有给出选择")
	}
	return choice, nil
}

func formatPlan(stepsText, summary, risks string) (string, []acpsdk.PlanEntry) {
	var steps []string
	if err := jsonUnmarshalStrings(stepsText, &steps); err != nil {
		steps = strings.Split(stepsText, "\n")
	}
	var text strings.Builder
	if strings.TrimSpace(summary) != "" {
		fmt.Fprintf(&text, "**概述**：%s\n\n", strings.TrimSpace(summary))
	}
	text.WriteString("**执行步骤**：\n")
	entries := []acpsdk.PlanEntry{}
	for _, step := range steps {
		step = strings.TrimSpace(step)
		if step == "" {
			continue
		}
		fmt.Fprintf(&text, "%d. %s\n", len(entries)+1, step)
		entries = append(entries, acpsdk.PlanEntry{
			Content: step, Priority: acpsdk.PlanEntryPriorityMedium, Status: acpsdk.PlanEntryStatusPending,
		})
	}
	if strings.TrimSpace(risks) != "" {
		fmt.Fprintf(&text, "\n**风险与注意事项**：%s\n", strings.TrimSpace(risks))
	}
	return text.String(), entries
}

func jsonUnmarshalStrings(raw string, out *[]string) error {
	return yaml.Unmarshal([]byte(raw), out)
}

type skillReadInput struct {
	Name string `json:"name" jsonschema:"清单中的完整标识，例如 @loopra-skills/find-skills"`
	Path string `json:"path,omitempty" jsonschema:"可选。省略则读取 SKILL.md。只能填该技能目录里已有文件的相对路径，例如 README.md 或 references/guide.txt。不要填目录，也不要猜测 SKILL.md 没点名的路径"`
}

const skillReadDescription = "读取技能规约。name 用清单中的完整标识。省略 path 读取 SKILL.md。path 只能是该技能目录内已存在的文件相对路径，且仅当 SKILL.md 点名了该文件时才传；必须是文件，不能是目录，不要猜测 references 这类路径。"

func missingSkillFile(directory, path string) error {
	names := skillFiles(directory)
	if len(names) == 0 {
		return fmt.Errorf("技能内没有文件 %q。省略 path 读取 SKILL.md；path 必须是技能目录内已存在的文件，不能是目录，不要猜测路径", path)
	}
	return fmt.Errorf("技能内没有文件 %q。可读取：%s。省略 path 即读取 SKILL.md；path 必须是其中的文件，不能是目录", path, strings.Join(names, ", "))
}

func skillFiles(directory string) []string {
	names := []string{}
	var walk func(string)
	walk = func(dir string) {
		if len(names) >= 40 {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			if len(names) >= 40 {
				return
			}
			next := filepath.Join(dir, entry.Name())
			if entry.IsDir() {
				walk(next)
				continue
			}
			rel, err := filepath.Rel(directory, next)
			if err != nil {
				continue
			}
			names = append(names, filepath.ToSlash(rel))
		}
	}
	walk(directory)
	sort.Strings(names)
	return names
}

func skillMetadata(home, workspace string) []map[string]any {
	out := []map[string]any{}
	for _, source := range skillRoots(home, workspace) {
		dirs, _ := os.ReadDir(source.root)
		for _, dir := range dirs {
			if !dir.IsDir() {
				continue
			}
			data, err := os.ReadFile(filepath.Join(source.root, dir.Name(), "SKILL.md"))
			if err != nil {
				continue
			}
			name, description := skillTitle(data, dir.Name())
			out = append(out, map[string]any{
				"name": name, "description": description, "scope": source.alias + "/" + dir.Name(),
			})
		}
	}
	return out
}

func readSkill(home, workspace, name, path string) (string, error) {
	alias, relative, ok := strings.Cut(name, "/")
	if !ok || relative == "" || strings.ContainsAny(relative, `/\`) {
		return "", fmt.Errorf("请使用技能清单中的完整标识")
	}
	if path == "" {
		path = "SKILL.md"
	}
	var root string
	for _, source := range skillRoots(home, workspace) {
		if source.alias == alias {
			root = source.root
		}
	}
	if root == "" {
		return "", fmt.Errorf("技能来源不存在")
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
		if os.IsNotExist(err) {
			return "", missingSkillFile(directory, path)
		}
		return "", fmt.Errorf("技能文件 %q 不可读取", path)
	}
	if !info.Mode().IsRegular() {
		return "", missingSkillFile(directory, path)
	}
	if info.Size() > 4<<20 {
		return "", fmt.Errorf("技能文件超过 4 MiB")
	}
	data, err := os.ReadFile(target)
	return string(data), err
}

type skillRoot struct{ root, alias string }

func skillRoots(home, workspace string) []skillRoot {
	roots := []skillRoot{{filepath.Join(home, "skills"), "@loopra-skills"}}
	if agents := agentsSkillsRoot(); agents != "" {
		roots = append(roots, skillRoot{agents, "@agents-skills"})
	}
	roots = append(roots, skillRoot{filepath.Join(workspace, ".loopra", "skills"), "@project-skills"})
	return roots
}

func agentsSkillsRoot() string {
	if root := os.Getenv("LOOPRA_AGENTS_SKILLS_DIR"); root != "" {
		return root
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".agents", "skills")
}

func skillTitle(data []byte, fallback string) (string, string) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return fallback, ""
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return fallback, ""
	}
	var header struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if yaml.Unmarshal([]byte(text[4:4+end]), &header) != nil {
		return fallback, ""
	}
	if strings.TrimSpace(header.Name) == "" {
		header.Name = fallback
	}
	return header.Name, strings.TrimSpace(header.Description)
}
