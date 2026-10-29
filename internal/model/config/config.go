// Package config 定义 Loopra 的配置模型和默认值，字段与
// Java 后端兼容（docs/SSE_AND_STORAGE_CONTRACT.md §5.1）。
package config

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
)

// Price 是单个模型每百万 token 的价格。
type Price struct {
	Input  float64 `json:"input"`
	Cache  float64 `json:"cache"`
	Output float64 `json:"output"`
}

func (p *Price) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for name, target := range map[string]*float64{"input": &p.Input, "cache": &p.Cache, "output": &p.Output} {
		raw, ok := fields[name]
		if !ok {
			continue
		}
		var text string
		if json.Unmarshal(raw, &text) == nil {
			value, err := strconv.ParseFloat(text, 64)
			if err != nil {
				return err
			}
			if math.IsNaN(value) || math.IsInf(value, 0) {
				return fmt.Errorf("invalid model price: %s", name)
			}
			*target = value
		} else if err := json.Unmarshal(raw, target); err != nil {
			return err
		}
	}
	return nil
}

// ModelEntry 是某个渠道内的一个模型。
type ModelEntry struct {
	Name          string `json:"name"`
	DisplayName   string `json:"displayName,omitempty"`
	ContextTokens int64  `json:"contextTokens"`
	MaxTokens     int    `json:"maxTokens"`
	ImageInput    bool   `json:"imageInput"`
	Price         *Price `json:"price,omitempty"`
}

func (m *ModelEntry) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '"' {
		m.ContextTokens, m.MaxTokens = -1, -1
		return json.Unmarshal(data, &m.Name)
	}
	type plain ModelEntry
	m.ContextTokens, m.MaxTokens = -1, -1
	return json.Unmarshal(data, (*plain)(m))
}

// Channel 是 modelChannels 中的一项。
type Channel struct {
	ID                   string       `json:"id"`
	Name                 string       `json:"name"`
	BaseURL              string       `json:"baseUrl"`
	APIKey               string       `json:"apiKey"`
	APIProtocol          string       `json:"apiProtocol"`
	SpecialCompatibility string       `json:"specialCompatibility"`
	Models               []ModelEntry `json:"models"`
}

// Compaction 调整上下文折叠窗口。
type Compaction struct {
	ThresholdRatio    float64         `json:"thresholdRatio"`
	RetainRatio       float64         `json:"retainRatio"`
	CompactionRetries int             `json:"compactionRetries"`
	ToolResultPrune   ToolResultPrune `json:"toolResultPrune"`
}

// ToolResultPrune 在折叠前限制过大的工具结果。
type ToolResultPrune struct {
	ThresholdChars int `json:"thresholdChars"`
	HeadChars      int `json:"headChars"`
	TailChars      int `json:"tailChars"`
}

// Loopra 对应 ~/.loopra/config.json。
type Loopra struct {
	BaseURL                          string                     `json:"baseUrl"`
	APIKey                           string                     `json:"apiKey"`
	Proxy                            string                     `json:"proxy"`
	Model                            string                     `json:"model"`
	ModelChannelID                   string                     `json:"modelChannelId"`
	APIProtocol                      string                     `json:"apiProtocol,omitempty"`
	ValidationModel                  string                     `json:"validationModel"`
	ValidationModelChannelID         string                     `json:"validationModelChannelId"`
	ImageUnderstandingModel          string                     `json:"imageUnderstandingModel"`
	ImageUnderstandingModelChannelID string                     `json:"imageUnderstandingModelChannelId"`
	ToolModel                        string                     `json:"toolModel"`
	ToolModelChannelID               string                     `json:"toolModelChannelId"`
	ModelChannels                    []Channel                  `json:"modelChannels"`
	EditMode                         string                     `json:"editMode"`
	ReasoningEffort                  string                     `json:"reasoningEffort"`
	Lang                             string                     `json:"lang"`
	Hitl                             string                     `json:"hitl"`
	AutoWhitelist                    []string                   `json:"autoWhitelist"`
	MaxContextChars                  int                        `json:"maxContextChars"`
	KeepTailChars                    int                        `json:"keepTailChars"`
	ContextCompaction                Compaction                 `json:"contextCompaction"`
	ToolTimeoutSec                   int                        `json:"toolTimeoutSec"`
	SubAgentTimeoutSec               int                        `json:"subAgentTimeoutSec"`
	MaxSelfCorrectionAttempts        int                        `json:"maxSelfCorrectionAttempts"`
	MaxStreamErrorRetries            int                        `json:"maxStreamErrorRetries"`
	FlushIntervalSec                 int                        `json:"flushIntervalSec"`
	FoldHeadCharsLimit               int                        `json:"foldHeadCharsLimit"`
	StormWindowSize                  int                        `json:"stormWindowSize"`
	StormThreshold                   int                        `json:"stormThreshold"`
	ToolResultTruncateChars          int                        `json:"toolResultTruncateChars"`
	ToolResultKeepChars              int                        `json:"toolResultKeepChars"`
	Price                            map[string]Price           `json:"price,omitempty"`
	DisabledTools                    []string                   `json:"disabledTools"`
	DisabledPlugins                  []string                   `json:"disabledPlugins,omitempty"`
	ToolReadOnlyOverrides            map[string]bool            `json:"toolReadOnlyOverrides,omitempty"`
	BlockedPaths                     []string                   `json:"blockedPaths"`
	FastMode                         bool                       `json:"fastMode"`
	AvailableModels                  []string                   `json:"availableModels,omitempty"`
	WorkspaceDir                     string                     `json:"workspaceDir,omitempty"`
	WorktreeBaseDir                  string                     `json:"worktreeBaseDir,omitempty"`
	ActivePet                        string                     `json:"activePet,omitempty"`
	WorkspaceOrder                   []string                   `json:"workspaceOrder"`
	Extra                            map[string]json.RawMessage `json:"-"`

	// SessionOrders 承载动态的 sessionOrder:<workspaceHash> 键
	//（由 Save 持久化在 JSON 顶层，从不通过 tag 写出）。
	SessionOrders map[string][]string `json:"-"`
}

// 编辑 config.json 时保留本运行时无法识别的 Java 设置。
func (c *Loopra) UnmarshalJSON(data []byte) error {
	type plain Loopra
	var normalized map[string]json.RawMessage
	if err := json.Unmarshal(data, &normalized); err != nil {
		return err
	}
	if _, hasChannels := normalized["modelChannels"]; !hasChannels {
		for _, key := range []string{"baseUrl", "apiKey", "model"} {
			if _, legacy := normalized[key]; legacy {
				c.ModelChannels = nil
				break
			}
		}
	}
	if raw, ok := normalized["hitl"]; ok {
		var legacy bool
		if json.Unmarshal(raw, &legacy) == nil {
			normalized["hitl"], _ = json.Marshal(strconv.FormatBool(legacy))
		}
	}
	payload, err := json.Marshal(normalized)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(payload, (*plain)(c)); err != nil {
		return err
	}
	raw := map[string]json.RawMessage{}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	typ := reflect.TypeOf(plain{})
	for i := 0; i < typ.NumField(); i++ {
		name := strings.Split(typ.Field(i).Tag.Get("json"), ",")[0]
		if name != "-" {
			delete(raw, name)
		}
	}
	c.Extra = raw
	for key, value := range raw {
		if hash, ok := strings.CutPrefix(key, "sessionOrder:"); ok {
			var names []string
			if json.Unmarshal(value, &names) == nil {
				if c.SessionOrders == nil {
					c.SessionOrders = map[string][]string{}
				}
				c.SessionOrders[hash] = names
			}
		}
	}
	c.normalize()
	return nil
}

func (c Loopra) MarshalJSON() ([]byte, error) {
	type plain Loopra
	data, err := json.Marshal(plain(c))
	if err != nil {
		return nil, err
	}
	obj := map[string]json.RawMessage{}
	_ = json.Unmarshal(data, &obj)
	for key, value := range c.Extra {
		if _, known := obj[key]; !known {
			obj[key] = value
		}
	}
	for hash, names := range c.SessionOrders {
		value, err := json.Marshal(names)
		if err != nil {
			return nil, err
		}
		obj["sessionOrder:"+hash] = value
	}
	return json.Marshal(obj)
}

func (c *Loopra) Clone() *Loopra {
	data, _ := json.Marshal(c)
	var out Loopra
	_ = json.Unmarshal(data, &out)
	return &out
}

// DefaultAutoWhitelist 对应 Java 默认的自动批准工具集合。
var DefaultAutoWhitelist = []string{
	"read", "write", "edit", "rg", "sub_agent",
	"goal_create", "goal_status", "goal_update_step", "goal_complete",
	"goal_block", "goal_resume", "checklist_start", "checklist_step",
	"checklist_status", "workspace_read", "workspace_write", "workspace_list",
	"memory", "web", "skillread",
	"skilllist", "skillrefresh", "ask_choice", "submit_plan",
}

// Default 返回与 Java 兼容的默认配置。
func Default() Loopra {
	return Loopra{
		BaseURL:        "https://api.deepseek.com/v1",
		Model:          "deepseek-v4-flash",
		ModelChannelID: "default",
		ModelChannels: []Channel{{
			ID: "default", Name: "Default", BaseURL: "https://api.deepseek.com/v1",
			APIProtocol: "chat_completions",
			Models:      []ModelEntry{{Name: "deepseek-v4-flash", ContextTokens: -1, MaxTokens: -1, ImageInput: false}},
		}},
		EditMode:        "auto",
		ReasoningEffort: "high",
		Lang:            "ZH",
		Hitl:            "free",
		AutoWhitelist:   append([]string(nil), DefaultAutoWhitelist...),
		MaxContextChars: 200000,
		KeepTailChars:   80000,
		ContextCompaction: Compaction{
			ThresholdRatio: 0.8, RetainRatio: 0.16, CompactionRetries: 1,
			ToolResultPrune: ToolResultPrune{ThresholdChars: 8192, HeadChars: 4096, TailChars: 1024},
		},
		ToolTimeoutSec:            360,
		SubAgentTimeoutSec:        3600,
		MaxSelfCorrectionAttempts: 5,
		MaxStreamErrorRetries:     10,
		FlushIntervalSec:          30,
		FoldHeadCharsLimit:        60000,
		StormWindowSize:           6,
		StormThreshold:            3,
		ToolResultTruncateChars:   16000,
		ToolResultKeepChars:       12000,
		BlockedPaths:              []string{},
		DisabledTools:             []string{},
	}
}

// normalize 修正 Java 加载器同样会修补的遗留取值。
func (c *Loopra) normalize() {
	if len(c.ModelChannels) == 0 {
		id := c.ModelChannelID
		if id == "" {
			id = "default"
			c.ModelChannelID = id
		}
		names := append([]string{}, c.AvailableModels...)
		if len(names) == 0 && c.Model != "" {
			names = append(names, c.Model)
		}
		models := []ModelEntry{}
		for _, name := range names {
			models = append(models, ModelEntry{Name: name, ContextTokens: -1, MaxTokens: -1})
		}
		c.ModelChannels = []Channel{{ID: id, Name: "Default", BaseURL: c.BaseURL, APIKey: c.APIKey, APIProtocol: c.APIProtocol, Models: models}}
	}
	if c.Hitl == "true" {
		c.Hitl = "approval"
	}
	if c.Hitl == "false" {
		c.Hitl = "free"
	}
	for i, name := range c.AutoWhitelist {
		if name == "task" {
			c.AutoWhitelist[i] = "sub_agent"
		}
		if name == "goal_mark_step" {
			c.AutoWhitelist[i] = "goal_update_step"
		}
	}
}

// ChannelByID 按 id 解析渠道，找不到时回退到当前渠道。
func (c *Loopra) ChannelByID(id string) (Channel, bool) {
	if id == "" {
		id = c.ModelChannelID
	}
	for _, ch := range c.ModelChannels {
		if ch.ID == id {
			return ch, true
		}
	}
	if id == "default" && len(c.ModelChannels) > 0 {
		return c.ModelChannels[0], true
	}
	return Channel{}, false
}
