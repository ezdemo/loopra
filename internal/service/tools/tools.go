// Package tools 提供 Loopra 内置工具，以及一个注册表：
// 注册表记录读写分类，并通过 ADK Toolset 接口
// 支持热启用与禁用。
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	agentpkg "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool"
	"google.golang.org/adk/v2/tool/functiontool"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
	"github.com/ezdemo/looprax/internal/infrastructure/processtree"
	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
	"github.com/ezdemo/looprax/internal/service/hitl"
)

// Metadata 为 /api/tools 接口与审批规则描述单个工具。
type Metadata struct {
	Name        string
	Description string
	ReadOnly    bool
	AutoApprove bool
}

// Tool 把 ADK 工具与其 Loopra 元数据组合在一起。
type Tool struct {
	Tool tool.Tool
	Meta Metadata
}

// Registry 是可变工具集：启停变更在下一个模型步骤生效。
type Registry struct {
	mu       chan struct{} // 信号量风格锁，保持结构体可复制
	entries  []Tool
	disabled map[string]bool
	readonly map[string]bool // 覆盖项：名称 -> 强制只读
	auto     map[string]bool
	filter   func(agentpkg.ReadonlyContext, Metadata) bool
	policy   *hitl.Policy
}

func NewRegistry(entries ...Tool) *Registry {
	return &Registry{
		mu:       make(chan struct{}, 1),
		entries:  append([]Tool(nil), entries...),
		disabled: map[string]bool{},
		readonly: map[string]bool{},
		auto:     map[string]bool{},
	}
}

// SetPolicy 安装审批策略；此后工具调用会经 tool.WithConfirmation
// 按会话逐个判定是否放行。
func (r *Registry) SetPolicy(p *hitl.Policy) {
	r.mu <- struct{}{}
	r.policy = p
	<-r.mu
}

func (r *Registry) SetFilter(filter func(agentpkg.ReadonlyContext, Metadata) bool) {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	r.filter = filter
}

// Policy 返回已安装的审批策略（可能为 nil）。
func (r *Registry) Policy() *hitl.Policy {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	return r.policy
}

// Add 追加一个工具条目（sub_agent 在组装完成后加入）。
func (r *Registry) Add(entry Tool) {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	for i, e := range r.entries {
		if e.Meta.Name == entry.Meta.Name {
			r.entries[i] = entry
			return
		}
	}
	r.entries = append(r.entries, entry)
}

// Entries 返回已注册工具条目的快照。
func (r *Registry) Entries() []Tool {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	return append([]Tool(nil), r.entries...)
}

// Disabled 报告某个工具的启用状态。
func (r *Registry) Disabled(name string) bool {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	return r.disabled[name]
}

// GateOne 用 ADK 确认门禁包装单个工具。
func GateOne(t tool.Tool, require func(name string, args any) bool) tool.Tool {
	set := tool.WithConfirmation(singleToolset{t}, false, require)
	tools, _ := set.Tools(nil)
	if len(tools) == 0 {
		return t
	}
	return tools[0]
}

// Name 实现 tool.Toolset 接口。
func (r *Registry) Name() string { return "loopra-tools" }

// singleToolset 将单个工具适配为 Toolset 接口以便包装。
type singleToolset struct{ t tool.Tool }

func (s singleToolset) Name() string { return s.t.Name() }
func (s singleToolset) Tools(agentpkg.ReadonlyContext) ([]tool.Tool, error) {
	return []tool.Tool{s.t}, nil
}

// Tools 实现 tool.Toolset，每个模型步骤都会重新计算。安装策略后，
// 每个工具还会额外包装一层 ADK 确认门禁，
// 使被标记的调用以选项形式暂停当前轮次。
func (r *Registry) Tools(ctx agentpkg.ReadonlyContext) ([]tool.Tool, error) {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	policy := r.policy
	out := make([]tool.Tool, 0, len(r.entries))
	for _, e := range r.entries {
		if r.disabled[e.Meta.Name] {
			continue
		}
		meta := e.Meta
		if forced, ok := r.readonly[meta.Name]; ok {
			meta.ReadOnly = forced
		}
		if r.filter != nil && !r.filter(ctx, meta) {
			continue
		}
		if policy != nil {
			session := ctx.SessionID()
			gated := tool.WithConfirmation(singleToolset{e.Tool}, false,
				func(name string, args any) bool {
					m, _ := args.(map[string]any)
					return policy.Require(session, name, m)
				})
			wrapped, err := gated.Tools(ctx)
			if err == nil && len(wrapped) > 0 {
				out = append(out, wrapped[0])
				continue
			}
		}
		out = append(out, e.Tool)
	}
	return out, nil
}

// List 按稳定顺序返回 /api/tools 视图。
func (r *Registry) List() []map[string]any {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	out := make([]map[string]any, 0, len(r.entries))
	names := make([]string, 0, len(r.entries))
	byName := map[string]Tool{}
	for _, e := range r.entries {
		names = append(names, e.Meta.Name)
		byName[e.Meta.Name] = e
	}
	sort.Strings(names)
	for _, name := range names {
		e := byName[name]
		readOnly := e.Meta.ReadOnly
		if forced, ok := r.readonly[name]; ok {
			readOnly = forced
		}
		var override any
		if forced, ok := r.readonly[name]; ok {
			override = forced
		}
		auto := e.Meta.AutoApprove
		if forced, ok := r.auto[name]; ok {
			auto = forced
		}
		view := map[string]any{
			"name": name, "description": e.Meta.Description,
			"readOnly": readOnly, "readOnlyOverride": override,
			"stormExempt": false, "enabled": !r.disabled[name],
			"autoApproved": auto, "params": toolParameters(e.Tool),
		}
		if override == nil {
			delete(view, "readOnlyOverride")
		}
		out = append(out, view)
	}
	return out
}

func toolParameters(t tool.Tool) []map[string]any {
	out := []map[string]any{}
	declarer, ok := t.(interface {
		Declaration() *genai.FunctionDeclaration
	})
	if !ok || declarer.Declaration() == nil {
		return out
	}
	decl := declarer.Declaration()
	schema := decl.ParametersJsonSchema
	if schema == nil {
		schema = decl.Parameters
	}
	raw, err := json.Marshal(schema)
	if err != nil {
		return out
	}
	var decoded struct {
		Properties map[string]struct {
			Type        string `json:"type"`
			Description string `json:"description"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if json.Unmarshal(raw, &decoded) != nil {
		return out
	}
	names := []string{}
	for name := range decoded.Properties {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		property := decoded.Properties[name]
		required := false
		for _, key := range decoded.Required {
			if key == name {
				required = true
			}
		}
		out = append(out, map[string]any{"name": name, "type": strings.ToLower(property.Type), "description": property.Description, "required": required})
	}
	return out
}

func (r *Registry) Configure(disabled, approved []string, overrides map[string]bool) {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	r.disabled, r.readonly, r.auto = map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, name := range disabled {
		r.disabled[ResolveName(name)] = true
	}
	for name, value := range overrides {
		resolved := ResolveName(name)
		if _, explicit := overrides[resolved]; resolved != name && explicit {
			continue
		}
		r.readonly[resolved] = value
	}
	if approved != nil {
		for _, entry := range r.entries {
			r.auto[entry.Meta.Name] = false
		}
		for _, name := range approved {
			r.auto[ResolveName(name)] = true
		}
	}
}

// Toggle 切换工具的启用状态，并返回新状态。
func (r *Registry) Toggle(name string) (bool, error) {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	if !r.known(name) {
		return false, fmt.Errorf("工具不存在: %s", name)
	}
	r.disabled[name] = !r.disabled[name]
	return !r.disabled[name], nil
}

// SetReadOnly 覆盖读写分类（传 nil 恢复默认）。
func (r *Registry) SetReadOnly(name string, forced *bool) error {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	if !r.known(name) {
		return fmt.Errorf("工具不存在: %s", name)
	}
	if forced == nil {
		delete(r.readonly, name)
		return nil
	}
	r.readonly[name] = *forced
	return nil
}

// Remove 按名称摘掉一个工具。名称不存在时不做任何事。
func (r *Registry) Remove(name string) {
	r.mu <- struct{}{}
	defer func() { <-r.mu }()
	next := make([]Tool, 0, len(r.entries))
	for _, entry := range r.entries {
		if entry.Meta.Name != name {
			next = append(next, entry)
		}
	}
	r.entries = next
	delete(r.disabled, name)
	delete(r.readonly, name)
	delete(r.auto, name)
}

func (r *Registry) known(name string) bool {
	for _, e := range r.entries {
		if e.Meta.Name == name {
			return true
		}
	}
	return false
}

// safePath 在 root 下解析 rel，并拒绝路径逃逸。
func safePath(root, rel string) (string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(rel)
	if filepath.IsAbs(clean) {
		return "", fmt.Errorf("仅允许项目内相对路径")
	}
	abs := filepath.Join(root, clean)
	if root != abs && !strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return "", fmt.Errorf("路径越出项目边界")
	}
	realRoot, err := fsutil.Resolve(root)
	if err != nil {
		return "", err
	}
	// 解析最近的已存在祖先目录，包含新文件之上的链接。
	for ancestor := abs; ; ancestor = filepath.Dir(ancestor) {
		resolved, err := fsutil.Resolve(ancestor)
		if err == nil {
			inside, err := filepath.Rel(realRoot, resolved)
			if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) || filepath.IsAbs(inside) {
				return "", fmt.Errorf("路径越出项目边界")
			}
			suffix, _ := filepath.Rel(ancestor, abs)
			return filepath.Join(resolved, suffix), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		if _, linkErr := os.Lstat(ancestor); linkErr == nil {
			return "", fmt.Errorf("路径包含无法解析的符号链接")
		}
		if ancestor == root || filepath.Dir(ancestor) == ancestor {
			return "", err
		}
	}
}

type linkedProjectsKey struct{}

// WithLinkedProjects 仅授予当前轮次访问显式关联根目录的权限。
func WithLinkedProjects(ctx context.Context, roots []string) context.Context {
	return context.WithValue(ctx, linkedProjectsKey{}, append([]string(nil), roots...))
}

func contextualPath(ctx context.Context, root, path string) (string, error) {
	if filepath.IsAbs(path) {
		roots, _ := ctx.Value(linkedProjectsKey{}).([]string)
		for _, candidate := range append([]string{root}, roots...) {
			rel, err := filepath.Rel(candidate, path)
			if err == nil && rel != ".." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return safePath(candidate, rel)
			}
		}
		return "", fmt.Errorf("路径不属于当前项目或本轮关联项目")
	}
	return safePath(root, path)
}

// FileTools 构建作用域限定在 root 的核心文件和 shell 工具集。
func FileTools(root string) []Tool {
	return []Tool{
		{readTool(root), Metadata{Name: "read", Description: "读取项目内文本文件", ReadOnly: true, AutoApprove: true}},
		{rgTool(root), Metadata{Name: "rg", Description: rgDescription, ReadOnly: true, AutoApprove: true}},
		{writeTool(root), Metadata{Name: "write", Description: "创建或覆盖文件", ReadOnly: false, AutoApprove: true}},
		{editTool(root), Metadata{Name: "edit", Description: "对文件执行多处精准替换", ReadOnly: false, AutoApprove: true}},
		{bashTool(root), Metadata{Name: shellenv.Current.Name, Description: "执行一次性 " + shellenv.Current.Name + " 命令（支持 cwd、max_char、timeout）", ReadOnly: false, AutoApprove: false}},
	}
}

func readTool(root string) tool.Tool {
	t, _ := functiontool.New[struct {
		Path    string `json:"path" jsonschema:"项目内相对路径"`
		MaxLine int    `json:"max_line,omitempty" jsonschema:"最多返回的行数"`
	}, map[string]any](functiontool.Config{Name: "read", Description: "读取项目内文本文件"},
		func(ctx agentpkg.Context, in struct {
			Path    string `json:"path" jsonschema:"项目内相对路径"`
			MaxLine int    `json:"max_line,omitempty" jsonschema:"最多返回的行数"`
		}) (map[string]any, error) {
			abs, err := contextualPath(ctx, root, in.Path)
			if err != nil {
				return nil, err
			}
			data, err := os.ReadFile(abs)
			if err != nil {
				return nil, err
			}
			lines := strings.Split(string(data), "\n")
			limit := in.MaxLine
			if limit <= 0 || limit > len(lines) {
				limit = len(lines)
			}
			var sb strings.Builder
			for i, line := range lines[:limit] {
				fmt.Fprintf(&sb, "%d: %s\n", i+1, line)
			}
			return map[string]any{"result": sb.String()}, nil
		})
	return t
}

func writeTool(root string) tool.Tool {
	t, _ := functiontool.New[struct {
		Path    string `json:"path" jsonschema:"项目内相对路径"`
		Content string `json:"content" jsonschema:"完整文件内容"`
	}, map[string]any](functiontool.Config{Name: "write", Description: "创建或覆盖文件"},
		func(ctx agentpkg.Context, in struct {
			Path    string `json:"path" jsonschema:"项目内相对路径"`
			Content string `json:"content" jsonschema:"完整文件内容"`
		}) (map[string]any, error) {
			abs, err := contextualPath(ctx, root, in.Path)
			if err != nil {
				return nil, err
			}
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				return nil, err
			}
			if err := os.WriteFile(abs, []byte(in.Content), 0o644); err != nil {
				return nil, err
			}
			return map[string]any{"result": fmt.Sprintf("已写入 %s（%d 字节）", in.Path, len(in.Content))}, nil
		})
	return t
}

type editPair struct {
	Old string `json:"old" jsonschema:"要替换的原文"`
	New string `json:"new" jsonschema:"替换后的文本"`
}

func editTool(root string) tool.Tool {
	t, _ := functiontool.New[struct {
		Path  string     `json:"path" jsonschema:"项目内相对路径"`
		Edits []editPair `json:"edits" jsonschema:"有序替换列表"`
	}, map[string]any](functiontool.Config{Name: "edit", Description: "对文件执行多处精准替换"},
		func(ctx agentpkg.Context, in struct {
			Path  string     `json:"path" jsonschema:"项目内相对路径"`
			Edits []editPair `json:"edits" jsonschema:"有序替换列表"`
		}) (map[string]any, error) {
			abs, err := contextualPath(ctx, root, in.Path)
			if err != nil {
				return nil, err
			}
			data, err := os.ReadFile(abs)
			if err != nil {
				return nil, err
			}
			content := string(data)
			for _, e := range in.Edits {
				if !strings.Contains(content, e.Old) {
					return nil, fmt.Errorf("未找到待替换文本: %q", truncate(e.Old, 60))
				}
				content = strings.Replace(content, e.Old, e.New, 1)
			}
			if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
				return nil, err
			}
			return map[string]any{"result": fmt.Sprintf("已应用 %d 处替换", len(in.Edits))}, nil
		})
	return t
}

const (
	defaultShellTimeout  = 120 * time.Second
	maxShellTimeout      = time.Hour
	defaultShellMaxChars = 64000
	maxShellMaxChars     = 200000
)

type shellCommandInput struct {
	Command   string `json:"command" jsonschema:"要执行的命令"`
	Cwd       string `json:"cwd,omitempty" jsonschema:"工作目录，默认项目根；可传项目内相对路径或项目内绝对路径"`
	MaxChar   int    `json:"max_char,omitempty" jsonschema:"最多返回的字符数，默认 64000，最大 200000"`
	Timeout   int    `json:"timeout,omitempty" jsonschema:"超时秒数，默认 120，最大 3600"`
	TimeoutMs int    `json:"timeout_ms,omitempty" jsonschema:"兼容旧参数：超时毫秒数；与 timeout 同时提供时以 timeout 为准"`
}

func bashTool(root string) tool.Tool {
	t, _ := functiontool.New[shellCommandInput, map[string]any](
		functiontool.Config{
			Name:        shellenv.Current.Name,
			Description: "执行一次性 " + shellenv.Current.Name + " 命令，使用该 shell 的语法；支持 cwd、max_char、timeout 参数。大批量文件检索、枚举或计数请优先使用 rg 工具，避免递归枚举加逐文件文本扫描。",
		},
		func(ctx agentpkg.Context, in shellCommandInput) (map[string]any, error) {
			return runShellCommand(ctx, root, in)
		})
	return t
}

func runShellCommand(ctx context.Context, root string, in shellCommandInput) (map[string]any, error) {
	if strings.TrimSpace(in.Command) == "" {
		return nil, fmt.Errorf("command 不能为空")
	}
	maxChars, err := normalizeShellMaxChars(in.MaxChar, defaultShellMaxChars)
	if err != nil {
		return nil, err
	}
	timeout, err := normalizeShellTimeout(in.Timeout, in.TimeoutMs)
	if err != nil {
		return nil, err
	}
	dir, err := resolveShellCwd(ctx, root, in.Cwd)
	if err != nil {
		return nil, err
	}

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := shellenv.Current.Command(runCtx, in.Command)
	cmd.Dir = dir
	output := newCharLimitedWriter(maxChars)
	waitErr := processtree.CombinedOutputTo(cmd, output)
	text, totalChars := output.Finish()
	truncated := totalChars > maxChars
	if truncated {
		text += fmt.Sprintf("\n\n[输出已截断：仅保留前 %d 个字符，共 %d 个字符；可增大 max_char 或缩小命令输出范围]", maxChars, totalChars)
	}

	status := "completed"
	result := map[string]any{
		"result": text, "status": status, "cwd": dir,
		"truncated": truncated, "max_char": maxChars, "total_chars": totalChars,
	}
	if truncated {
		result["omitted_chars"] = totalChars - maxChars
	}
	if cmd.ProcessState != nil {
		result["exit_code"] = cmd.ProcessState.ExitCode()
	}
	if waitErr == nil {
		return result, nil
	}

	switch {
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		status = "timed_out"
		result["timed_out"] = true
		result["error"] = fmt.Sprintf("命令执行超时（%s），进程树已终止", timeout)
	case errors.Is(runCtx.Err(), context.Canceled):
		status = "canceled"
		result["canceled"] = true
		result["error"] = "命令已取消"
	default:
		status = "failed"
		result["error"] = waitErr.Error()
	}
	result["status"] = status
	return result, nil
}

func resolveShellCwd(ctx context.Context, root, cwd string) (string, error) {
	dir := root
	if cwd != "" {
		var err error
		dir, err = contextualPath(ctx, root, cwd)
		if err != nil {
			return "", fmt.Errorf("cwd 无效: %w", err)
		}
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		return "", fmt.Errorf("cwd 无效: %w", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		return "", fmt.Errorf("cwd 不存在或不可访问: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("cwd 不是目录: %s", dir)
	}
	return dir, nil
}

func normalizeShellMaxChars(value, fallback int) (int, error) {
	if value < 0 {
		return 0, fmt.Errorf("max_char 不能为负数")
	}
	if value == 0 {
		value = fallback
	}
	if value > maxShellMaxChars {
		return 0, fmt.Errorf("max_char 最大为 %d", maxShellMaxChars)
	}
	return value, nil
}

func normalizeShellTimeout(seconds, milliseconds int) (time.Duration, error) {
	return normalizeTimeout(seconds, milliseconds, defaultShellTimeout)
}

func normalizeTimeout(seconds, milliseconds int, fallback time.Duration) (time.Duration, error) {
	if seconds < 0 || milliseconds < 0 {
		return 0, fmt.Errorf("timeout 和 timeout_ms 不能为负数")
	}
	if seconds > 0 {
		if seconds > int(maxShellTimeout/time.Second) {
			return 0, fmt.Errorf("timeout 最大为 %d 秒", int(maxShellTimeout/time.Second))
		}
		return time.Duration(seconds) * time.Second, nil
	}
	if milliseconds > 0 {
		if milliseconds > int(maxShellTimeout/time.Millisecond) {
			return 0, fmt.Errorf("timeout_ms 最大为 %d", int(maxShellTimeout/time.Millisecond))
		}
		return time.Duration(milliseconds) * time.Millisecond, nil
	}
	return fallback, nil
}

type charLimitedWriter struct {
	maxChars int
	text     strings.Builder
	pending  []byte
	total    int
}

func newCharLimitedWriter(maxChars int) *charLimitedWriter {
	w := &charLimitedWriter{maxChars: maxChars}
	w.text.Grow(maxChars)
	return w
}

func (w *charLimitedWriter) Write(p []byte) (int, error) {
	data := p
	if len(w.pending) > 0 {
		data = append(append([]byte(nil), w.pending...), p...)
		w.pending = nil
	}
	for len(data) > 0 {
		if !utf8.FullRune(data) {
			w.pending = append(w.pending[:0], data...)
			break
		}
		r, size := utf8.DecodeRune(data)
		w.total++
		if w.total <= w.maxChars {
			w.text.WriteRune(r)
		}
		data = data[size:]
	}
	return len(p), nil
}

func (w *charLimitedWriter) Finish() (string, int) {
	for len(w.pending) > 0 {
		r, size := utf8.DecodeRune(w.pending)
		w.total++
		if w.total <= w.maxChars {
			w.text.WriteRune(r)
		}
		w.pending = w.pending[size:]
	}
	return w.text.String(), w.total
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
