package subagent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	agentpkg "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"

	loopraagent "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/hitl"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// recorder 向 {sessionsDir}/{parent}.sub/{subSessionId}.jsonl
// 追加 Loopra 格式的 sub_* 行，每行一个 JSON 对象，
// 每次写入都重新打开文件，与 Java 存储避免交错的做法一致。
type recorder struct {
	dir string
	mu  sync.Mutex
}

func newRecorder(subDir string) *recorder {
	_ = os.MkdirAll(subDir, 0o755)
	return &recorder{dir: subDir}
}

func (rec *recorder) record(payload map[string]any) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	sub, _ := payload["subSessionId"].(string)
	if sub == "" {
		return
	}
	name := sub
	if len(name) > 64 {
		name = name[:64]
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	path := filepath.Join(rec.dir, name+".jsonl")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(append(data, '\n'))
}

func nowMillis() int64 { return time.Now().UnixMilli() }

// drive 运行一次子代理对话，把 ADK 事件转换为
// sub_* SSE 事件与 .sub 日志行（Java SubAgentAgentOutput +
// SubAgentEventRecorder）。受管控的工具调用会让子循环暂停在
// sub_choice 上；Java broker 在 5 分钟后超时并自动拒绝。
const subHitlTimeout = 5 * time.Minute

func (r *Runner) drive(ctx context.Context, run *runner.Runner, sess session.Session, parentSession, message string, subID int, subSessionID string, rec *recorder, sink Sink, fusion bool, recovery *fusionRecovery) (string, error) {
	ctx = loopraagent.WithParentSession(ctx, parentSession)
	if sink != nil || recovery != nil {
		// 让 runner 的 AfterToolCallback 能逐个工具上报 sub_tool_result；
		// Fusion 交接同时把终态写入恢复要点。
		ctx = loopraagent.WithToolResultSink(ctx, newSubToolResults(subID, sink, recovery))
	}
	reply := ""
	content := &genai.Content{
		Role: genai.RoleUser, Parts: []*genai.Part{{Text: message}},
	}
	for {
		pendings, last, err := r.onePass(ctx, run, sess, parentSession, content, subID, subSessionID, rec, sink, &reply, fusion, recovery)
		if err != nil {
			return last, err
		}
		if len(pendings) == 0 {
			return last, nil
		}
		responses := make([]*genai.Part, 0, len(pendings))
		for _, p := range pendings {
			send(sink, "sub_choice", p.ChoicePayload())
			waitCtx, cancel := context.WithTimeout(ctx, subHitlTimeout)
			option, ok := p.Wait(waitCtx)
			cancel()
			if !ok {
				r.Permissions.CancelOne(p.ID)
				option = "reject_once" // broker 超时自动拒绝
			}
			if fusion {
				// Fusion 审批以父会话普通 choice 呈现；回执已解决的
				// 选项，前端据 permission_resolved 标记选项卡。
				resolved := option
				if !ok || resolved == "" {
					resolved = "cancelled"
				}
				send(sink, "sub_permission_resolved", map[string]any{
					"permissionRequestId": p.ID, "optionId": resolved,
				})
			}
			responses = append(responses, &genai.Part{FunctionResponse: &genai.FunctionResponse{
				Name:     toolconfirmation.FunctionCallName,
				ID:       p.ConfirmID,
				Response: map[string]any{"confirmed": option == "allow_once"},
			}})
		}
		content = &genai.Content{Role: genai.RoleUser, Parts: responses}
	}
}

// onePass 消费一次 ADK 运行，返回其暂停等待的审批请求
// 与最新的助手文本；迭代错误在照常上报 sub_error 后向上传递。
func (r *Runner) onePass(ctx context.Context, run *runner.Runner, sess session.Session, parentSession string, content *genai.Content, subID int, subSessionID string, rec *recorder, sink Sink, reply *string, fusion bool, recovery *fusionRecovery) ([]*hitl.Request, string, error) {
	var pendings []*hitl.Request
	// Fusion 文本以流式增量直接呈现给父聊天；完整事件里重复的
	// 正文不再二次发送（.sub 审计与最终回复仍照常落完整文本）。
	streamedContent, streamedReasoning := false, false
	it := run.Run(loopraagent.WithContextTurn(ctx), "default", sess.ID(), content, agentpkg.RunConfig{StreamingMode: agentpkg.StreamingModeSSE})
	for ev, err := range it {
		if err != nil {
			send(sink, "sub_error", map[string]any{"subId": subID, "error": err.Error()})
			if rec != nil {
				rec.record(map[string]any{
					"type": "sub_error", "subId": subID, "subSessionId": subSessionID,
					"error": err.Error(),
				})
			}
			// 已登记但尚未作为 sub_choice 发出的审批不能残留在
			// 注册表里，否则 /chat/permissions 会列出永不可达项。
			for _, pending := range pendings {
				r.Permissions.CancelOne(pending.ID)
			}
			return nil, *reply, err
		}
		if ev.Content == nil {
			continue
		}
		if ev.Partial {
			for _, p := range ev.Content.Parts {
				if p == nil || p.Text == "" {
					continue
				}
				if p.Thought {
					streamedReasoning = true
					send(sink, "sub_reasoning", map[string]any{"subId": subID, "token": p.Text})
				} else {
					streamedContent = true
					send(sink, "sub_content", map[string]any{"subId": subID, "token": p.Text})
				}
			}
			continue
		}
		if changes := ev.CustomMetadata["fileChanges"]; changes != nil {
			payload := map[string]any{
				"type": "sub_file_changes", "subId": subID,
				"subSessionId": subSessionID, "changes": changes,
			}
			send(sink, "sub_file_changes", payload)
			if rec != nil {
				rec.record(payload)
			}
		}
		for _, p := range ev.Content.Parts {
			if p == nil {
				continue
			}
			switch {
			case p.FunctionCall != nil && p.FunctionCall.Name == toolconfirmation.FunctionCallName:
				if r.Permissions != nil {
					if orig, cerr := toolconfirmation.OriginalCallFrom(p.FunctionCall); cerr == nil {
						if fusion {
							// Fusion 审批登记在父会话名下，以普通
							// choice 呈现在主对话而不是子代理容器里。
							pendings = append(pendings, r.Permissions.Register(parentSession, orig.Name, orig.Args, "", p.FunctionCall.ID))
						} else {
							pendings = append(pendings, r.Permissions.RegisterSub(parentSession, subID, orig.Name, orig.Args, "", p.FunctionCall.ID))
						}
					}
				}
			case p.Text != "" && p.Thought:
				if !fusion || !streamedReasoning {
					send(sink, "sub_reasoning", map[string]any{"subId": subID, "token": p.Text})
				}
				if rec != nil {
					rec.record(map[string]any{
						"type": "sub_reasoning", "subId": subID,
						"subSessionId": subSessionID, "content": p.Text,
					})
				}
			case p.Text != "":
				if !fusion || !streamedContent {
					send(sink, "sub_content", map[string]any{"subId": subID, "token": p.Text})
				}
				if rec != nil {
					rec.record(map[string]any{
						"type": "sub_content", "subId": subID,
						"subSessionId": subSessionID, "content": p.Text,
					})
				}
				*reply = p.Text
			case p.FunctionCall != nil:
				recovery.called(p.FunctionCall.ID, p.FunctionCall.Name, p.FunctionCall.Args)
				args, _ := json.Marshal(p.FunctionCall.Args)
				send(sink, "sub_tool_call", map[string]any{
					"subId": subID, "toolCallId": p.FunctionCall.ID,
					"name": p.FunctionCall.Name, "args": string(args),
				})
				if rec != nil {
					rec.record(map[string]any{
						"type": "sub_tool_call", "subId": subID,
						"subSessionId": subSessionID, "toolCallId": p.FunctionCall.ID,
						"name": p.FunctionCall.Name, "args": string(args),
						"startedAt": nowMillis(),
					})
				}
			case p.FunctionResponse != nil:
				status := "completed"
				if msg, _ := p.FunctionResponse.Response["error"].(string); strings.Contains(msg, "requires confirmation") {
					continue // 暂停调用的占位
				} else if msg != "" {
					status = "failed"
				}
				// 该结果可能已在工具完成时提前发送过（提前路径不写 .sub 日志，
				// 这里仍需记录）。
				alreadySent := false
				if results := loopraagent.ToolResultSinkFromContext(ctx); results != nil {
					alreadySent = results.ToolResultSent(p.FunctionResponse.ID)
				}
				if !alreadySent {
					if !tools.IsAsyncPlaceholder(p.FunctionResponse.ID, p.FunctionResponse.Response) {
						recovery.finished(p.FunctionResponse.ID, p.FunctionResponse.Name, p.FunctionResponse.Response)
					}
					send(sink, "sub_tool_result", map[string]any{
						"subId": subID, "toolCallId": p.FunctionResponse.ID,
						"name": p.FunctionResponse.Name, "result": responseText(p.FunctionResponse),
						"status": status,
					})
				}
				if rec != nil {
					rec.record(map[string]any{
						"type": "sub_tool_result", "subId": subID,
						"subSessionId": subSessionID, "toolCallId": p.FunctionResponse.ID,
						"name": p.FunctionResponse.Name, "result": responseText(p.FunctionResponse),
						"status": status, "finishedAt": nowMillis(),
					})
				}
			}
		}
		if ev.UsageMetadata != nil {
			prompt := ev.UsageMetadata.PromptTokenCount
			completion := ev.UsageMetadata.CandidatesTokenCount
			send(sink, "sub_usage", map[string]any{
				"subId":        subID,
				"promptTokens": prompt, "completionTokens": completion,
				"totalTokens": prompt + completion,
				"cacheHit":    ev.UsageMetadata.CachedContentTokenCount, "cacheMiss": 0,
			})
		}
		if ev.Content.Role == genai.RoleModel {
			// 一次完整模型事件收尾：后续增量段重新计数，避免下一次
			// 模型调用的流式文本被误判为已发送。
			streamedContent, streamedReasoning = false, false
		}
	}
	return pendings, *reply, nil
}

func responseText(fr *genai.FunctionResponse) string {
	if fr.Response == nil {
		return ""
	}
	return responseMapText(fr.Response)
}

func responseMapText(response map[string]any) string {
	if v, ok := response["result"].(string); ok {
		return v
	}
	if v, ok := response["error"].(string); ok {
		return "Error: " + v
	}
	raw, err := json.Marshal(response)
	if err != nil {
		return ""
	}
	return string(raw)
}

// subToolResults 把子代理里单个工具完成的结果提前写入父聊天流。
// 合并事件到达时按 toolCallId 去重（.sub 日志仍由 onePass 记录）。
type subToolResults struct {
	sink     Sink
	subID    int
	recovery *fusionRecovery
	mu       sync.Mutex
	sent     map[string]bool
}

func newSubToolResults(subID int, sink Sink, recovery *fusionRecovery) *subToolResults {
	return &subToolResults{sink: sink, subID: subID, recovery: recovery, sent: map[string]bool{}}
}

// ToolFinished 实现 agentpkg.ToolResultSink。
func (s *subToolResults) ToolFinished(callID, name string, response map[string]any) {
	if callID == "" {
		return
	}
	msg, _ := response["error"].(string)
	if strings.Contains(msg, "requires confirmation") {
		return // 等待审批的占位结果
	}
	status := "completed"
	if msg != "" {
		status = "failed"
	}
	s.mu.Lock()
	if s.sent[callID] {
		s.mu.Unlock()
		return
	}
	s.sent[callID] = true
	s.mu.Unlock()
	// 每个工具完成即写入恢复要点，不依赖合并事件或 SSE 已就位。
	s.recovery.finished(callID, name, response)
	send(s.sink, "sub_tool_result", map[string]any{
		"subId": s.subID, "toolCallId": callID, "name": name,
		"result": responseMapText(response), "status": status,
	})
}

// ToolResultSent 实现 agentpkg.ToolResultSink。
func (s *subToolResults) ToolResultSent(callID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sent[callID]
}

var _ loopraagent.ToolResultSink = (*subToolResults)(nil)
