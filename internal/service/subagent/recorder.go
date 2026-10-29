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
)

// recorder 向 {sessionsDir}/{parent}.sub/{subSessionId}.jsonl
// 追加 Loopra 格式的 sub_* 行，每行一个 JSON 对象，
// 每次写入都重新打开文件，与 Java 存储避免交错的做法一致。
type recorder struct {
	dir string
	mu  sync.Mutex
}

func openRecorder(subDir string) *recorder {
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

func (rec *recorder) close() {}

func nowMillis() int64 { return time.Now().UnixMilli() }

// drive 运行一次子代理对话，把 ADK 事件转换为
// sub_* SSE 事件与 .sub 日志行（Java SubAgentAgentOutput +
// SubAgentEventRecorder）。受管控的工具调用会让子循环暂停在
// sub_choice 上；Java broker 在 5 分钟后超时并自动拒绝。
const subHitlTimeout = 5 * time.Minute

func (r *Runner) drive(ctx context.Context, run *runner.Runner, sess session.Session, parentSession, message string, subID int, subSessionID string, rec *recorder, sink Sink) string {
	if sink != nil {
		// 让 runner 的 AfterToolCallback 能逐个工具上报 sub_tool_result。
		ctx = loopraagent.WithToolResultSink(ctx, newSubToolResults(subID, sink))
	}
	reply := ""
	content := &genai.Content{
		Role: genai.RoleUser, Parts: []*genai.Part{{Text: message}},
	}
	for {
		pendings, last := r.onePass(ctx, run, sess, parentSession, content, subID, subSessionID, rec, sink, &reply)
		if len(pendings) == 0 {
			return last
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
// 与最新的助手文本。
func (r *Runner) onePass(ctx context.Context, run *runner.Runner, sess session.Session, parentSession string, content *genai.Content, subID int, subSessionID string, rec *recorder, sink Sink, reply *string) ([]*hitl.Request, string) {
	var pendings []*hitl.Request
	it := run.Run(ctx, "default", sess.ID(), content, agentpkg.RunConfig{StreamingMode: agentpkg.StreamingModeSSE})
	for ev, err := range it {
		if err != nil {
			send(sink, "sub_error", map[string]any{"subId": subID, "error": err.Error()})
			if rec != nil {
				rec.record(map[string]any{
					"type": "sub_error", "subId": subID, "subSessionId": subSessionID,
					"error": err.Error(),
				})
			}
			continue
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
					send(sink, "sub_reasoning", map[string]any{"subId": subID, "token": p.Text})
				} else {
					send(sink, "sub_content", map[string]any{"subId": subID, "token": p.Text})
				}
			}
			continue
		}
		for _, p := range ev.Content.Parts {
			if p == nil {
				continue
			}
			switch {
			case p.FunctionCall != nil && p.FunctionCall.Name == toolconfirmation.FunctionCallName:
				if r.Permissions != nil {
					if orig, cerr := toolconfirmation.OriginalCallFrom(p.FunctionCall); cerr == nil {
						pendings = append(pendings, r.Permissions.RegisterSub(parentSession, subID, orig.Name, orig.Args, "", p.FunctionCall.ID))
					}
				}
			case p.Text != "" && p.Thought:
				send(sink, "sub_reasoning", map[string]any{"subId": subID, "token": p.Text})
				if rec != nil {
					rec.record(map[string]any{
						"type": "sub_reasoning", "subId": subID,
						"subSessionId": subSessionID, "content": p.Text,
					})
				}
			case p.Text != "":
				send(sink, "sub_content", map[string]any{"subId": subID, "token": p.Text})
				if rec != nil {
					rec.record(map[string]any{
						"type": "sub_content", "subId": subID,
						"subSessionId": subSessionID, "content": p.Text,
					})
				}
				*reply = p.Text
			case p.FunctionCall != nil:
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
	}
	return pendings, *reply
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
	sink  Sink
	subID int
	mu    sync.Mutex
	sent  map[string]bool
}

func newSubToolResults(subID int, sink Sink) *subToolResults {
	return &subToolResults{sink: sink, subID: subID, sent: map[string]bool{}}
}

// ToolFinished 实现 agentpkg.ToolResultSink。
func (s *subToolResults) ToolFinished(callID, name string, response map[string]any) {
	if s.sink == nil || callID == "" {
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
	s.sink.SendSub("sub_tool_result", map[string]any{
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
