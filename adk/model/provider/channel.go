package provider

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"google.golang.org/genai"

	"google.golang.org/adk/v2/model"
)

// Channel.APIProtocol 接受的协议名，与 Loopra 的 config.json 一致。
const (
	ProtocolChatCompletions = "chat_completions"
	ProtocolResponses       = "responses"
	ProtocolAnthropic       = "anthropic"
)

// SpecialCompatibility 启用按网关的请求微调；目前已知的只有 "opencode"，
// 它通过粘性会话请求头转发请求。
const SpecialOpenCode = "opencode"

// Channel 对应 Loopra config.json 中的一个 modelChannels 条目。
type Channel struct {
	ID                   string       `json:"id"`
	Name                 string       `json:"name"`
	BaseURL              string       `json:"baseUrl"`
	APIKey               string       `json:"apiKey"`
	APIProtocol          string       `json:"apiProtocol"`
	SpecialCompatibility string       `json:"specialCompatibility"`
	Models               []ModelEntry `json:"models"`
}

// ModelEntry 是通道内的一个模型。
type ModelEntry struct {
	Name          string `json:"name"`
	ContextTokens int64  `json:"contextTokens"`
	MaxTokens     int    `json:"maxTokens"`
	ImageInput    bool   `json:"imageInput"`
}

// Entry 返回指定名称的模型条目；name 为空或未知时返回
// 第一个条目，与 Java 的能力回退行为一致。
func (c Channel) Entry(name string) (ModelEntry, bool) {
	if len(c.Models) == 0 {
		return ModelEntry{}, false
	}
	if name != "" {
		for _, m := range c.Models {
			if m.Name == name {
				return m, true
			}
		}
	}
	return c.Models[0], true
}

// Settings 是可热切换的会话级模型选项。Java 的
// LoopraModelProvider 在请求时修改这些选项；适配器在每次
// GenerateContent 调用时读取快照。
type Settings struct {
	mu               sync.Mutex
	reasoningEffort  string
	sessionKey       string
	serviceTierFast  bool
	maxOutputTokens  int
	disableStreaming bool
}

// SettingsSnapshot 是 Settings 的不可变视图。
type SettingsSnapshot struct {
	ReasoningEffort  string
	SessionKey       string
	ServiceTierFast  bool
	MaxOutputTokens  int
	DisableStreaming bool
}

// NewSettings 按初始值构建可热切换的设置。
func NewSettings(reasoningEffort, sessionKey string, serviceTierFast bool, maxOutputTokens int) *Settings {
	return &Settings{reasoningEffort: reasoningEffort, sessionKey: sessionKey, serviceTierFast: serviceTierFast, maxOutputTokens: maxOutputTokens}
}

// Snapshot 在加锁状态下读取当前设置。
func (s *Settings) Snapshot() SettingsSnapshot {
	if s == nil {
		return SettingsSnapshot{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return SettingsSnapshot{
		ReasoningEffort:  s.reasoningEffort,
		SessionKey:       s.sessionKey,
		ServiceTierFast:  s.serviceTierFast,
		MaxOutputTokens:  s.maxOutputTokens,
		DisableStreaming: s.disableStreaming,
	}
}

// Update 原子地替换可变设置。
func (s *Settings) Update(reasoningEffort, sessionKey string, serviceTierFast bool, maxOutputTokens int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reasoningEffort = reasoningEffort
	s.sessionKey = sessionKey
	s.serviceTierFast = serviceTierFast
	if maxOutputTokens > 0 {
		s.maxOutputTokens = maxOutputTokens
	}
}

// Config 承载适配器在单次请求之外所需的全部配置。
type Config struct {
	Endpoint       string
	APIKey         string
	Protocol       string
	Special        string
	DefaultModel   string
	MaxTokens      int
	Headers        map[string]string
	Client         *http.Client
	Settings       *Settings
	InsecureStream bool
}

// DefaultMaxOutputTokens 与 Loopra 配置的默认值一致。
const DefaultMaxOutputTokens = 32768

// NewLLM 为通道构建 model.LLM 适配器。opts.Endpoint 覆盖
// 端点推导结果，opts.Model 固定模型名，opts.Settings（为
// nil 时新建）持有可热切换的会话选项。
func NewLLM(ch Channel, opts *Options) (model.LLM, error) {
	if opts == nil {
		opts = &Options{}
	}
	protocol := strings.ToLower(strings.TrimSpace(ch.APIProtocol))
	switch protocol {
	case "", ProtocolChatCompletions:
		protocol = ProtocolChatCompletions
	case ProtocolResponses, ProtocolAnthropic:
	default:
		return nil, fmt.Errorf("channel %q: unsupported apiProtocol %q", ch.ID, ch.APIProtocol)
	}
	entry, ok := ch.Entry(opts.Model)
	if !ok {
		return nil, fmt.Errorf("channel %q has no model entries", ch.ID)
	}
	name := entry.Name
	if opts.Model != "" {
		name = opts.Model
	}
	maxTokens := entry.MaxTokens
	if maxTokens <= 0 {
		maxTokens = DefaultMaxOutputTokens
	}
	endpoint := opts.Endpoint
	if endpoint == "" {
		derived, err := deriveEndpoint(protocol, ch.BaseURL)
		if err != nil {
			return nil, fmt.Errorf("channel %q: %w", ch.ID, err)
		}
		endpoint = derived
	}
	settings := opts.Settings
	if settings == nil {
		settings = NewSettings(opts.ReasoningEffort, opts.SessionKey, opts.ServiceTierFast, maxTokens)
	}
	cfg := Config{
		Endpoint:     endpoint,
		APIKey:       ch.APIKey,
		Protocol:     protocol,
		Special:      ch.SpecialCompatibility,
		DefaultModel: name,
		MaxTokens:    maxTokens,
		Headers:      opts.Headers,
		Client:       opts.Client,
		Settings:     settings,
	}
	switch protocol {
	case ProtocolResponses:
		return &responsesAdapter{config: cfg}, nil
	case ProtocolAnthropic:
		return &anthropicAdapter{config: cfg}, nil
	default:
		return &chatAdapter{config: cfg}, nil
	}
}

// Options 用于调整 NewLLM 的构建。
type Options struct {
	// Model 固定通道模型；为空时回退到第一个条目。
	Model string
	// Endpoint 覆盖推导出的完整端点 URL。
	Endpoint string
	// ReasoningEffort 取值为 low/medium/high/max 之一。
	ReasoningEffort string
	// SessionKey 携带 opencode 网关的粘性会话值。
	SessionKey string
	// ServiceTierFast 请求 OpenAI 的 "fast" 服务层级。
	ServiceTierFast bool
	// Headers 是额外的固定请求头（如代理场景）。
	Headers map[string]string
	// Client 是可注入的 HTTP 客户端（测试中使用 httptest 服务）。
	Client *http.Client
	// Settings 复用已有的可热切换设置对象。
	Settings *Settings
}

// deriveEndpoint 按协议把通道的 baseUrl 映射为完整端点 URL。
// 已指向最终路径的 base URL 保持不变。
func deriveEndpoint(protocol, baseURL string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if base == "" {
		return "", fmt.Errorf("baseUrl is required")
	}
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") {
		return "", fmt.Errorf("baseUrl must be an http(s) URL, got %q", baseURL)
	}
	switch protocol {
	case ProtocolChatCompletions:
		if strings.HasSuffix(base, "/chat/completions") {
			return base, nil
		}
		return base + "/chat/completions", nil
	case ProtocolResponses:
		if strings.HasSuffix(base, "/responses") {
			return base, nil
		}
		return base + "/responses", nil
	case ProtocolAnthropic:
		if strings.HasSuffix(base, "/messages") {
			return base, nil
		}
		if strings.HasSuffix(base, "/v1") {
			return base + "/messages", nil
		}
		return base + "/v1/messages", nil
	}
	return "", fmt.Errorf("unknown protocol %q", protocol)
}

// authAndExtraHeaders 返回合并了设置快照的固定请求头，
// 并应用特殊兼容行为。
func (c Config) authAndExtraHeaders(snap SettingsSnapshot) (map[string]string, error) {
	headers := headerSnapshot(c.Headers, nil)
	switch c.Protocol {
	case ProtocolAnthropic:
		headers["x-api-key"] = c.APIKey
		headers["anthropic-version"] = "2023-06-01"
	default:
		headers["Authorization"] = "Bearer " + c.APIKey
	}
	if c.Special == SpecialOpenCode && snap.SessionKey != "" {
		headers["x-opencode-session"] = snap.SessionKey
	}
	return headers, nil
}

// effectiveMaxTokens 解析单次调用的输出 token 预算。
func (c Config) effectiveMaxTokens(req *model.LLMRequest, snap SettingsSnapshot) int {
	if req != nil && req.Config != nil && req.Config.MaxOutputTokens > 0 {
		return int(req.Config.MaxOutputTokens)
	}
	if snap.MaxOutputTokens > 0 {
		return snap.MaxOutputTokens
	}
	if c.MaxTokens > 0 {
		return c.MaxTokens
	}
	return DefaultMaxOutputTokens
}

// modelName 解析请求使用的模型，优先采用 req.Model。
func (c Config) modelName(req *model.LLMRequest) string {
	if req != nil && req.Model != "" {
		return req.Model
	}
	return c.DefaultModel
}

// emptyObjectSchema 是不带参数的函数声明所需的占位 schema。
func emptyObjectSchema() map[string]any {
	return map[string]any{"type": "object", "properties": map[string]any{}}
}

// jsonSchemaMap 把任意形态的 JSON schema 归一化成可直接写进请求体的 map。
// ADK 的 functiontool 把 ParametersJsonSchema 设成 *jsonschema.Schema，
// 直接断言 map[string]any 必然失败；失败后整个 parameters 字段会缺失，
// 模型只能靠描述猜参数名与取值。
func jsonSchemaMap(schema any) (map[string]any, bool) {
	if schema == nil {
		return nil, false
	}
	if m, ok := schema.(map[string]any); ok && len(m) > 0 {
		return m, true
	}
	data, err := json.Marshal(schema)
	if err != nil {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var m map[string]any
	if err := decoder.Decode(&m); err != nil || len(m) == 0 {
		return nil, false
	}
	return m, true
}

// schemaMap 把 genai schema 转换为工具参数用的 JSON schema 映射。
func schemaMap(s *genai.Schema) map[string]any {
	if s == nil {
		return emptyObjectSchema()
	}
	m := map[string]any{}
	if t := string(s.Type); t != "" {
		m["type"] = strings.ToLower(t)
	} else {
		m["type"] = "object"
	}
	if s.Description != "" {
		m["description"] = s.Description
	}
	if s.Format != "" {
		m["format"] = s.Format
	}
	if len(s.Enum) > 0 {
		m["enum"] = s.Enum
	}
	if len(s.Required) > 0 {
		m["required"] = append([]string(nil), s.Required...)
	}
	if s.Items != nil {
		m["items"] = schemaMap(s.Items)
	}
	if len(s.AnyOf) > 0 {
		variants := make([]any, 0, len(s.AnyOf))
		for _, v := range s.AnyOf {
			variants = append(variants, schemaMap(v))
		}
		m["anyOf"] = variants
	}
	if len(s.Properties) > 0 {
		props := make(map[string]any, len(s.Properties))
		for k, v := range s.Properties {
			props[k] = schemaMap(v)
		}
		m["properties"] = props
	}
	return m
}

// functionDeclarations 展平请求携带的工具声明。
func functionDeclarations(req *model.LLMRequest) []*genai.FunctionDeclaration {
	if req == nil || req.Config == nil {
		return nil
	}
	var out []*genai.FunctionDeclaration
	for _, t := range req.Config.Tools {
		if t == nil {
			continue
		}
		out = append(out, t.FunctionDeclarations...)
	}
	return out
}

// systemText 提取系统指令文本，以及历史中所有 system/developer
// 内容（developer 内容保留其标签以保持对齐）。
func systemText(req *model.LLMRequest) string {
	var parts []string
	if req != nil && req.Config != nil && req.Config.SystemInstruction != nil {
		if s := contentText(req.Config.SystemInstruction); s != "" {
			parts = append(parts, s)
		}
	}
	if req == nil {
		return strings.Join(parts, "\n\n")
	}
	for _, c := range req.Contents {
		if c == nil || (c.Role != "system" && c.Role != "developer") {
			continue
		}
		s := contentText(c)
		if s == "" {
			continue
		}
		if c.Role == "developer" {
			s = "[developer] " + s
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "\n\n")
}

// contentText 拼接内容中非思考部分的文本。
func contentText(c *genai.Content) string {
	if c == nil {
		return ""
	}
	var sb strings.Builder
	for _, p := range c.Parts {
		if p != nil && p.Text != "" && !p.Thought {
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

// callIDTracker 为未携带 ID 到达的工具调用（Gemini 风格）
// 分配确定性 ID，并让对应的响应复用这些 ID。
type callIDTracker struct {
	assigned map[string]string
	counter  int
}

func newCallIDTracker() *callIDTracker { return &callIDTracker{assigned: map[string]string{}} }

// callID 返回工具调用的 ID，为空时合成一个。
func (t *callIDTracker) callID(fc *genai.FunctionCall) string {
	if fc.ID != "" {
		return fc.ID
	}
	if id, ok := t.assigned[fc.Name]; ok {
		return id
	}
	t.counter++
	id := fmt.Sprintf("%s_%d", fc.Name, t.counter)
	t.assigned[fc.Name] = id
	return id
}

// responseID 返回工具响应应携带的 ID；响应自身未提供时
// 复用合成的调用 ID。
func (t *callIDTracker) responseID(fr *genai.FunctionResponse) string {
	if fr.ID != "" {
		return fr.ID
	}
	if id, ok := t.assigned[fr.Name]; ok {
		return id
	}
	return ""
}

// toolResultText 把工具响应渲染为工具负载文本。
func toolResultText(fr *genai.FunctionResponse) string {
	if fr == nil || fr.Response == nil {
		return "{}"
	}
	if len(fr.Response) == 1 {
		if s, ok := fr.Response["result"].(string); ok {
			return s
		}
	}
	raw, err := json.Marshal(fr.Response)
	if err != nil {
		return "{}"
	}
	return string(raw)
}
