package hitl

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

// ElicitationAnswer 是用户对一条 ACP 提问的回答。
type ElicitationAnswer struct {
	Action  string         `json:"action"` // accept | decline | cancel
	Content map[string]any `json:"content,omitempty"`
}

// Elicitation 是一条待处理的 Agent 反向提问。
type Elicitation struct {
	ID        string
	Session   string
	Message   string
	Schema    map[string]any
	CreatedAt int64

	resolved chan ElicitationAnswer
}

// Event 渲染 elicitation 事件载荷。
func (e *Elicitation) Event() map[string]any {
	return map[string]any{
		"elicitationRequestId": e.ID,
		"sessionId":            e.Session,
		"message":              e.Message,
		"schema":               e.Schema,
	}
}

// ElicitationRegistry 跟踪待处理的 ACP 提问
// （Java AcpElicitations）。答案直接恢复原始 RPC，不再走一次模型回合。
type ElicitationRegistry struct {
	mu    sync.Mutex
	pends map[string]*Elicitation
}

func NewElicitationRegistry() *ElicitationRegistry {
	return &ElicitationRegistry{pends: map[string]*Elicitation{}}
}

// Register 登记一条提问，调用方随后发事件并 Wait。
func (g *ElicitationRegistry) Register(session, message string, schema map[string]any) *Elicitation {
	if message == "" {
		message = "请回答以下问题"
	}
	item := &Elicitation{
		ID: newUUID(), Session: session, Message: message, Schema: schema,
		CreatedAt: time.Now().UnixMilli(), resolved: make(chan ElicitationAnswer, 1),
	}
	g.mu.Lock()
	g.pends[item.ID] = item
	g.mu.Unlock()
	return item
}

// Wait 阻塞等待答案；ctx 结束或 Cancel 时按取消处理。
func (g *ElicitationRegistry) Wait(ctx context.Context, item *Elicitation) (ElicitationAnswer, bool) {
	defer func() {
		g.mu.Lock()
		delete(g.pends, item.ID)
		g.mu.Unlock()
	}()
	select {
	case answer := <-item.resolved:
		return answer, true
	case <-ctx.Done():
		return ElicitationAnswer{Action: "cancel"}, false
	}
}

// Pending 列出某个会话的未决提问。
func (g *ElicitationRegistry) Pending(session string) []map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]map[string]any, 0, len(g.pends))
	for _, item := range g.pends {
		if session != "" && item.Session != session {
			continue
		}
		out = append(out, item.Event())
	}
	return out
}

// Resolve 回答一条提问，校验动作与表单内容。
func (g *ElicitationRegistry) Resolve(id, session, action string, content map[string]any) error {
	g.mu.Lock()
	item, ok := g.pends[id]
	g.mu.Unlock()
	if !ok || item.Session != session {
		return fmt.Errorf("提问已结束或不属于当前会话")
	}
	answer := ElicitationAnswer{Action: action}
	switch action {
	case "accept":
		values := map[string]any{}
		for key, value := range content {
			values[key] = value
		}
		if err := validateElicitation(item.Schema, values); err != nil {
			return err
		}
		answer.Content = values
	case "decline", "cancel":
	default:
		return fmt.Errorf("无效的提问操作")
	}
	g.mu.Lock()
	delete(g.pends, id)
	g.mu.Unlock()
	select {
	case item.resolved <- answer:
		return nil
	default:
		return fmt.Errorf("提问已处理")
	}
}

// Cancel 取消某个会话的所有待处理提问。
func (g *ElicitationRegistry) Cancel(session string) {
	g.mu.Lock()
	var hit []*Elicitation
	for id, item := range g.pends {
		if session != "" && item.Session != session {
			continue
		}
		delete(g.pends, id)
		hit = append(hit, item)
	}
	g.mu.Unlock()
	for _, item := range hit {
		select {
		case item.resolved <- ElicitationAnswer{Action: "cancel"}:
		default:
		}
	}
}

// validateElicitation 按 requestedSchema 校验表单答案
// （Java AcpElicitations.validate）。
func validateElicitation(schema map[string]any, values map[string]any) error {
	fields, _ := schema["properties"].(map[string]any)
	if required, ok := schema["required"].([]any); ok {
		for _, key := range required {
			name, _ := key.(string)
			if value, exists := values[name]; !exists || value == nil {
				return fmt.Errorf("请填写所有必答项")
			}
		}
	}
	for key, value := range values {
		field, ok := fields[key].(map[string]any)
		if !ok || !validElicitationValue(field, value) {
			return fmt.Errorf("提问答案不符合字段要求: %s", key)
		}
	}
	return nil
}

func validElicitationValue(field map[string]any, value any) bool {
	kind, _ := field["type"].(string)
	if kind == "" {
		kind = "string"
	}
	valid := false
	switch kind {
	case "string":
		text, ok := value.(string)
		valid = ok && bound(field, "minLength", float64(len([]rune(text))), true) &&
			bound(field, "maxLength", float64(len([]rune(text))), false)
	case "boolean":
		_, valid = value.(bool)
	case "number", "integer":
		number, ok := numberValue(value)
		if ok && kind == "integer" {
			ok = number == math.Trunc(number)
		}
		valid = ok && bound(field, "minimum", number, true) && bound(field, "maximum", number, false)
	case "array":
		list, ok := value.([]any)
		items, hasItems := field["items"].(map[string]any)
		if !ok || !hasItems {
			return false
		}
		if !bound(field, "minItems", float64(len(list)), true) || !bound(field, "maxItems", float64(len(list)), false) {
			return false
		}
		if unique, _ := field["uniqueItems"].(bool); unique {
			seen := map[string]bool{}
			for _, item := range list {
				key := fmt.Sprint(item)
				if seen[key] {
					return false
				}
				seen[key] = true
			}
		}
		for _, item := range list {
			if !validElicitationValue(items, item) {
				return false
			}
		}
		valid = true
	default:
		return false
	}
	if !valid {
		return false
	}
	if choices, ok := field["enum"].([]any); ok && !containsValue(choices, value, false) {
		return false
	}
	if choices, ok := field["oneOf"].([]any); ok && !containsValue(choices, value, true) {
		return false
	}
	if choices, ok := field["anyOf"].([]any); ok && !containsValue(choices, value, true) {
		return false
	}
	return true
}

// containsValue 比较 enum 值；constOnly 表示选项形如 {"const": ...}。
func containsValue(choices []any, value any, constOnly bool) bool {
	for _, choice := range choices {
		candidate := choice
		if constOnly {
			option, ok := choice.(map[string]any)
			if !ok {
				continue
			}
			candidate = option["const"]
		}
		if equalElicitationValue(candidate, value) {
			return true
		}
	}
	return false
}

func equalElicitationValue(left, right any) bool {
	if a, ok := numberValue(left); ok {
		if b, ok := numberValue(right); ok {
			return a == b
		}
		return false
	}
	return fmt.Sprint(left) == fmt.Sprint(right)
}

func numberValue(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, true
	case float32:
		return float64(number), true
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	case int32:
		return float64(number), true
	default:
		return 0, false
	}
}

func bound(field map[string]any, key string, value float64, minimum bool) bool {
	limit, ok := numberValue(field[key])
	if !ok {
		return true
	}
	if minimum {
		return value >= limit
	}
	return value <= limit
}
