package acp

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/service/hitl"
)

// acpTool 记录一次工具调用的累计输出与时间。
type acpTool struct {
	name      string
	output    string
	rawInput  map[string]any
	startedAt int64
	finished  bool
	failed    bool
	diffs     []FileChange
	out       *ToolOutput
}

// acpTurn 是一次外部 Agent 轮次的转录与事件状态。
type acpTurn struct {
	host    SessionHost
	sink    EventSink
	session string
	agentID string
	cwd     string
	msgID   string

	runCtx    context.Context
	startedAt int64
	mu        sync.Mutex
	text      strings.Builder
	reasoning strings.Builder
	calls     []map[string]any
	tools     map[string]*acpTool
	state     *acpSharedState
	subRec    *acpSubAgentRecorder
	started   bool
	usage     map[string]any
	finished  bool

	contentChunks  int
	reasoningBytes int
	toolCount      int
}

// counters 返回本轮的内容分片、思考字数与工具数，供结束日志使用。
func (t *acpTurn) counters() (int, int, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.contentChunks, t.reasoningBytes, t.toolCount
}

// handle 处理一条 ACP 更新。
func (t *acpTurn) handle(event Event) {
	// 原生子会话（Codex）：生命周期事件与子会话归属的更新单独处理。
	if event.Kind == EventSubSpawned || event.Kind == EventSubState {
		t.handleSubLifecycle(event)
		return
	}
	if event.SubSession != "" {
		t.handleChild(event)
		return
	}
	// 只有消息/思考/工具会带父级标记；plan/usage/config/native
	// 即使带 parentToolUseId 也走根处理（Java 只对这几类做父级路由）。
	// 父工具把 parentToolUseId 指向自身时按根事件处理。
	if event.Kind == EventContent || event.Kind == EventReason || event.Kind == EventToolCall {
		if parent := event.ParentToolUseID(); parent != "" && !(event.Tool != nil && event.Tool.ToolCallID == parent) {
			t.handleSub(parent, event)
			return
		}
	}
	switch event.Kind {
	case EventContent:
		t.mu.Lock()
		t.text.WriteString(event.Text)
		t.contentChunks++
		t.mu.Unlock()
		t.sink.SendText("content", event.Text)
	case EventReason:
		t.mu.Lock()
		t.reasoning.WriteString(event.Text)
		t.reasoningBytes += len(event.Text)
		started := t.started
		t.started = true
		t.mu.Unlock()
		if !started {
			t.sink.Send("reasoning_started", map[string]any{})
		}
		t.sink.SendText("reasoning", event.Text)
	case EventToolCall:
		t.handleTool(event.Tool)
	case EventPlan:
		t.sink.Send("acp_plan", map[string]any{"entries": event.Plan})
		t.host.SetMeta(t.session, map[string]any{"acpPlan": event.Plan})
	case EventCommands:
		commands := commandPayload(event.Commands)
		t.sink.Send("acp_commands", map[string]any{"commands": commands})
		t.host.SetMeta(t.session, map[string]any{"acpCommands": commands})
	case EventConfig:
		t.sink.Send("config_options", map[string]any{"configOptions": event.ConfigOptions})
		t.host.SetMeta(t.session, map[string]any{"agentConfig": configValues(event.ConfigOptions)})
	case EventMode:
		if event.Mode != "" {
			t.sink.Send("mode_changed", map[string]any{"mode": event.Mode})
		}
	case EventUsage:
		t.mu.Lock()
		payload := map[string]any{}
		if t.usage != nil {
			for key, value := range t.usage {
				payload[key] = value
			}
		}
		// used/size 是当前上下文占用；压缩轮次的更新可能省略 cost/model，
		// 此时沿用上一次值，避免用量面板回退（Java reportUsage）。
		if event.Used >= 0 {
			payload["used"] = event.Used
		}
		if event.Size > 0 {
			payload["size"] = event.Size
		}
		if event.Cost != nil {
			payload["cost"] = event.Cost.Amount
			payload["currency"] = event.Cost.Currency
		}
		if event.Model != "" {
			payload["model"] = event.Model
		}
		t.usage = payload
		t.mu.Unlock()
		t.sink.Send("usage", payload)
		t.host.SetMeta(t.session, map[string]any{"acpUsage": payload})
	case EventNative:
		t.sendNative(event.NativeType, event.NativeData)
	}
}

// handleChild 处理已登记原生子会话（Codex child session）的普通更新。
func (t *acpTurn) handleChild(event Event) {
	switch event.Kind {
	case EventContent, EventReason, EventToolCall:
		t.handleSub(event.SubSession, event)
	case EventPlan:
		if len(event.Plan) == 0 {
			return
		}
		t.sendSub("sub_plan", map[string]any{
			"subId": event.SubSession, "subSessionId": subSessionID(event.SubSession),
			"entries": event.Plan,
		})
	}
}

// handleSubLifecycle 处理 subagent_spawned / subagent_state_update
// （Java acceptChildLifecycle）。
func (t *acpTurn) handleSubLifecycle(event Event) {
	update := event.Subagent
	if update == nil || update.SubagentSessionID == "" {
		return
	}
	child := update.SubagentSessionID
	subID := subSessionID(child)
	st := t.state
	switch event.Kind {
	case EventSubSpawned:
		st.mu.Lock()
		if st.subAgents[child] {
			st.mu.Unlock()
			return
		}
		st.subAgents[child] = true
		delete(st.endedSubs, child)
		st.mu.Unlock()
		name := strings.TrimSpace(update.Name)
		if name == "" {
			name = "Codex"
		}
		task := strings.TrimSpace(update.Task)
		start := map[string]any{
			"subId": child, "subSessionId": subID,
			"name": clipText(name), "task": "子代理",
			"startedAt": time.Now().UnixMilli(),
		}
		if task != "" {
			start["task"] = clipText(task)
			start["title"] = clipText(task)
		}
		t.sendSub("sub_start", start)
	case EventSubState:
		status := ""
		switch update.State {
		case "completed":
			status = "completed"
		case "failed":
			status = "error"
		case "cancelled", "disconnected":
			status = "aborted"
		}
		st.mu.Lock()
		active := st.subAgents[child] && !st.endedSubs[child]
		if status == "" || !active {
			st.mu.Unlock()
			return
		}
		st.endedSubs[child] = true
		st.mu.Unlock()
		if message := strings.TrimSpace(update.Message); message != "" {
			t.sendSub("sub_content", map[string]any{"subId": child, "subSessionId": subID, "token": message})
		}
		end := map[string]any{
			"subId": child, "subSessionId": subID,
			"status": status, "endedAt": time.Now().UnixMilli(),
		}
		if status == "error" {
			end["error"] = "子代理执行失败"
		}
		t.sendSub("sub_end", end)
	}
}

// handleSub 把子代理更新路由成 sub_* 事件，并落盘子会话日志。
func (t *acpTurn) handleSub(parent string, event Event) {
	t.mu.Lock()
	tool := t.tools[parent]
	fallback, input := "", map[string]any(nil)
	if tool != nil {
		fallback, input = tool.name, tool.rawInput
	}
	t.mu.Unlock()

	st := t.state
	st.mu.Lock()
	first := !st.subAgents[parent]
	if first {
		st.subAgents[parent] = true
		delete(st.endedSubs, parent)
	}
	if fallback == "" {
		fallback = st.toolNames[toolKey("", parent)]
	}
	if input == nil {
		input = st.toolInputs[toolKey("", parent)]
	}
	st.mu.Unlock()

	subID := subSessionID(parent)
	if first {
		info := subAgentInfoOf(input, fallback)
		start := map[string]any{
			"subId": parent, "subSessionId": subID,
			"task": info.Task, "name": info.Name,
			"startedAt": time.Now().UnixMilli(),
		}
		if info.Title != "" {
			start["title"] = info.Title
		}
		t.sendSub("sub_start", start)
	}
	switch event.Kind {
	case EventContent:
		t.sendSub("sub_content", map[string]any{"subId": parent, "subSessionId": subID, "token": event.Text})
	case EventReason:
		t.sendSub("sub_reasoning", map[string]any{"subId": parent, "subSessionId": subID, "token": event.Text})
	case EventToolCall:
		t.handleSubTool(parent, subID, event.Tool)
	}
}

// handleSubTool 把子代理内的工具调用转成 sub_tool_call / sub_tool_update /
// sub_tool_result，并按 latest-wins 采集文件改动。
func (t *acpTurn) handleSubTool(parent, subID string, update *SessionUpdate) {
	if update == nil || update.ToolCallID == "" {
		return
	}
	st := t.state
	st.mu.Lock()
	key := toolKey(parent, update.ToolCallID)
	name := toolDisplayName(update)
	if update.Title == "" {
		if previous := st.toolNames[key]; previous != "" {
			name = previous
		}
	}
	st.toolNames[key] = name
	if input, ok := update.RawInput.(map[string]any); ok {
		st.toolInputs[key] = input
	}
	// 记住工具归属，供子代理审批（sub_choice）反查。
	st.subToolParents[update.ToolCallID] = parent
	out := st.subOutputs[key]
	if out == nil {
		out = &ToolOutput{}
		st.subOutputs[key] = out
	}
	previous := out.Text()
	out.Update(update.RawOutput, update.ToolContent(), update.Meta)
	result := out.Text()
	failed := update.Status == "failed" || out.Failed()
	st.mu.Unlock()

	args := toolInputJSON(update)
	if update.SessionUpdate == "tool_call" {
		t.sendSub("sub_tool_call", map[string]any{
			"subId": parent, "subSessionId": subID,
			"toolCallId": update.ToolCallID, "name": name, "args": args,
		})
	} else if update.RawInput != nil || update.Title != "" {
		t.sendSub("sub_tool_update", map[string]any{
			"subId": parent, "subSessionId": subID,
			"toolCallId": update.ToolCallID, "name": name, "args": args,
		})
	}
	if update.Status != "completed" && update.Status != "failed" {
		if result != previous {
			t.sendSub("sub_tool_update", map[string]any{
				"subId": parent, "subSessionId": subID,
				"toolCallId": update.ToolCallID, "result": result,
			})
		}
		return
	}
	status := "completed"
	if failed {
		status = "failed"
	}
	t.sendSub("sub_tool_result", map[string]any{
		"subId": parent, "subSessionId": subID,
		"toolCallId": update.ToolCallID, "name": name, "result": result, "status": status,
	})
	if !failed {
		t.reportFileChanges(update.ToolCallID, collectFileChanges(update))
	}
}

// sendSub 同时写 SSE 与子会话日志。
func (t *acpTurn) sendSub(typ string, payload map[string]any) {
	if _, ok := payload["subSessionId"]; !ok {
		if id, ok := payload["subId"].(string); ok {
			payload["subSessionId"] = subSessionID(id)
		}
	}
	t.sink.Send(typ, payload)
	if t.subRec != nil {
		t.subRec.record(typ, payload)
	}
}

// endActiveSubAgents 为所有未结束的子代理补发 sub_end
// （Java endActiveSubAgents）；取消/关闭时使用。
func (t *acpTurn) endActiveSubAgents(status string) {
	st := t.state
	st.mu.Lock()
	ids := make([]string, 0, len(st.subAgents))
	for id := range st.subAgents {
		if st.endedSubs[id] {
			continue
		}
		st.endedSubs[id] = true
		ids = append(ids, id)
	}
	st.mu.Unlock()
	for _, id := range ids {
		t.sendSub("sub_end", map[string]any{
			"subId": id, "subSessionId": subSessionID(id),
			"status": status, "endedAt": time.Now().UnixMilli(),
		})
	}
}

// handleTool 把工具调用更新转成 tool_call / tool_update / tool_result / file_changes。
func (t *acpTurn) handleTool(update *SessionUpdate) {
	if update == nil || update.ToolCallID == "" {
		return
	}
	t.mu.Lock()
	tool := t.tools[update.ToolCallID]
	created := tool == nil
	if created {
		tool = &acpTool{
			name: toolDisplayName(update), startedAt: time.Now().UnixMilli(),
			out: &ToolOutput{},
		}
		t.tools[update.ToolCallID] = tool
		t.toolCount++
	} else if title := strings.TrimSpace(update.Title); title != "" {
		// 后续更新带标题时以标题为准（Java toolName 的 title 优先）。
		tool.name = toolDisplayName(update)
	}
	if input, ok := update.RawInput.(map[string]any); ok {
		tool.rawInput = input
	}
	previousOutput := tool.out.Text()
	tool.out.Update(update.RawOutput, update.ToolContent(), update.Meta)
	output := tool.out.Text()
	failed := update.Status == "failed" || tool.out.Failed()
	if changes := collectFileChanges(update); len(changes) > 0 {
		// 只保留最新一次 diff：Edit 先发片段、PostToolUse 再发最终 patch。
		tool.diffs = changes
	}
	name := tool.name
	startedAt := tool.startedAt
	t.mu.Unlock()
	if created {
		logging.Debugf("chat", "tool call session=%s name=%s id=%s", t.session, name, update.ToolCallID)
		t.mu.Lock()
		t.calls = append(t.calls, map[string]any{
			"id": update.ToolCallID, "type": "function",
			"function": map[string]any{"name": name, "arguments": toolInputJSON(update)},
		})
		t.mu.Unlock()
		t.sink.Send("tool_call", map[string]any{
			"toolCallId": update.ToolCallID, "name": name, "args": toolInputJSON(update),
		})
		// 工具调用打断当前的正文块，先落盘再继续。
		t.flushAssistant()
	} else if update.RawInput != nil || update.Title != "" {
		t.sink.Send("tool_update", map[string]any{
			"toolCallId": update.ToolCallID, "name": name, "args": toolInputJSON(update),
		})
	}
	if update.Status != "completed" && update.Status != "failed" {
		if output != previousOutput {
			t.mu.Lock()
			tool.output = output
			t.mu.Unlock()
			t.sink.Send("tool_update", map[string]any{"toolCallId": update.ToolCallID, "result": output})
		}
		return
	}
	t.mu.Lock()
	tool.finished = true
	tool.failed = failed
	tool.output = output
	diffs := append([]FileChange(nil), tool.diffs...)
	t.mu.Unlock()
	t.flushAssistant()
	// 空输出也要落一行，使 tool_calls 在历史里有配对结果；
	// 失败结果加前缀，重载后仍能区分（Java AcpTranscriptOutput）。
	line := output
	if failed {
		line = "[failed] " + line
	}
	if line == "" {
		line = "(empty)"
	}
	t.appendLines([]map[string]any{{
		"role": "tool", "content": line, "tool_call_id": update.ToolCallID,
		"timestamp":        time.Now().UnixMilli(),
		"tool_started_at":  startedAt,
		"tool_finished_at": time.Now().UnixMilli(),
		"tool_duration_ms": time.Now().UnixMilli() - startedAt,
	}})
	status := "completed"
	if failed {
		status = "failed"
	}
	t.sink.Send("tool_result", map[string]any{
		"toolCallId": update.ToolCallID, "name": name, "result": output, "status": status,
		"duration": time.Now().UnixMilli() - startedAt,
	})
	if !failed {
		t.reportFileChanges(update.ToolCallID, diffs)
	}
	t.finishSubAgent(update.ToolCallID, failed, update.RawOutput)
}

// collectFileChanges 从工具内容里提取 diff 块。
func collectFileChanges(update *SessionUpdate) []FileChange {
	var changes []FileChange
	for _, item := range update.ToolContent() {
		if item.Type != "diff" || item.Path == "" {
			continue
		}
		changes = append(changes, CompareFile(item.Path, item.OldText, item.NewText))
	}
	return changes
}

// reportFileChanges 上报一次工具的文件改动（同一工具只上报一次）。
func (t *acpTurn) reportFileChanges(toolCallID string, diffs []FileChange) {
	if len(diffs) == 0 {
		return
	}
	st := t.state
	st.mu.Lock()
	if st.reportedFiles[toolCallID] {
		st.mu.Unlock()
		return
	}
	st.reportedFiles[toolCallID] = true
	st.mu.Unlock()
	changes := make([]map[string]any, 0, len(diffs))
	for _, change := range diffs {
		if change.Additions <= 0 && change.Deletions <= 0 {
			continue
		}
		changes = append(changes, map[string]any{
			"path": change.Path, "additions": change.Additions,
			"deletions": change.Deletions, "created": change.Created, "diff": change.Diff,
		})
	}
	if len(changes) == 0 {
		return
	}
	t.sink.Send("file_changes", map[string]any{"changes": changes})
	t.appendFileChanges(changes)
}

// finishSubAgent 在子代理父工具完成时补发 sub_end
// （Java finishSubAgent）：失败写 error，成功写 completed。
func (t *acpTurn) finishSubAgent(toolCallID string, failed bool, raw any) {
	st := t.state
	st.mu.Lock()
	active := st.subAgents[toolCallID] && !st.endedSubs[toolCallID]
	if active {
		st.endedSubs[toolCallID] = true
	}
	st.mu.Unlock()
	if !active {
		return
	}
	end := map[string]any{
		"subId": toolCallID, "subSessionId": subSessionID(toolCallID),
		"endedAt": time.Now().UnixMilli(),
	}
	if failed {
		end["status"] = "error"
		end["error"] = rawText(raw)
	} else {
		end["status"] = "completed"
	}
	t.sendSub("sub_end", end)
}

// commandPayload 渲染 Loopra 的 availableCommands 形状
// （inputHint 而不是 ACP 的 input.hint）。
func commandPayload(commands []Command) []map[string]any {
	out := make([]map[string]any, 0, len(commands))
	for _, command := range commands {
		item := map[string]any{"name": command.Name}
		if command.Description != "" {
			item["description"] = command.Description
		}
		if command.Input != nil && command.Input.Hint != "" {
			item["inputHint"] = command.Input.Hint
		}
		out = append(out, item)
	}
	return out
}

// subSessionID 对应 Java 的磁盘路由规则：合法标识原样使用，
// 否则取 SHA-256 十六进制。
func subSessionID(id string) string {
	if id != "" && len(id) <= 64 && !strings.ContainsAny(id, "/\\") {
		valid := true
		for _, char := range id {
			if !(char == '_' || char == '-' || (char >= '0' && char <= '9') ||
				(char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')) {
				valid = false
				break
			}
		}
		if valid {
			return id
		}
	}
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])
}

// rawText 渲染子代理失败时的原始输出，用于 sub_end.error。
func rawText(raw any) string {
	switch value := raw.(type) {
	case nil:
		return ""
	case string:
		return value
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return fmt.Sprint(value)
		}
		return string(encoded)
	}
}

// permission 把 ACP 审批请求注册进 HITL 注册表并等待用户选择。
func (t *acpTurn) permission(request PermissionRequest) (string, bool) {
	if len(request.Options) == 0 {
		return "", false
	}
	options := make([]hitl.Option, 0, len(request.Options))
	for _, option := range request.Options {
		// 原样下发 ACP 的 kind（allow_once/allow_always/reject_once/reject_always）。
		options = append(options, hitl.Option{Title: option.Name, Value: option.OptionID, Kind: option.Kind})
	}
	args, _ := request.ToolCall.RawInput.(map[string]any)
	if args == nil {
		args = map[string]any{}
	}
	title := strings.TrimSpace(request.ToolCall.Title)
	if title == "" {
		title = "工具调用需要审批"
	}
	name := ""
	if request.Meta != nil {
		if tool, ok := request.Meta["loopra.dev/toolName"].(string); ok {
			name = tool
		}
	}
	if name == "" {
		name = request.ToolCall.Title
	}
	if name == "" {
		name = "ACP 工具"
	}
	pending := t.host.Permissions().RegisterOptionsWithTitle(t.session, title, name, args, "", "", options)
	payload := pending.ChoicePayload()
	// 子代理发起的审批走 sub_choice 并带 subId，前端据此归到子代理面板。
	if subID := t.subOwnerOf(request.ToolCall.ToolCallID); subID != "" {
		payload["subId"] = subID
		t.sink.Send("sub_choice", payload)
	} else {
		t.sink.Send("choice", payload)
	}
	option, ok := pending.Wait(t.ctx())
	if !ok {
		t.host.Permissions().CancelOne(pending.ID)
		t.sink.Send("permission_resolved", map[string]any{"permissionRequestId": pending.ID, "optionId": "cancelled"})
		return "", false
	}
	t.sink.Send("permission_resolved", map[string]any{"permissionRequestId": pending.ID, "optionId": option})
	return option, true
}

// elicit 把 Agent 的反向提问转成 elicitation / elicitation_resolved 事件，
// 并阻塞等待用户表单答案（Java AcpElicitations）。
func (t *acpTurn) elicit(ctx context.Context, request ElicitationRequest) ElicitationResult {
	if request.Mode != "" && request.Mode != "form" {
		return ElicitationResult{Action: "cancel"}
	}
	if request.RequestedSchema == nil {
		return ElicitationResult{Action: "cancel"}
	}
	if _, ok := request.RequestedSchema["properties"].(map[string]any); !ok {
		return ElicitationResult{Action: "cancel"}
	}
	if request.Meta != nil {
		if codex, ok := request.Meta["codex"].(map[string]any); ok {
			delay := int64(-1)
			switch value := codex["autoResolutionMs"].(type) {
			case float64:
				delay = int64(value)
			case int64:
				delay = value
			case int:
				delay = int64(value)
			}
			if delay >= 0 {
				var cancel context.CancelFunc
				ctx, cancel = context.WithTimeout(ctx, time.Duration(delay)*time.Millisecond)
				defer cancel()
			}
		}
	}
	item := t.host.Elicitations().Register(t.session, request.Message, request.RequestedSchema)
	t.sink.Send("elicitation", item.Event())
	answer, _ := t.host.Elicitations().Wait(ctx, item)
	// 不回显用户答案（可能包含密钥），只回报动作。
	t.sink.Send("elicitation_resolved", map[string]any{
		"elicitationRequestId": item.ID, "action": answer.Action,
	})
	return ElicitationResult{Action: answer.Action, Content: answer.Content}
}

// subOwnerOf 返回工具调用所属的子代理（Java subToolParents / childPermissionTools）。
func (t *acpTurn) subOwnerOf(toolCallID string) string {
	if toolCallID == "" {
		return ""
	}
	st := t.state
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.subToolParents[toolCallID]
}

func (t *acpTurn) ctx() context.Context {
	if t.runCtx != nil {
		return t.runCtx
	}
	return context.Background()
}

// sendNative 转发适配器注入的 Loopra 原生事件。
func (t *acpTurn) sendNative(kind string, data json.RawMessage) {
	if kind == "" || len(data) == 0 {
		return
	}
	t.sink.SendRaw(kind, data)
}

// appendUser 写入本轮用户消息行。
func (t *acpTurn) appendUser(message string, images []string, hasSnapshot bool) {
	row := map[string]any{
		"role": "user", "timestamp": t.startedAt,
		"turn_started_at": t.startedAt,
	}
	if message != "" {
		row["content"] = message
	}
	if len(images) > 0 {
		parts := []any{map[string]any{"type": "text", "text": message}}
		for _, image := range images {
			parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": image}})
		}
		row["content"] = parts
	}
	if hasSnapshot {
		row["snapshot_id"], row["rollback_id"] = t.msgID, t.msgID
	}
	t.appendLines([]map[string]any{row})
}

// flushAssistant 把累计的正文/思考/工具调用落成一行 assistant。
func (t *acpTurn) flushAssistant() {
	t.mu.Lock()
	text := t.text.String()
	reasoning := t.reasoning.String()
	calls := t.calls
	if text == "" && reasoning == "" && len(calls) == 0 {
		t.mu.Unlock()
		return
	}
	t.text.Reset()
	t.reasoning.Reset()
	t.calls = nil
	t.mu.Unlock()
	now := time.Now().UnixMilli()
	row := map[string]any{
		"role": "assistant", "timestamp": now,
		"turn_started_at": t.startedAt, "turn_finished_at": now, "elapsed_ms": now - t.startedAt,
		"acp_message_id": t.msgID,
	}
	if text != "" {
		row["content"] = text
	}
	if reasoning != "" {
		row["reasoning_content"] = reasoning
	}
	if len(calls) > 0 {
		row["tool_calls"] = calls
	}
	t.appendLines([]map[string]any{row})
}

// appendFileChanges 把文件改动附到最近一条 assistant 行（Java 同样在
// 回合内上报 file_changes）。
func (t *acpTurn) appendFileChanges(changes []map[string]any) {
	t.appendLines([]map[string]any{{
		"role": "assistant", "file_changes": changes,
		"timestamp": time.Now().UnixMilli(), "acp_message_id": t.msgID,
	}})
}

// finish 在轮次结束时落盘剩余内容。
func (t *acpTurn) finish() {
	t.mu.Lock()
	if t.finished {
		t.mu.Unlock()
		return
	}
	t.finished = true
	t.mu.Unlock()
	t.flushAssistant()
	// 刷出子代理未落盘的文本段（Java AcpSubAgentRecorder.finish）。
	if t.subRec != nil {
		t.subRec.finish()
	}
}

func (t *acpTurn) appendLines(lines []map[string]any) {
	if t.host == nil {
		return
	}
	_ = t.host.AppendTranscript(t.session, lines)
}

// promptBlocks 把请求渲染成 ACP 内容块。
func promptBlocks(message string, images []string) []ContentBlock {
	blocks := make([]ContentBlock, 0, 1+len(images))
	if message != "" {
		blocks = append(blocks, ContentBlock{Type: "text", Text: message})
	}
	for _, image := range images {
		if mime, data, ok := parseDataURL(image); ok {
			blocks = append(blocks, ContentBlock{Type: "image", Data: base64.StdEncoding.EncodeToString(data), MIMEType: mime})
			continue
		}
		if strings.HasPrefix(image, "http://") || strings.HasPrefix(image, "https://") {
			blocks = append(blocks, ContentBlock{Type: "image", URI: image})
		}
	}
	if len(blocks) == 0 {
		blocks = append(blocks, ContentBlock{Type: "text", Text: reqPlaceholder})
	}
	return blocks
}

// translateACPFailure 把底层错误映射成前端可展示的消息。
func translateACPFailure(err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, ErrClosed):
		return errors.New("ACP 连接已关闭")
	case errors.Is(err, ErrExited):
		return ErrExited
	case errors.Is(err, ErrBroken):
		return ErrBroken
	case strings.Contains(err.Error(), "executable file not found"):
		return errors.New("启动 ACP Agent 失败: 未找到可执行文件，请检查安装")
	}
	return err
}

// toolDisplayName 取工具名：优先适配器注入的 loopra.dev/toolName，
// 其次标题，最后是 kind。
func toolDisplayName(update *SessionUpdate) string {
	if update.Meta != nil {
		if name, ok := update.Meta["loopra.dev/toolName"].(string); ok && name != "" {
			return name
		}
	}
	switch {
	case update.Title != "":
		return update.Title
	case update.Kind != "":
		return update.Kind
	default:
		return "tool"
	}
}

func toolInputJSON(update *SessionUpdate) string {
	if update.RawInput == nil {
		return "{}"
	}
	raw, err := json.Marshal(update.RawInput)
	if err != nil {
		return "{}"
	}
	return string(raw)
}

// acpStopStatus 把 ACP 的 stopReason 映射为 Loopra 的 complete 状态。
func acpStopStatus(reason string) (string, string) {
	switch strings.ToLower(reason) {
	case "end_turn":
		return "completed", ""
	case "cancelled":
		return "cancelled", ""
	case "refusal":
		return "refused", "Agent 拒绝了本次请求"
	case "max_tokens":
		return "limited", "Agent 已达到本轮输出上限，任务可能尚未完成"
	case "max_turn_requests":
		return "limited", "Agent 已达到本轮请求次数上限，任务可能尚未完成"
	default:
		// 未知 stopReason 按未完成处理（Java default → limited）。
		return "limited", ""
	}
}

func parseDataURL(url string) (string, []byte, bool) {
	if !strings.HasPrefix(url, "data:") {
		return "", nil, false
	}
	rest := url[len("data:"):]
	sep := strings.Index(rest, ",")
	if sep < 0 {
		return "", nil, false
	}
	mime := strings.TrimSuffix(rest[:sep], ";base64")
	data, err := base64.StdEncoding.DecodeString(rest[sep+1:])
	if err != nil {
		return "", nil, false
	}
	return mime, data, true
}
