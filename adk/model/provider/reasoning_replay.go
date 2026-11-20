package provider

import (
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"

	"google.golang.org/genai"
)

// ReasoningReplayMetadataKey 是推理续接状态在 genai.Part.PartMetadata
// 中的命名空间。状态随 JSONL 会话的内部 ADK 数据持久化，只在作用域
// 匹配时用于续接请求；历史与审计 API 会剥掉这个键。
const ReasoningReplayMetadataKey = "loopra.reasoningReplay"

// reasoningReplayScope 把续接状态绑定到产出原始响应的目的地：协议、
// 渠道、端点、模型与凭据共同决定状态能否继续使用，任何一项变化
// （换渠道、换模型、换密钥）都会让旧状态失配而不再回放。原始值只
// 作为哈希输入不落盘，避免把 API key 等敏感信息写进会话记录。
func (c Config) reasoningReplayScope(modelName string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{c.Protocol, c.channelID, c.Endpoint, modelName, c.APIKey}, "\x00")))
	return hex.EncodeToString(sum[:])
}

// setReasoningReplay 在部分的私有元数据里记录按作用域隔离的续接值。
func setReasoningReplay(part *genai.Part, scope, key, value string) {
	if part.PartMetadata == nil {
		part.PartMetadata = make(map[string]any)
	}
	part.PartMetadata[ReasoningReplayMetadataKey] = map[string]any{"scope": scope, key: value}
}

// reasoningReplay 读出同作用域下记录的续接值；作用域不匹配
// 或未记录时返回空串。
func reasoningReplay(part *genai.Part, scope, key string) string {
	state, _ := part.PartMetadata[ReasoningReplayMetadataKey].(map[string]any)
	if state["scope"] != scope {
		return ""
	}
	value, _ := state[key].(string)
	return value
}

// chatReasoningField 选择 Chat Completions 网关续接推理时使用的
// 上行字段：OpenRouter 用 reasoning，DeepSeek 用 reasoning_content。
// 未知目的地返回空串表示不回放，保持旧的请求形状。
func (c Config) chatReasoningField(modelName string) string {
	u, _ := url.Parse(c.Endpoint)
	host := ""
	if u != nil {
		host = strings.ToLower(u.Hostname())
	}
	if host == "openrouter.ai" {
		return "reasoning"
	}
	name := strings.ToLower(modelName)
	if host == "api.deepseek.com" || strings.HasPrefix(name, "deepseek-") || strings.HasPrefix(name, "deepseek/") || strings.Contains(name, "/deepseek-") {
		return "reasoning_content"
	}
	return ""
}
