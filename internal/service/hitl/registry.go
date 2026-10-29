// Package hitl 实现 Loopra 人机协同审批（HITL）链：一个
// 待处理请求注册表，由智能体运行时（阻塞等待决策）
// 与 HTTP 权限端点（负责解决决策）共享。
package hitl

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// OptionKind 对应 choice 事件上携带的 Loopra 选项类型。
const (
	KindAllowOnce  = "allow_once"
	KindRejectOnce = "reject_once"
)

// Option 是审批提示中的一个可选回答。
type Option struct {
	Title string `json:"title"`
	Value string `json:"value"` // optionId
	Kind  string `json:"kind"`
}

// Request 是一条待处理的工具审批决策。
type Request struct {
	ID        string         `json:"permissionRequestId"`
	Session   string         `json:"sessionName"`
	SubID     int            `json:"subId,omitempty"` // 由子代理发起时 >0
	Tool      string         `json:"tool"`
	Title     string         `json:"title,omitempty"` // choice 事件标题；空则用默认文案
	Args      map[string]any `json:"args"`
	Hint      string         `json:"hint"`
	Options   []Option       `json:"options"`
	ConfirmID string         `json:"-"` // ADK adk_request_confirmation 调用 id
	CreatedAt int64          `json:"createdAt"`

	resolved chan string // 一个 optionId
}

// Wait 阻塞直到决策到达或 ctx 结束，返回选中的
// optionId；等待被取消或被取代时 ok 为 false。
func (r *Request) Wait(ctx context.Context) (string, bool) {
	select {
	case id := <-r.resolved:
		return id, true
	case <-ctx.Done():
		return "", false
	}
}

// Registry 在内存中跟踪待处理审批。待处理审批不会
// 在重启后保留，与 Java 运行时的内存注册表一致。
type Registry struct {
	mu    sync.Mutex
	pends map[string]*Request
}

func NewRegistry() *Registry { return &Registry{pends: map[string]*Request{}} }

// Register 以新生成的 UUID 风格 id 为键创建待处理请求。
func (g *Registry) Register(session, tool string, args map[string]any, hint, confirmID string) *Request {
	return g.RegisterSub(session, 0, tool, args, hint, confirmID)
}

// RegisterSub 创建归属于某个子代理的待处理请求。
func (g *Registry) RegisterSub(session string, subID int, tool string, args map[string]any, hint, confirmID string) *Request {
	return g.RegisterOptionsSub(session, subID, tool, args, hint, confirmID, defaultOptions(tool))
}

// RegisterOptions 用外部 Agent 提供的选项创建待处理请求
// （ACP 的 allow_once / allow_always / reject_once / reject_always）。
func (g *Registry) RegisterOptions(session, tool string, args map[string]any, hint, confirmID string, options []Option) *Request {
	return g.RegisterOptionsSub(session, 0, tool, args, hint, confirmID, options)
}

// RegisterOptionsWithTitle 同 RegisterOptions，但显式指定 choice 标题
// （外部 Agent 用 toolCall.title 作为审批标题）。
func (g *Registry) RegisterOptionsWithTitle(session, title, tool string, args map[string]any, hint, confirmID string, options []Option) *Request {
	req := g.RegisterOptions(session, tool, args, hint, confirmID, options)
	req.Title = title
	return req
}

// RegisterOptionsSub 是带自定义选项与子代理归属的通用登记入口。
func (g *Registry) RegisterOptionsSub(session string, subID int, tool string, args map[string]any, hint, confirmID string, options []Option) *Request {
	req := &Request{
		ID:        newUUID(),
		Session:   session,
		SubID:     subID,
		Tool:      tool,
		Args:      args,
		Hint:      hint,
		Options:   options,
		ConfirmID: confirmID,
		CreatedAt: time.Now().UnixMilli(),
		resolved:  make(chan string, 1),
	}
	g.mu.Lock()
	g.pends[req.ID] = req
	g.mu.Unlock()
	return req
}

// ResolveSub 回答某个子代理的所有待处理请求，返回
// 解决数量（0 表示该 subId 没有待处理请求）。
func (g *Registry) ResolveSub(subID int, optionID string) int {
	if optionID != "allow_once" && optionID != "reject_once" {
		return 0
	}
	g.mu.Lock()
	var hit []*Request
	for id, req := range g.pends {
		if req.SubID == subID {
			hit = append(hit, req)
			delete(g.pends, id)
		}
	}
	g.mu.Unlock()
	for _, req := range hit {
		select {
		case req.resolved <- optionID:
		default:
		}
	}
	return len(hit)
}

// defaultOptions 构建前端渲染的 Loopra 允许/拒绝选项对。
func defaultOptions(tool string) []Option {
	return []Option{
		{Title: "允许一次", Value: "allow_once", Kind: KindAllowOnce},
		{Title: "拒绝", Value: "reject_once", Kind: KindRejectOnce},
	}
}

// Resolve 记录人工决策并唤醒等待中的运行时。
// 会话必须与待处理请求匹配；未知或已作答的
// 请求返回 ErrStale。
func (g *Registry) Resolve(id, session, optionID string) error {
	g.mu.Lock()
	req, ok := g.pends[id]
	if !ok || req.Session != session {
		g.mu.Unlock()
		return ErrStale
	}
	if !req.allowsOption(optionID) {
		g.mu.Unlock()
		return fmt.Errorf("无效的审批选项: %s", optionID)
	}
	delete(g.pends, id)
	g.mu.Unlock()
	select {
	case req.resolved <- optionID:
	default:
	}
	return nil
}

// allowsOption 报告 optionID 是否为本请求的可选回答之一。
func (r *Request) allowsOption(optionID string) bool {
	for _, o := range r.Options {
		if o.Value == optionID {
			return true
		}
	}
	return false
}

// CancelOne 丢弃一条待处理请求（决策通道无值关闭）。
func (g *Registry) CancelOne(id string) {
	g.mu.Lock()
	delete(g.pends, id)
	g.mu.Unlock()
}

// Cancel 丢弃某个会话的待处理请求（流被关闭/中止），
// 之后提交时以 ErrStale 表达「已取消」语义。
func (g *Registry) Cancel(session string) {
	g.mu.Lock()
	for id, req := range g.pends {
		if req.Session == session {
			delete(g.pends, id)
		}
	}
	g.mu.Unlock()
}

// Pending 列出某个会话的未决请求，最新的在前。
func (g *Registry) Pending(session string) []*Request {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]*Request, 0)
	for _, req := range g.pends {
		if session == "" || req.Session == session {
			out = append(out, req)
		}
	}
	// 稳定的最新优先顺序
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j-1].CreatedAt < out[j].CreatedAt; j-- {
			out[j-1], out[j] = out[j], out[j-1]
		}
	}
	return out
}

// Find 按 id 返回一条待处理请求。
func (g *Registry) Find(id string) (*Request, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	req, ok := g.pends[id]
	return req, ok
}

// ChoicePayload 渲染 Loopra 审批 choice 事件（SSE 契约 §1.4）：
// permissionRequestId、title、description（原始 args JSON）与 options。
func (r *Request) ChoicePayload() map[string]any {
	payload := r.choiceBase()
	if r.SubID > 0 {
		payload["subId"] = r.SubID
	}
	return payload
}

func (r *Request) choiceBase() map[string]any {
	raw, _ := json.Marshal(r.Args)
	options := make([]map[string]any, 0, len(r.Options))
	for _, o := range r.Options {
		options = append(options, map[string]any{"title": o.Title, "value": o.Value, "kind": o.Kind})
	}
	title := r.Title
	if title == "" {
		title = "工具调用需要审批"
	}
	return map[string]any{
		"permissionRequestId": r.ID,
		"title":               title,
		"description":         string(raw),
		"options":             options,
	}
}

// ErrStale 表示针对已不再待处理的请求提交了决策。
var ErrStale = fmt.Errorf("审批已结束或不属于当前会话")

// newUUID 返回 Java 侧用作 permissionRequestId 的随机 UUID。
func newUUID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "00000000-0000-0000-0000-000000000000"
	}
	buf[6] = buf[6]&0x0f | 0x40
	buf[8] = buf[8]&0x3f | 0x80
	h := hex.EncodeToString(buf)
	return fmt.Sprintf("%s-%s-%s-%s-%s", h[0:8], h[8:12], h[12:16], h[16:20], h[20:32])
}
