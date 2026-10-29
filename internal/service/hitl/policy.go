// policy.go 实现 Loopra 六阶段工具审批链：
// boundary → mode → read-only → workspace → ai → human。在 ADK 环境下
// 该链简化为「这次调用是否需要人工确认」；
// 边界越权由工具自身拒绝（safePath），
// 审批链未自动批准的一切都会让当前轮次暂停在选项上等待。
package hitl

import (
	"strings"
)

// HITL 模式（LoopraConfig 契约）。
const (
	ModeFree     = "free"
	ModeApproval = "approval"
	ModeAuto     = "auto"
)

// NormalizeMode 修正遗留取值：true/approve → approval，false/unknown → free。
func NormalizeMode(mode string) string {
	switch strings.TrimSpace(strings.ToLower(mode)) {
	case ModeApproval, "approve", "true":
		return ModeApproval
	case ModeAuto:
		return ModeAuto
	default:
		return ModeFree
	}
}

// ControlTools 永不要求审批（它们结束或引导当前轮次）；
// Java 审批链的 mode 阶段只豁免这两个工具。
var ControlTools = map[string]bool{
	"finish": true, "ask_choice": true,
}

// ReadOnlyTools 是内置只读工具名。
var ReadOnlyTools = map[string]bool{
	"read": true, "rg": true,
	"web": true,
}

// Policy 提供审批链输入；每个钩子都读取实时状态，因此配置
// 与会话的修改在下一次工具调用时即生效。
type Policy struct {
	// Mode 返回全局 hitl 模式。
	Mode func() string
	// SessionMode 返回会话级模式覆盖（"" 表示无）。
	SessionMode func(session string) string
	// ReadOnlyOverride 返回单个工具强制的读写分类
	//（nil 表示默认）。
	ReadOnlyOverride func(name string) *bool
	// BlockedPaths 返回配置的、永不自动批准的路径。
	BlockedPaths func() []string
	// Workspace 是用于路径检查的绝对工作区根目录。
	Workspace func() string
	// AIReview 执行 "auto" 模式的模型预审，返回
	// (allowed, requiresHuman)。钩子为 nil 时禁用该阶段。
	AIReview     func(session, tool string, args map[string]any) (allowed, requiresHuman bool, err error)
	AutoApproved func(tool string) bool
}

// Require 报告一次工具调用是否需要人工确认。
func (p *Policy) Require(session, name string, args map[string]any) bool {
	if p == nil || p.Mode == nil {
		return false
	}
	mode := NormalizeMode(p.Mode())
	if p.SessionMode != nil {
		if raw := strings.TrimSpace(p.SessionMode(session)); raw != "" {
			mode = NormalizeMode(raw)
		}
	}
	// mode 阶段：free 跳过整条链；控制工具始终放行。
	if mode == ModeFree || ControlTools[name] {
		return false
	}
	// read-only 阶段：元数据分类加覆盖项。
	if p.isReadOnly(name) {
		return false
	}
	// 配置的阻断路径一律升级为审批。
	if p.pathBlocked(args) {
		return true
	}
	// workspace 阶段：工作区内的影响无需审批即可通过。
	if p.workspaceLocal(name, args) {
		return false
	}
	if mode == ModeAuto && p.AutoApproved != nil && p.AutoApproved(name) {
		return false
	}
	// ai 阶段（仅 auto 模式，且已配置审查模型）。
	if mode == ModeAuto && p.AIReview != nil {
		allowed, requiresHuman, err := p.AIReview(session, name, args)
		switch {
		case err != nil, requiresHuman, !allowed:
			return true
		default:
			return false
		}
	}
	// human 阶段：其余一切等待用户处理。
	return true
}

func (p *Policy) isReadOnly(name string) bool {
	if p.ReadOnlyOverride != nil {
		if forced := p.ReadOnlyOverride(name); forced != nil {
			return *forced
		}
	}
	if ReadOnlyTools[name] {
		return true
	}
	return false
}

// workspaceLocal 报告停留在工作区内的写入：写向工作区路径的文件
// 以及只读或工作区本地的 shell 命令。
func (p *Policy) workspaceLocal(name string, args map[string]any) bool {
	switch name {
	case "write", "edit":
		return !p.escapesWorkspace(pathOf(args))
	case "memory":
		return true
	case "bash", "sh", "powershell", "CMD":
		command, _ := args["command"].(string)
		return isReadOnlyShell(command) || isWorkspaceLocalShell(command)
	default:
		return false
	}
}

// pathOf 提取主要路径参数（write/edit 的 file_path、read 的 path）。
func pathOf(args map[string]any) string {
	for _, key := range []string{"file_path", "path", "Path"} {
		if s, ok := args[key].(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func (p *Policy) escapesWorkspace(rel string) bool {
	if rel == "" {
		return false
	}
	if strings.HasPrefix(rel, "@") || strings.HasPrefix(rel, "~") {
		return true
	}
	if p.Workspace == nil {
		return false
	}
	return !withinRoot(p.Workspace(), rel)
}

func (p *Policy) pathBlocked(args map[string]any) bool {
	if p.BlockedPaths == nil {
		return false
	}
	blocked := p.BlockedPaths()
	if len(blocked) == 0 {
		return false
	}
	path := pathOf(args)
	for _, b := range blocked {
		if path != "" && (path == b || strings.HasPrefix(path, b+"/") || strings.HasPrefix(path, b+`\`)) {
			return true
		}
	}
	return false
}
