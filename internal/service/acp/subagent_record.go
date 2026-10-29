package acp

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// acpSubAgentRecorder 把外部 ACP Agent 的子代理事件按子会话落盘到
// {parent}.sub/{subSessionId}.jsonl，供右侧子代理面板回放
// （Java AcpSubAgentRecorder）。
//
// 文本增量（sub_content / sub_reasoning）按段聚合后再写，避免每个 token
// 打开一次文件；任何非文本事件先刷出未落盘的文本，保持事件顺序。
type acpSubAgentRecorder struct {
	mu          sync.Mutex
	dir         string
	buffers     map[string]*strings.Builder
	bufferTypes map[string]string
	stamps      map[string]map[string]any
	idle        bool
}

func newACPSubAgentRecorder(dir string) *acpSubAgentRecorder {
	_ = os.MkdirAll(dir, 0o755)
	return &acpSubAgentRecorder{
		dir:         dir,
		buffers:     map[string]*strings.Builder{},
		bufferTypes: map[string]string{},
		stamps:      map[string]map[string]any{},
	}
}

// record 追加一条子代理事件；文本增量先进入缓冲区。
func (r *acpSubAgentRecorder) record(typ string, event map[string]any) {
	if r == nil {
		return
	}
	sub, _ := event["subSessionId"].(string)
	if sub == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stamps[sub] = map[string]any{"subId": event["subId"], "subSessionId": sub}
	if typ == "sub_content" || typ == "sub_reasoning" {
		token, _ := event["token"].(string)
		if token == "" {
			return
		}
		if current := r.bufferTypes[sub]; current != "" && current != typ {
			r.flush(sub)
		}
		r.bufferTypes[sub] = typ
		buffer := r.buffers[sub]
		if buffer == nil {
			buffer = &strings.Builder{}
			r.buffers[sub] = buffer
		}
		buffer.WriteString(token)
		// 根 SSE 轮次可能已经结束，而原生子代理仍在产出文本。
		if r.idle {
			r.flush(sub)
		}
		return
	}
	r.flush(sub)
	if typ == "sub_start" {
		// session/load 会重放历史更新；子代理以开始事件为界重写，
		// 避免回放叠加成重复记录。
		_ = os.Remove(filepath.Join(r.dir, sub+".jsonl"))
	}
	// 每行都带 type，子会话列表与回放按它渲染（Java SubAgentSessionStore）。
	event["type"] = typ
	r.write(sub, event)
}

// finish 在一轮结束时刷出所有未落盘的文本段。
func (r *acpSubAgentRecorder) finish() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.idle = true
	for sub := range r.buffers {
		r.flush(sub)
	}
}

// flush 写出一条聚合后的文本事件（无文本时无操作）。
func (r *acpSubAgentRecorder) flush(sub string) {
	typ := r.bufferTypes[sub]
	buffer := r.buffers[sub]
	delete(r.bufferTypes, sub)
	delete(r.buffers, sub)
	if typ == "" || buffer == nil || buffer.Len() == 0 {
		return
	}
	payload := map[string]any{"type": typ, "token": buffer.String()}
	for key, value := range r.stamps[sub] {
		payload[key] = value
	}
	r.write(sub, payload)
}

func (r *acpSubAgentRecorder) write(sub string, event map[string]any) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	path := filepath.Join(r.dir, sub+".jsonl")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(data, '\n'))
}

// acpSharedState 保存跨轮次的工具与子代理路由状态
// （Java 把 toolNames / toolInputs / subAgentIds 等挂在客户端上）。
type acpSharedState struct {
	mu             sync.Mutex
	toolNames      map[string]string
	toolInputs     map[string]map[string]any
	subOutputs     map[string]*ToolOutput
	subAgents      map[string]bool
	endedSubs      map[string]bool
	subToolParents map[string]string
	reportedFiles  map[string]bool
}

func newACPSharedState() *acpSharedState {
	return &acpSharedState{
		toolNames:      map[string]string{},
		toolInputs:     map[string]map[string]any{},
		subOutputs:     map[string]*ToolOutput{},
		subAgents:      map[string]bool{},
		endedSubs:      map[string]bool{},
		subToolParents: map[string]string{},
		reportedFiles:  map[string]bool{},
	}
}

// toolKey 用子会话前缀区分父子同名工具调用（Java toolKey）。
func toolKey(child, id string) string {
	if child == "" {
		return id
	}
	return child + "\x00" + id
}

// acpSubAgentInfo 是 sub_start 展示用的子代理身份。
type acpSubAgentInfo struct {
	Task  string
	Name  string
	Title string
}

// subAgentInfoOf 从父 Agent/Task 工具的入参推断子代理身份
// （Java subAgentInfo）：task 取 description > prompt > 工具名，
// name 取 subagent_type > name，缺省 "Claude"，title 取 description。
func subAgentInfoOf(input map[string]any, fallback string) acpSubAgentInfo {
	description := firstTextOf(input, "description")
	name := firstTextOf(input, "subagent_type", "name")
	prompt := firstTextOf(input, "prompt")
	task := description
	if task == "" {
		task = prompt
	}
	if task == "" {
		task = fallback
	}
	if strings.TrimSpace(task) == "" {
		task = "子代理"
	}
	if name == "" {
		name = "Claude"
	}
	info := acpSubAgentInfo{Task: clipText(task), Name: clipText(name)}
	if description != "" {
		info.Title = clipText(description)
	}
	return info
}

func firstTextOf(input map[string]any, keys ...string) string {
	for _, key := range keys {
		if text, ok := input[key].(string); ok && strings.TrimSpace(text) != "" {
			return text
		}
	}
	return ""
}

// clipText 折叠空白并截断到 80 个字符。
func clipText(text string) string {
	oneLine := strings.Join(strings.Fields(text), " ")
	runes := []rune(oneLine)
	if len(runes) > 80 {
		return string(runes[:80]) + "…"
	}
	return oneLine
}
