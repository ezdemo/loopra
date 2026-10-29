// Package acp 用 coder/acp-go-sdk 连接外部编码智能体
// （claude-code / codex / pi / dsh），并把会话更新转换为
// Loopra 的事件模型。本文件里的结构是 Loopra 内部事件形状，
// 线上的 JSON-RPC 由 SDK 负责。
package acp

import "encoding/json"

// 协议版本与客户端标识。
const (
	ProtocolVersion = 1
	ClientName      = "loopra-workbench"
)

// 常用 JSON-RPC 方法名。
const (
	MethodInitialize        = "initialize"
	MethodSessionNew        = "session/new"
	MethodSessionLoad       = "session/load"
	MethodSessionResume     = "session/resume"
	MethodSessionFork       = "session/fork"
	MethodSessionPrompt     = "session/prompt"
	MethodSessionCancel     = "session/cancel"
	MethodSessionUpdate     = "session/update"
	MethodSetMode           = "session/set_mode"
	MethodSetModel          = "session/set_model"
	MethodSetConfigOption   = "session/set_config_option"
	MethodRequestPerm       = "session/request_permission"
	MethodElicitationCreate = "elicitation/create"
)

// rpcMessage 是线上的一条 JSON-RPC 消息；id 可能是字符串或数字，
// 因此保留原始 JSON。
type rpcMessage struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

func (e *rpcError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// 内容块。
type ContentBlock struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MIMEType string `json:"mimeType,omitempty"`
	URI      string `json:"uri,omitempty"`
	Name     string `json:"name,omitempty"`
}

// InitializeParams 是 initialize 请求的参数。
type InitializeParams struct {
	ProtocolVersion    int                `json:"protocolVersion"`
	ClientCapabilities ClientCapabilities `json:"clientCapabilities"`
	ClientInfo         Implementation     `json:"clientInfo"`
}

type ClientCapabilities struct {
	FS       FileSystemCapability `json:"fs"`
	Terminal bool                 `json:"terminal"`
	// Subagents 声明客户端能消费原生子会话（Codex）。
	Subagents map[string]any `json:"subagents,omitempty"`
	// Elicitation 声明客户端支持 Agent 反向提问（表单模式）。
	Elicitation map[string]any `json:"elicitation,omitempty"`
	Meta        map[string]any `json:"_meta,omitempty"`
}

type FileSystemCapability struct {
	ReadTextFile  bool `json:"readTextFile"`
	WriteTextFile bool `json:"writeTextFile"`
}

type Implementation struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Title   string `json:"title,omitempty"`
}

// InitializeResult 是 initialize 的结果。
type InitializeResult struct {
	ProtocolVersion   int               `json:"protocolVersion"`
	AgentCapabilities AgentCapabilities `json:"agentCapabilities"`
	AgentInfo         *Implementation   `json:"agentInfo,omitempty"`
	AuthMethods       []AuthMethod      `json:"authMethods,omitempty"`
}

type AgentCapabilities struct {
	LoadSession         bool           `json:"loadSession,omitempty"`
	PromptCapabilities  map[string]any `json:"promptCapabilities,omitempty"`
	MCPCapabilities     map[string]any `json:"mcpCapabilities,omitempty"`
	SessionCapabilities map[string]any `json:"sessionCapabilities,omitempty"`
	Meta                map[string]any `json:"_meta,omitempty"`
}

type AuthMethod struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// NewSessionParams 是 session/new 的参数。
type NewSessionParams struct {
	Cwd                   string   `json:"cwd"`
	McpServers            []any    `json:"mcpServers"`
	AdditionalDirectories []string `json:"additionalDirectories,omitempty"`
}

// LoadSessionParams 是 session/load 与 session/resume 的参数。
type LoadSessionParams struct {
	SessionID             string   `json:"sessionId"`
	Cwd                   string   `json:"cwd"`
	McpServers            []any    `json:"mcpServers"`
	AdditionalDirectories []string `json:"additionalDirectories,omitempty"`
}

// ForkSessionParams 是 session/fork 的参数；_meta 携带
// jetbrains.air.fork 分叉点（AcpForkPoint）。
type ForkSessionParams struct {
	SessionID             string         `json:"sessionId"`
	Cwd                   string         `json:"cwd"`
	McpServers            []any          `json:"mcpServers"`
	AdditionalDirectories []string       `json:"additionalDirectories,omitempty"`
	Meta                  map[string]any `json:"_meta,omitempty"`
}

// SessionSetupResult 是 session/new（以及 load）结果中
// 客户端会用到的部分。
type SessionSetupResult struct {
	SessionID     string         `json:"sessionId"`
	ConfigOptions []ConfigOption `json:"configOptions,omitempty"`
	Modes         *SessionModes  `json:"modes,omitempty"`
	Models        *SessionModels `json:"models,omitempty"`
}

type SessionModes struct {
	CurrentModeID  string        `json:"currentModeId"`
	AvailableModes []SessionMode `json:"availableModes"`
}

type SessionMode struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type SessionModels struct {
	CurrentModelID  string         `json:"currentModelId"`
	AvailableModels []SessionModel `json:"availableModels"`
}

type SessionModel struct {
	ModelID     string `json:"modelId"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// ConfigOption 是 Agent 暴露的会话配置项。
type ConfigOption struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Description  string              `json:"description,omitempty"`
	Category     string              `json:"category,omitempty"`
	Type         string              `json:"type"` // select | boolean
	CurrentValue any                 `json:"currentValue"`
	Options      []ConfigOptionValue `json:"options,omitempty"`
}

type ConfigOptionValue struct {
	Value       any    `json:"value"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Group       string `json:"group,omitempty"`
}

// UnmarshalJSON 展平 ACP 的分组选项：组节点只有 name/options，
// 组内选项继承组名作为 group（Java AcpConfigOption.readValues）。
func (o *ConfigOption) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID           string          `json:"id"`
		Name         string          `json:"name"`
		Description  string          `json:"description"`
		Category     string          `json:"category"`
		Type         string          `json:"type"`
		CurrentValue any             `json:"currentValue"`
		Options      json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	o.ID, o.Name, o.Description, o.Category = raw.ID, raw.Name, raw.Description, raw.Category
	o.Type, o.CurrentValue = raw.Type, raw.CurrentValue
	if len(raw.Options) > 0 {
		values, err := readConfigValues(raw.Options, "")
		if err != nil {
			return err
		}
		o.Options = values
	}
	return nil
}

func readConfigValues(raw json.RawMessage, group string) ([]ConfigOptionValue, error) {
	var items []map[string]any
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	values := make([]ConfigOptionValue, 0, len(items))
	for _, item := range items {
		if nested, ok := item["options"]; ok {
			name, _ := item["name"].(string)
			encoded, err := json.Marshal(nested)
			if err != nil {
				continue
			}
			children, err := readConfigValues(encoded, name)
			if err != nil {
				continue
			}
			values = append(values, children...)
			continue
		}
		value, ok := item["value"].(string)
		if !ok {
			continue
		}
		name, _ := item["name"].(string)
		description, _ := item["description"].(string)
		values = append(values, ConfigOptionValue{
			Value: value, Name: name, Description: description, Group: group,
		})
	}
	return values, nil
}

// PromptParams 是 session/prompt 的参数。
type PromptParams struct {
	SessionID string         `json:"sessionId"`
	Prompt    []ContentBlock `json:"prompt"`
	Meta      map[string]any `json:"_meta,omitempty"`
}

// PromptResult 是 session/prompt 的结果。
type PromptResult struct {
	StopReason string `json:"stopReason"`
}

// CancelParams 是 session/cancel 通知（无 id）。
type CancelParams struct {
	SessionID string `json:"sessionId"`
}

// SetModeParams / SetModelParams / SetConfigOptionParams 是配套设置请求。
type SetModeParams struct {
	SessionID string `json:"sessionId"`
	ModeID    string `json:"modeId"`
}

type SetModelParams struct {
	SessionID string `json:"sessionId"`
	ModelID   string `json:"modelId"`
}

type SetConfigOptionParams struct {
	SessionID string `json:"sessionId"`
	ConfigID  string `json:"configId"`
	Value     any    `json:"value"`
	ValueType string `json:"type,omitempty"`
}

// SessionNotification 是 session/update 通知的参数。
type SessionNotification struct {
	SessionID string          `json:"sessionId"`
	Update    json.RawMessage `json:"update"`
}

// SessionUpdate 是会话更新的公共外壳；具体字段按 SessionUpdate 分派。
// content 在消息增量里是单个内容块，在工具调用里是内容块数组，
// 因此保留原始 JSON，由 ChunkContent / ToolContent 解析。
type SessionUpdate struct {
	SessionUpdate string `json:"sessionUpdate"`

	Content json.RawMessage `json:"content,omitempty"`

	// tool_call / tool_call_update
	ToolCallID string         `json:"toolCallId,omitempty"`
	Title      string         `json:"title,omitempty"`
	Kind       string         `json:"kind,omitempty"`
	Status     string         `json:"status,omitempty"`
	Locations  []ToolLocation `json:"locations,omitempty"`
	RawInput   any            `json:"rawInput,omitempty"`
	RawOutput  any            `json:"rawOutput,omitempty"`

	// plan
	Entries []PlanEntry `json:"entries,omitempty"`

	// available_commands_update
	AvailableCommands []Command `json:"availableCommands,omitempty"`

	// current_mode_update
	CurrentModeID string `json:"currentModeId,omitempty"`

	// config_option_update
	ConfigOptions []ConfigOption `json:"configOptions,omitempty"`

	// usage_update
	Used int64      `json:"used,omitempty"`
	Size int64      `json:"size,omitempty"`
	Cost *UsageCost `json:"cost,omitempty"`

	// subagent_spawned / subagent_state_update（原生子会话）
	SubagentSessionID string `json:"subagentSessionId,omitempty"`
	Name              string `json:"name,omitempty"`
	Task              string `json:"task,omitempty"`
	State             string `json:"state,omitempty"`
	Message           string `json:"message,omitempty"`

	// 子代理扩展（loopra.dev）。
	Meta map[string]any `json:"_meta,omitempty"`
}

// ChunkContent 解析消息增量携带的单个内容块。
func (u SessionUpdate) ChunkContent() (ContentBlock, bool) {
	if len(u.Content) == 0 || string(u.Content) == "null" {
		return ContentBlock{}, false
	}
	var block ContentBlock
	if err := json.Unmarshal(u.Content, &block); err != nil {
		return ContentBlock{}, false
	}
	return block, true
}

// ToolContent 解析工具调用携带的内容块数组。
func (u SessionUpdate) ToolContent() []ToolCallItem {
	if len(u.Content) == 0 || string(u.Content) == "null" {
		return nil
	}
	var items []ToolCallItem
	if err := json.Unmarshal(u.Content, &items); err != nil {
		return nil
	}
	return items
}

type ToolCallItem struct {
	Type       string        `json:"type"`
	Content    *ContentBlock `json:"content,omitempty"`
	Path       string        `json:"path,omitempty"`
	OldText    *string       `json:"oldText,omitempty"`
	NewText    string        `json:"newText,omitempty"`
	TerminalID string        `json:"terminalId,omitempty"`
}

type ToolLocation struct {
	Path string `json:"path"`
	Line *int   `json:"line,omitempty"`
}

type PlanEntry struct {
	Content  string `json:"content"`
	Priority string `json:"priority"`
	Status   string `json:"status"`
}

type Command struct {
	Name        string        `json:"name"`
	Description string        `json:"description,omitempty"`
	Input       *CommandInput `json:"input,omitempty"`
}

type CommandInput struct {
	Hint string `json:"hint,omitempty"`
}

type UsageCost struct {
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

// PermissionRequest 是 Agent 发来的 session/request_permission 请求。
type PermissionRequest struct {
	SessionID string             `json:"sessionId"`
	ToolCall  ToolCallRef        `json:"toolCall"`
	Options   []PermissionOption `json:"options"`
	Meta      map[string]any     `json:"_meta,omitempty"`
}

type ToolCallRef struct {
	ToolCallID string `json:"toolCallId"`
	Title      string `json:"title,omitempty"`
	Kind       string `json:"kind,omitempty"`
	Status     string `json:"status,omitempty"`
	RawInput   any    `json:"rawInput,omitempty"`
}

type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"` // allow_once | allow_always | reject_once | reject_always
}

// ElicitationRequest 是 Agent 发来的 elicitation/create 请求。
type ElicitationRequest struct {
	SessionID       string         `json:"sessionId"`
	Message         string         `json:"message"`
	RequestedSchema map[string]any `json:"requestedSchema"`
	Mode            string         `json:"mode,omitempty"`
	Meta            map[string]any `json:"_meta,omitempty"`
}

// ElicitationResult 是 elicitation/create 的结果：accept / decline / cancel。
type ElicitationResult struct {
	Action  string         `json:"action"`
	Content map[string]any `json:"content,omitempty"`
}

// PermissionResponse 是权限请求的结果：选中某个选项，或取消。
type PermissionResponse struct {
	Outcome PermissionOutcome `json:"outcome"`
}

type PermissionOutcome struct {
	Outcome  string `json:"outcome"` // selected | cancelled
	OptionID string `json:"optionId,omitempty"`
}
