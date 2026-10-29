package controller

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/service/acp"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/hitl"
	"github.com/ezdemo/looprax/internal/service/tools"
)

// chatRequest 与 Java ChatRequest 的请求体保持一致（契约 §0）。
type chatRequest struct {
	AgentID             string   `json:"agentId"`
	Message             string   `json:"message"`
	Stream              bool     `json:"stream"`
	RequestID           string   `json:"requestId"`
	WorkspaceHash       string   `json:"workspaceHash"`
	LinkedProjectHashes []string `json:"linkedProjectHashes"`
	SessionName         string   `json:"sessionName"`
	Model               string   `json:"model"`
	ModelChannelID      string   `json:"modelChannelId"`
	ReasoningEffort     string   `json:"reasoningEffort"`
	FastMode            *bool    `json:"fastMode"`
	WorktreeMode        *bool    `json:"worktreeMode"`
	MergeMode           string   `json:"mergeMode"`
	Action              string   `json:"action"`
	Images              []string `json:"images"`
}

// chatStreamHandler 实现 POST /api/chat/stream：流建立前的校验通过 HTTP 状态码返回，
// 之后的一切通过 SSE 事件传输，并以 done 事件结束。
func (s *Controller) chatStreamHandler(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeFail(w, http.StatusBadRequest, "message 不能为空")
		return
	}
	if strings.TrimSpace(req.Message) == "" && len(req.Images) == 0 && req.Action != "execute_plan" {
		writeFail(w, http.StatusBadRequest, "message 不能为空")
		return
	}
	if req.Action != "" && req.Action != "execute_plan" {
		writeFail(w, http.StatusBadRequest, "不支持的聊天操作")
		return
	}
	if req.MergeMode != "" && req.MergeMode != "manual" && req.MergeMode != "ai-auto" && req.MergeMode != "ai-auto-approve" {
		writeFail(w, http.StatusBadRequest, "不支持的隔离分支合并模式")
		return
	}
	if s.agent == nil {
		writeFail(w, http.StatusServiceUnavailable, "Agent 未初始化")
		return
	}
	req.SessionName = req2Session(&req)
	if req.AgentID == "looprax" {
		req.AgentID = "native"
	}
	meta := s.sessionMetaRead(req.SessionName)
	bound := strOr(meta, "agentId", "")
	if bound == "looprax" {
		bound = s.migrateRetiredAgent(req.SessionName)
		meta = s.sessionMetaRead(req.SessionName)
	}
	if req.AgentID == "" {
		req.AgentID = bound
		if req.AgentID == "" {
			req.AgentID = "native"
		}
	} else if bound != "" && bound != req.AgentID {
		// 已绑定其他引擎且会话有内容时不允许静默换引擎并改写绑定
		// （Java AgentService.selectSessionAgent）。
		if len(s.sessionMessages(r.Context(), req.SessionName)) > 0 || strOr(meta, "acpSessionId", "") != "" {
			writeFail(w, http.StatusConflict, "会话已绑定 Agent "+bound+"，请新建会话")
			return
		}
	}
	if req.AgentID != "native" && !acp.IsExternal(req.AgentID) {
		writeFail(w, http.StatusBadRequest, "Agent 引擎不可用: "+req.AgentID)
		return
	}
	if req.Action == "execute_plan" && req.AgentID != "native" {
		writeFail(w, http.StatusConflict, "此操作仅支持 Loopra Native")
		return
	}
	sse := startSSE(w)
	job, err := s.admitChat(&req)
	if err != nil {
		sse.sendError(err.Error())
		return
	}
	defer s.releaseChat(job)
	ctx, cancel := context.WithCancel(context.WithoutCancel(r.Context()))
	defer cancel()
	job.setCancel(cancel)
	select {
	case s.state.workers <- struct{}{}:
		defer func() { <-s.state.workers }()
	case <-ctx.Done():
		sse.done()
		return
	}
	var scoped *Controller
	if req.AgentID == "native" {
		scoped, err = s.prepareTurn(&req)
	} else {
		// 外部 ACP 引擎只需要工作区视图（隔离分支、关联项目），
		// 不装配原生智能体。
		scoped, err = s.prepareWorktree(&req)
	}
	if err != nil {
		sse.sendError(err.Error())
		return
	}
	if req.AgentID != "native" {
		linked, linkErr := scoped.resolveLinkedProjects(&req)
		if linkErr != nil {
			sse.sendError(linkErr.Error())
			return
		}
		scoped.linkedProjectRoots = linked
	}
	s = scoped
	s.state.mu.Lock()
	job.runtime = s
	s.state.mu.Unlock()
	defer s.closeTurnTools()
	r = r.WithContext(ctx)
	if req.Action == "execute_plan" {
		s.sessionMetaSet(req.SessionName, map[string]any{"planMode": false, "pendingPlan": ""})
	}
	// 子代理事件复用同一条流；sub_agent 工具通过请求上下文读取
	// 事件接收端与父会话。
	ctx = context.WithValue(r.Context(), sinkKey{}, sse)
	ctx = context.WithValue(ctx, sessionKey{}, req2Session(&req))
	r = r.WithContext(ctx)
	// 每条用户消息开始时都会创建对应的回滚快照点。
	msgID := newMsgID()
	hasSnapshot := false
	if gitops.IsRepo(s.workspaceRoot()) {
		if snap, err := gitops.Checkpoint(s.workspaceRoot(), msgID); err == nil {
			hasSnapshot = s.recordSnapshot(req.SessionName, s.workspaceRoot(), snap) == nil
		}
	}
	sse.send("snapshot", map[string]any{"msgId": msgID, "hasCodeSnapshot": hasSnapshot})
	if req.Action == "execute_plan" {
		sse.send("mode_changed", map[string]any{"mode": "execute"})
	}
	s.setCurrentSession(req.SessionName)
	ctx = withTurnSnapshot(r.Context(), msgID)
	r = r.WithContext(ctx)
	if req.AgentID != "native" {
		s.runACPTurn(ctx, sse, &req, msgID, hasSnapshot)
		return
	}
	s.runTurn(r.Context(), sse, &req)
}

// runTurn 驱动一次智能体轮次，并把 ADK 事件转换为 Loopra
// SSE 协议。HTTP 处理器在此阻塞直到轮次结束，与 Java
// 端 emitter 的 awaitCompletion 行为一致。因工具审批而暂停的轮次
// 会发出 Loopra choice 事件，等待 POST /api/chat/permission，然后
// 用确认 FunctionResponse 在同一条流上恢复执行。
func (s *Controller) runTurn(ctx context.Context, sse *sseWriter, req *chatRequest) {
	logging.Infof("chat", "turn start session=%s agent=native chars=%d images=%d", req.SessionName, len([]rune(req.Message)), len(req.Images))
	ctx = tools.WithLinkedProjects(ctx, s.linkedProjectRoots)
	// 并行工具调用完成即上报，快的工具不必等慢的一起"变绿"。
	ctx = agentpkg.WithToolResultSink(ctx, newSSEToolResults(sse))
	sess, err := s.agent.Session(ctx, req.SessionName)
	if err != nil {
		sse.sendError("会话打开失败: " + err.Error())
		return
	}
	s.ensureSessionTitle(ctx, req.SessionName, req.Message)
	content := userContent(req.Message, req.Images)
	for {
		pendings := s.driveTurn(ctx, sse, sess, req2Session(req), content)
		if len(pendings) == 0 {
			return
		}
		responses := make([]*genai.Part, 0, len(pendings))
		for _, p := range pendings {
			// Java 链路在发起提示前记录审查结论。
			sse.send("log", map[string]any{
				"level": "WARN", "message": "[tool-review/human] 未获自动批准，等待用户确认: " + p.Tool,
			})
			sse.send("choice", p.ChoicePayload())
			option, ok := p.Wait(ctx)
			if !ok {
				s.permissions.CancelOne(p.ID)
				sse.send("permission_resolved", map[string]any{
					"permissionRequestId": p.ID, "optionId": "cancelled",
				})
				sse.done()
				return
			}
			sse.send("permission_resolved", map[string]any{
				"permissionRequestId": p.ID, "optionId": option,
			})
			responses = append(responses, confirmationResponsePart(p.ConfirmID, option == "allow_once"))
		}
		content = &genai.Content{Role: genai.RoleUser, Parts: responses}
	}
}

// driveTurn 消费一次 ADK 运行并转换其事件，返回该轮次
// 暂停时所等待的审批请求（轮次完成时为空）。
func (s *Controller) driveTurn(ctx context.Context, sse *sseWriter, sess session.Session, sessionName string, content *genai.Content) []*hitl.Request {
	started := time.Now()
	usage := &usageTotals{}
	toolCalls := 0
	reasoningBytes := 0
	reasoningStarted := false
	// streamedReasoning 标记本次模型调用的思考是否已经以增量发出：
	// 流式适配器的最终事件会重复携带同样的思考文本，不能再发一遍。
	streamedReasoning := false
	var pendings []*hitl.Request
	var lastErr error
	for ev, err := range s.agent.Run(ctx, sess, content) {
		if err != nil {
			lastErr = err
			break
		}
		if ev.Content == nil {
			usage.add(ev)
			continue
		}
		if ev.Partial {
			for _, p := range ev.Content.Parts {
				switch {
				case p.Text != "" && p.Thought:
					streamedReasoning = true
					reasoningBytes += len(p.Text)
					if !reasoningStarted {
						reasoningStarted = true
						sse.send("reasoning_started", map[string]any{})
					}
					sse.sendText("reasoning", p.Text)
				case p.Text != "":
					sse.sendText("content", p.Text)
				}
			}
			continue
		}
		usage.add(ev)
		sse.send("usage", usage.snapshot())
		// 只有非流式适配器（网关未返回增量）才在这里补发完整推理；
		// 流式调用已逐 token 发过，再发一次会让前端出现第二段思考。
		if !streamedReasoning {
			for _, p := range ev.Content.Parts {
				if p != nil && p.Text != "" && p.Thought {
					reasoningBytes += len(p.Text)
					if !reasoningStarted {
						reasoningStarted = true
						sse.send("reasoning_started", map[string]any{})
					}
					sse.sendText("reasoning", p.Text)
				}
			}
		}
		streamedReasoning = false
		for _, p := range ev.Content.Parts {
			switch {
			case p.FunctionCall != nil && p.FunctionCall.Name == toolconfirmation.FunctionCallName:
				if req := s.registerConfirmation(sessionName, p.FunctionCall); req != nil {
					pendings = append(pendings, req)
				}
			case p.FunctionCall != nil:
				toolCalls++
				args, _ := json.Marshal(p.FunctionCall.Args)
				sse.send("tool_call", map[string]any{
					"toolCallId": p.FunctionCall.ID,
					"name":       p.FunctionCall.Name,
					"args":       string(args),
				})
			case p.FunctionResponse != nil && isPendingConfirmation(p.FunctionResponse):
				// 等待审批的调用所对应的临时占位响应
				// 保持隐藏；恢复后的轮次才会发出真实结果。
			case p.FunctionResponse != nil:
				// 该结果可能已经在工具完成时提前上报过。
				if sink := agentpkg.ToolResultSinkFromContext(ctx); sink != nil && sink.ToolResultSent(p.FunctionResponse.ID) {
					continue
				}
				sse.send("tool_result", map[string]any{
					"toolCallId": p.FunctionResponse.ID,
					"name":       p.FunctionResponse.Name,
					"result":     resultString(p.FunctionResponse),
					"status":     "completed",
				})
			}
		}
		if ev.IsFinalResponse() {
			sse.send("complete", map[string]any{"content": eventText(ev)})
		}
	}
	elapsed := time.Since(started).Round(time.Millisecond)
	if lastErr != nil {
		sse.sendError(lastErr.Error())
		return nil
	}
	if len(pendings) > 0 {
		// 暂停的轮次会保持流打开以等待审批；complete/done
		// 事件对在恢复结束后才发送。
		logging.Infof("chat", "turn paused session=%s agent=native awaiting %d approval(s)", sessionName, len(pendings))
		return pendings
	}
	logging.Infof("chat", "turn done session=%s agent=native in %s (tools=%d, reasoning=%dB)", sessionName, elapsed, toolCalls, reasoningBytes)
	sse.done()
	return nil
}

// req2Session 返回聊天轮次所属的会话名（为空时使用 "default"）。
func req2Session(req *chatRequest) string {
	if req.SessionName != "" {
		return req.SessionName
	}
	return "default"
}

// registerConfirmation 把一个 ADK 确认事件转换为 Loopra
// 待审批请求，并以新的 permissionRequestId 作为键。
func (s *Controller) registerConfirmation(sessionName string, fc *genai.FunctionCall) *hitl.Request {
	orig, err := toolconfirmation.OriginalCallFrom(fc)
	if err != nil {
		return nil
	}
	return s.permissions.Register(sessionName, orig.Name, orig.Args, confirmHint(orig.Name), fc.ID)
}

func confirmHint(tool string) string {
	return "工具调用需要审批: " + tool
}

// isPendingConfirmation 匹配 ADK 为触发确认请求的调用所发出的占位响应
// （由 tool.ErrConfirmationRequired 包装产生）。
func isPendingConfirmation(fr *genai.FunctionResponse) bool {
	msg, _ := fr.Response["error"].(string)
	return strings.Contains(msg, "requires confirmation, please approve or reject")
}

// confirmationResponsePart 构建用于恢复暂停调用的
// 用户角色应答。
func confirmationResponsePart(confirmID string, approved bool) *genai.Part {
	return &genai.Part{FunctionResponse: &genai.FunctionResponse{
		Name:     toolconfirmation.FunctionCallName,
		ID:       confirmID,
		Response: map[string]any{"confirmed": approved},
	}}
}

// userContent 构建包含文本与图片分片的 genai 用户内容。
func userContent(message string, images []string) *genai.Content {
	parts := make([]*genai.Part, 0, 1+len(images))
	if message != "" {
		parts = append(parts, &genai.Part{Text: message})
	}
	for _, img := range images {
		if mime, data, ok := parseDataURL(img); ok {
			parts = append(parts, &genai.Part{InlineData: &genai.Blob{MIMEType: mime, Data: data}})
		} else if strings.HasPrefix(img, "http://") || strings.HasPrefix(img, "https://") {
			parts = append(parts, &genai.Part{FileData: &genai.FileData{FileURI: img}})
		}
	}
	if len(parts) == 0 {
		parts = append(parts, &genai.Part{Text: reqPlaceholder})
	}
	return &genai.Content{Role: genai.RoleUser, Parts: parts}
}

const reqPlaceholder = "(plan execution)"

// eventText 拼接事件中可见的文本。
func eventText(ev *session.Event) string {
	if ev.Content == nil {
		return ""
	}
	var sb strings.Builder
	for _, p := range ev.Content.Parts {
		if p != nil && p.Text != "" && !p.Thought {
			sb.WriteString(p.Text)
		}
	}
	return sb.String()
}

func resultString(fr *genai.FunctionResponse) string {
	return responseText(fr.Response)
}

// responseText 与 Java 一致：优先取 result 字符串，否则序列化整个响应。
func responseText(response map[string]any) string {
	if v, ok := response["result"].(string); ok {
		return v
	}
	raw, err := json.Marshal(response)
	if err != nil {
		return ""
	}
	return string(raw)
}

// usageTotals 汇总多次模型调用过程中的 Loopra 用量负载。
type usageTotals struct {
	Prompt     int64 `json:"promptTokens"`
	Completion int64 `json:"completionTokens"`
	Total      int64 `json:"totalTokens"`
	CacheHit   int64 `json:"cacheHit"`
	CacheMiss  int64 `json:"cacheMiss"`
	LastPrompt int64 `json:"lastPromptTokens"`
}

func (u *usageTotals) add(ev *session.Event) {
	if ev.UsageMetadata == nil {
		return
	}
	prompt := int64(ev.UsageMetadata.PromptTokenCount)
	hit := int64(ev.UsageMetadata.CachedContentTokenCount)
	u.Prompt += prompt
	u.Completion += int64(ev.UsageMetadata.CandidatesTokenCount)
	u.Total = u.Prompt + u.Completion
	u.CacheHit += hit
	u.CacheMiss += prompt - hit
	u.LastPrompt = prompt
}

func (u *usageTotals) snapshot() map[string]any {
	return map[string]any{
		"promptTokens": u.Prompt, "completionTokens": u.Completion,
		"totalTokens": u.Total, "cacheHit": u.CacheHit, "cacheMiss": u.CacheMiss,
		"lastPromptTokens": u.LastPrompt,
	}
}

// newMsgID 返回 8 位十六进制的回滚消息 id。
func newMsgID() string {
	buf := make([]byte, 4)
	if _, err := rand.Read(buf); err != nil {
		return "00000000"
	}
	return hex.EncodeToString(buf)
}

// abortAll 取消所有进行中的聊天轮次。
func (s *Controller) abortAll() {
	s.inflight.Range(func(_, v any) bool {
		if job, ok := v.(*chatJob); ok {
			job.abort()
		}
		return true
	})
}

// abortHandler 实现 POST /api/chat/abort。
func (s *Controller) abortHandler(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	s.inflight.Range(func(key, value any) bool {
		job, ok := value.(*chatJob)
		if !ok {
			return true
		}
		if req.RequestID != "" && job.ID != req.RequestID {
			return true
		}
		if req.WorkspaceHash != "" && job.Workspace != req.WorkspaceHash {
			return true
		}
		if req.SessionName != "" && job.Session != req.SessionName {
			return true
		}
		job.abort()
		if job.Session != "" {
			s.cancelACP(job.Session)
		}
		return true
	})
	writeOK(w, http.StatusOK, "已发送中断请求")
}

var _ = agentpkg.DefaultInstruction // 保留该 import 以供文档引用

// parseDataURL 解码 "data:<mime>;base64,<payload>" 格式。
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
