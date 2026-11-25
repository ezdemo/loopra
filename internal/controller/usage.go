package controller

import (
	"bufio"
	"context"
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"github.com/ezdemo/looprax/adk/session/jsonl"
	"github.com/ezdemo/looprax/internal/model/config"
	agentpkg "github.com/ezdemo/looprax/internal/service/agent"
)

type usageRecord struct {
	TS         int64  `json:"ts"`
	Model      string `json:"model"`
	Prompt     int64  `json:"prompt"`
	Completion int64  `json:"completion"`
	CacheHit   int64  `json:"cacheHit"`
	CacheMiss  int64  `json:"cacheMiss"`
	LastPrompt int64  `json:"lastPromptTokens"`
}

func (s *Controller) modelPrice(name string) (config.Price, bool) {
	if price, ok := s.cfg.Price[name]; ok {
		return price, true
	}
	for _, ch := range s.cfg.ModelChannels {
		for _, model := range ch.Models {
			if model.Name == name && model.Price != nil {
				return *model.Price, true
			}
		}
	}
	return s.metadataPrice(name)
}

func (s *Controller) usageView(record usageRecord, name string) map[string]any {
	price, hasPrice := s.modelPrice(name)
	miss := record.Prompt - record.CacheHit
	if miss < 0 {
		miss = 0
	}
	input := float64(miss) * price.Input / 1e6
	cache := float64(record.CacheHit) * price.Cache / 1e6
	output := float64(record.Completion) * price.Output / 1e6
	maxContext := int64(-1)
	for _, ch := range s.cfg.ModelChannels {
		for _, model := range ch.Models {
			if model.Name == name {
				maxContext = model.ContextTokens
			}
		}
	}
	if maxContext <= 0 {
		if limits, ok := s.modelMetadata(name)["limit"].(map[string]any); ok {
			maxContext = number(limits["context"])
		}
	}
	view := map[string]any{"promptTokens": record.Prompt, "completionTokens": record.Completion, "totalTokens": record.Prompt + record.Completion, "cacheHit": record.CacheHit, "cacheMiss": record.CacheMiss, "lastPromptTokens": record.LastPrompt, "maxContextTokens": maxContext, "model": name, "hasPrice": hasPrice, "inputCost": input, "cacheCost": cache, "outputCost": output, "totalCost": input + cache + output, "contextSource": "loopra", "contextEstimateScope": "request"}
	if hasPrice {
		view["currency"] = "CNY"
	}
	return view
}

// acpUsageView 用 ACP 上报的上下文占用构造用量视图
// （Java SessionUsageService.readAcp）：总量以 Agent 为准，
// 构成比例仍来自 Loopra 可见的本地估算。
func (s *Controller) acpUsageView(meta map[string]any, name string) (map[string]any, bool) {
	raw, ok := meta["acpUsage"].(map[string]any)
	if !ok {
		return nil, false
	}
	used := number(raw["used"])
	size := number(raw["size"])
	model, _ := raw["model"].(string)
	if model == "" {
		model = strOr(meta, "model", s.cfg.Model)
	}
	cost, priced := raw["cost"].(float64)
	currency, _ := raw["currency"].(string)
	reported := used >= 0 && size > 0
	if size <= 0 {
		size = s.maxContextOf(model)
	}
	view := map[string]any{
		"promptTokens": int64(0), "completionTokens": int64(0), "totalTokens": int64(0),
		"cacheHit": int64(0), "cacheMiss": int64(0),
		"lastPromptTokens": used, "maxContextTokens": size,
		"model": model, "hasPrice": priced,
		"inputCost": float64(0), "cacheCost": float64(0), "outputCost": float64(0),
		"totalCost":            cost,
		"contextSource":        "loopra",
		"contextEstimateScope": "transcript",
	}
	if reported {
		view["contextSource"] = "agent"
	}
	if priced && currency != "" {
		view["currency"] = currency
	}
	return view, true
}

// maxContextOf 返回模型配置的上下文窗口。
func (s *Controller) maxContextOf(model string) int64 {
	for _, ch := range s.cfg.ModelChannels {
		for _, item := range ch.Models {
			if item.Name == model && item.ContextTokens > 0 {
				return item.ContextTokens
			}
		}
	}
	if limits, ok := s.modelMetadata(model)["limit"].(map[string]any); ok {
		return number(limits["context"])
	}
	return 0
}

func (s *Controller) usageController(w http.ResponseWriter, r *http.Request) {
	hash := r.URL.Query().Get("workspaceHash")
	if hash == "" {
		writeFail(w, http.StatusOK, "workspaceHash 不能为空")
		return
	}
	view, err := s.projectRuntime(hash)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	name := r.URL.Query().Get("sessionName")
	// 外部 Agent 会话以 ACP 上报的占用为准（Java readAcp）。
	if name != "" {
		meta := view.sessionMetaRead(name)
		agentID := strOr(meta, "agentId", "native")
		if agentID == "looprax" {
			agentID = view.migrateRetiredAgent(name)
		}
		if agentID != "" && agentID != "native" {
			if acpView, ok := view.acpUsageView(meta, name); ok {
				estimate, _, _ := view.contextEstimate(r.Context(), name, false)
				acpView["contextEstimate"] = estimate
				writeOK(w, http.StatusOK, acpView)
				return
			}
		}
	}
	dir := filepath.Join(s.home, "workspace", view.agent.App(), "sessions")
	pattern := filepath.Join(dir, "*.usage")
	if name := r.URL.Query().Get("sessionName"); name != "" {
		pattern = filepath.Join(dir, jsonl.SanitizeName(name)+".usage")
	}
	paths, _ := filepath.Glob(pattern)
	total := usageRecord{}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var record usageRecord
		if json.Unmarshal(raw, &record) != nil {
			continue
		}
		total.Prompt += record.Prompt
		total.Completion += record.Completion
		total.CacheHit += record.CacheHit
		total.CacheMiss += record.CacheMiss
	}
	model := view.cfg.Model
	if name != "" {
		model = strOr(view.sessionMetaRead(name), "model", model)
	}
	if name == "" {
		name = view.currentSession()
	}
	estimate, lastPrompt, fresh := view.contextEstimate(r.Context(), name, true)
	total.LastPrompt = lastPrompt
	result := view.usageView(total, model)
	result["contextEstimate"] = estimate
	result["measuredFresh"] = fresh
	writeOK(w, http.StatusOK, result)
}

// contextEstimate 估算下一轮 prompt 的构成。对话部分按压缩后的事件视图
// 统计：被检查点覆盖的历史由摘要替代；native 会话还会应用已保存的工具
// 结果投影（只读重放，不产生新记录）。后两个返回值是同一可见历史的
// 最后一次实测 prompt 大小，以及实测是否仍反映当前结构。
func (s *Controller) contextEstimate(ctx context.Context, name string, native bool) (map[string]any, int64, bool) {
	instruction := s.turnInstruction(s.workspaceRoot())
	estimate := map[string]any{"systemTokens": (len(instruction) + 3) / 4, "toolDefinitionTokens": 0, "userTokens": 0, "assistantTokens": 0, "toolResultTokens": 0, "exactTokenizer": false, "estimator": "utf8-text-approximation"}
	if s.registry != nil {
		for _, entry := range s.registry.Entries() {
			if s.registry.Disabled(entry.Meta.Name) {
				continue
			}
			if decl, ok := entry.Tool.(interface {
				Declaration() *genai.FunctionDeclaration
			}); ok {
				raw, _ := json.Marshal(decl.Declaration())
				estimate["toolDefinitionTokens"] = estimate["toolDefinitionTokens"].(int) + (len(raw)+3)/4
			}
		}
	}
	var view agentpkg.ContextView
	if name != "" && s.agent != nil {
		if got, err := s.agent.Sessions.Get(ctx, &session.GetRequest{
			AppName: s.agent.App(), UserID: s.agent.User(), SessionID: name,
		}); err == nil && got.Session != nil {
			var events []*session.Event
			for ev := range got.Session.Events().All() {
				events = append(events, ev)
			}
			if native {
				view = s.agent.ContextView(events)
			} else {
				view = agentpkg.ContextViewOf(events)
			}
			chars := map[string]int{}
			for _, ev := range view.Events {
				if ev == nil || ev.Content == nil {
					continue
				}
				countEstimateChars(ev.Content, chars)
			}
			for field, n := range chars {
				estimate[field] = estimate[field].(int) + (n+3)/4
			}
		}
	}
	total := 0
	for _, field := range []string{"systemTokens", "toolDefinitionTokens", "userTokens", "assistantTokens", "toolResultTokens"} {
		total += estimate[field].(int)
	}
	estimate["totalTokens"] = total
	return estimate, view.LastPromptTokens, view.MeasuredFresh
}

// countEstimateChars 按 prompt 中的角色归类事件的字符量：
// 文本按内容角色计入用户或助手，函数调用计入助手，函数响应计入工具结果。
// 与压缩预算同口径，内联媒体不按 base64 文本计入。
func countEstimateChars(content *genai.Content, chars map[string]int) {
	for _, part := range content.Parts {
		if part == nil {
			continue
		}
		if part.Text != "" && !part.Thought {
			field := "assistantTokens"
			if content.Role == genai.RoleUser {
				field = "userTokens"
			}
			chars[field] += utf8.RuneCountInString(part.Text)
		}
		if part.FunctionCall != nil {
			raw, _ := json.Marshal(part.FunctionCall)
			chars["assistantTokens"] += utf8.RuneCount(raw)
		}
		if part.FunctionResponse != nil {
			response := *part.FunctionResponse
			response.Parts = nil
			raw, _ := json.Marshal(&response)
			chars["toolResultTokens"] += utf8.RuneCount(raw)
		}
	}
}

func (s *Controller) dashboardController(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	if days <= 0 {
		days = 7
	}
	if days > 365 {
		days = 365
	}
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	start := today.AddDate(0, 0, -days+1)
	daily := map[string]map[string]*usageRecord{}
	models := map[string]*usageRecord{}
	requests := map[string]int64{}
	modelRequests := map[string]int64{}
	if file, err := os.Open(filepath.Join(s.home, "usage_daily.jsonl")); err == nil {
		defer file.Close()
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 4096), 1<<20)
		for scanner.Scan() {
			var record usageRecord
			if json.Unmarshal(scanner.Bytes(), &record) != nil {
				continue
			}
			date := time.UnixMilli(record.TS).In(now.Location())
			if date.Before(start) || !date.Before(today.AddDate(0, 0, 1)) {
				continue
			}
			if record.Model == "" {
				record.Model = "unknown"
			}
			key := date.Format("2006-01-02")
			if daily[key] == nil {
				daily[key] = map[string]*usageRecord{}
			}
			if daily[key][record.Model] == nil {
				daily[key][record.Model] = &usageRecord{}
			}
			if models[record.Model] == nil {
				models[record.Model] = &usageRecord{}
			}
			for _, to := range []*usageRecord{daily[key][record.Model], models[record.Model]} {
				to.Prompt += record.Prompt
				to.Completion += record.Completion
				to.CacheHit += record.CacheHit
				to.CacheMiss += record.CacheMiss
			}
			requests[key]++
			modelRequests[record.Model]++
		}
	}
	total := usageRecord{}
	dailyStats := []map[string]any{}
	modelStats := []map[string]any{}
	cost := float64(0)
	totalRequests := int64(0)
	for i := 0; i < days; i++ {
		key := start.AddDate(0, 0, i).Format("2006-01-02")
		day := usageRecord{}
		breakdown := map[string]any{}
		dayCost := float64(0)
		for name, record := range daily[key] {
			view := s.usageView(*record, name)
			dayCost += view["totalCost"].(float64)
			breakdown[name] = map[string]any{"promptTokens": record.Prompt, "completionTokens": record.Completion, "cacheHit": record.CacheHit, "cacheMiss": record.CacheMiss, "totalTokens": record.Prompt + record.Completion}
			day.Prompt += record.Prompt
			day.Completion += record.Completion
			day.CacheHit += record.CacheHit
			day.CacheMiss += record.CacheMiss
		}
		total.Prompt += day.Prompt
		total.Completion += day.Completion
		total.CacheHit += day.CacheHit
		total.CacheMiss += day.CacheMiss
		cost += dayCost
		totalRequests += requests[key]
		dailyStats = append(dailyStats, map[string]any{"date": key, "promptTokens": day.Prompt, "completionTokens": day.Completion, "cacheHit": day.CacheHit, "cacheMiss": day.CacheMiss, "totalTokens": day.Prompt + day.Completion, "cost": math.Round(dayCost*1e4) / 1e4, "requests": requests[key], "modelBreakdown": breakdown})
	}
	prices := map[string]config.Price{}
	for name, record := range models {
		view := s.usageView(*record, name)
		price, ok := s.modelPrice(name)
		if ok {
			prices[name] = price
		}
		modelStats = append(modelStats, map[string]any{"model": name, "promptTokens": record.Prompt, "completionTokens": record.Completion, "cacheHit": record.CacheHit, "totalTokens": record.Prompt + record.Completion, "cost": math.Round(view["totalCost"].(float64)*1e4) / 1e4, "requests": modelRequests[name]})
	}
	sort.Slice(modelStats, func(i, j int) bool {
		return number(modelStats[i]["totalTokens"]) > number(modelStats[j]["totalTokens"])
	})
	writeOK(w, http.StatusOK, map[string]any{"totalPromptTokens": total.Prompt, "totalCompletionTokens": total.Completion, "totalCacheHit": total.CacheHit, "totalCacheMiss": total.CacheMiss, "totalCost": math.Round(cost*1e4) / 1e4, "activeDays": len(daily), "totalRequests": totalRequests, "dailyStats": dailyStats, "modelStats": modelStats, "modelPrices": prices})
}
