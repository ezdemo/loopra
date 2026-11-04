package tools

import (
	"fmt"
	"strings"

	adkagent "google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/tool/functiontool"

	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/service/memory"
)

type memoryIndexEntry struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func MemoryTools(service *memory.Service, project string) []Tool {
	resolve := func(scope string) (string, error) {
		switch scope {
		case "global":
			return "", nil
		case "project":
			if project != "" {
				return project, nil
			}
		}
		return "", fmt.Errorf("请选择 global 或当前项目可用的 project 作用域")
	}
	type searchInput struct {
		Action string `json:"action,omitempty" jsonschema:"list 列记忆目录（仅 ID 和标题）；read 按 ID 读取正文；search 按关键词搜索正文。默认 list；省略 action 且传非空 query 时兼容 search"`
		ID     string `json:"id,omitempty" jsonschema:"read 时必填，使用目录中的 ID，并明确指定 scope"`
		Query  string `json:"query,omitempty" jsonschema:"search 时必填，按标题和内容检索，用空格分隔多个关键词"`
		Scope  string `json:"scope,omitempty" jsonschema:"global 或 project；list/search 省略时同时查询全局和当前项目，read 时必填"`
		Offset int    `json:"offset,omitempty" jsonschema:"从零开始的分页偏移，默认 0"`
		Limit  int    `json:"limit,omitempty" jsonschema:"每个作用域的返回条数，默认 10，最多 20"`
	}
	search, _ := functiontool.New[searchInput, map[string]any](functiontool.Config{Name: "memory_search", Description: "先用 action=list 查看全局和当前项目的记忆目录（仅 ID 和标题），再按需要用 action=read、scope、id 读取正文。目录较多时可分页或用 action=search 搜索。更新前读取最新 revision。"}, func(_ adkagent.Context, in searchInput) (map[string]any, error) {
		in.Query = strings.TrimSpace(in.Query)
		action := in.Action
		if action == "" {
			action = "list"
			if strings.TrimSpace(in.Query) != "" {
				action = "search"
			}
		}
		if action == "read" {
			if in.ID == "" || in.Scope == "" || in.Query != "" || in.Offset != 0 || in.Limit != 0 {
				return nil, fmt.Errorf("%w: read 只需提供 scope 和 id", memory.ErrInvalid)
			}
			key, err := resolve(in.Scope)
			if err != nil {
				return nil, err
			}
			entry, err := service.Read(key, in.ID)
			if err != nil {
				return nil, err
			}
			return map[string]any{"scope": in.Scope, "entry": entry}, nil
		}
		if (action != "list" && action != "search") || in.ID != "" || (action == "list" && in.Query != "") || (action == "search" && strings.TrimSpace(in.Query) == "") {
			return nil, fmt.Errorf("%w: 使用 list 列目录、read 读正文或 search 配合 query 搜索", memory.ErrInvalid)
		}
		if in.Offset < 0 || in.Limit < 0 || in.Limit > 20 {
			return nil, fmt.Errorf("offset 必须非负，limit 必须为 0–20")
		}
		if in.Limit == 0 {
			in.Limit = 10
		}
		out := map[string]any{}
		scopes := []string{in.Scope}
		if in.Scope == "" {
			scopes = []string{"global"}
			if project != "" {
				scopes = append(scopes, "project")
			}
		}
		for _, scope := range scopes {
			key, err := resolve(scope)
			if err != nil {
				return nil, err
			}
			entries, err := service.List(key, in.Query)
			if err != nil {
				return nil, err
			}
			start := min(in.Offset, len(entries))
			end := start + min(in.Limit, len(entries)-start)
			out[scope] = map[string]any{"entries": entries[start:end], "total": len(entries), "offset": start}
			if action == "list" {
				index := make([]memoryIndexEntry, 0, end-start)
				for _, entry := range entries[start:end] {
					index = append(index, memoryIndexEntry{ID: entry.ID, Title: entry.Title})
				}
				out[scope] = map[string]any{"entries": index, "total": len(entries), "offset": start}
			}
		}
		return out, nil
	})
	type writeInput struct {
		Action   string `json:"action" jsonschema:"save 保存或更新；delete 删除指定记忆"`
		Scope    string `json:"scope" jsonschema:"global 全局个人偏好和本机环境；project 当前项目背景和项目专属偏好"`
		ID       string `json:"id,omitempty" jsonschema:"更新或删除时必填，使用 memory_search 返回的 ID；新增时省略"`
		Revision int64  `json:"revision,omitempty" jsonschema:"更新或删除时必填，使用最新 revision；冲突后重新检索，不要盲目覆盖"`
		Title    string `json:"title,omitempty" jsonschema:"保存时必填，简短且能说明用途的标题，例如 Node.js 版本管理方式，最多 120 字；一条记忆一个主题"`
		Content  string `json:"content,omitempty" jsonschema:"保存时必填，明确可复用的事实或偏好，最多 4000 字；环境信息应注明观察时间与适用机器"`
		Kind     string `json:"kind,omitempty" jsonschema:"保存时必填：fact 背景事实、preference 偏好、environment 环境"`
	}
	write, _ := functiontool.New[writeInput, map[string]any](functiontool.Config{Name: "memory", Description: "保存、更新或删除长期记忆。先检索避免重复；主动记录明确且可复用的信息，排除密钥、推测和临时任务进度。用户修正后更新原条目，环境信息在使用前重新核实。"}, func(_ adkagent.Context, in writeInput) (map[string]any, error) {
		key, err := resolve(in.Scope)
		if err != nil {
			return nil, err
		}
		switch in.Action {
		case "save":
			entry, err := service.Save(key, model.Memory{ID: in.ID, Revision: in.Revision, Title: in.Title, Content: in.Content, Kind: in.Kind}, "agent")
			if err != nil {
				return nil, err
			}
			return map[string]any{"scope": in.Scope, "entry": entry}, nil
		case "delete":
			if err := service.Delete(key, in.ID, in.Revision); err != nil {
				return nil, err
			}
			return map[string]any{"deleted": in.ID, "scope": in.Scope}, nil
		default:
			return nil, fmt.Errorf("action 必须为 save 或 delete")
		}
	})
	return []Tool{
		{Tool: search, Meta: Metadata{Name: search.Name(), Description: search.Description(), ReadOnly: true, AutoApprove: true, Chat: true}},
		{Tool: write, Meta: Metadata{Name: write.Name(), Description: write.Description(), AutoApprove: true, Chat: true}},
	}
}
