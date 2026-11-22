package subagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"

	"google.golang.org/adk/v2/session"

	"github.com/ezdemo/looprax/internal/repository"
)

// fusionAgentName 是同一个边缘会话历次委派共享的 ADK 智能体名。
const fusionAgentName = "fusion-sidekick"

// fusionCheckpointFile 是放在父会话 .sub 目录里的私有检查点：
// 记录上一次成功交接后的完整事件列表，重启或下一轮委派时续用。
// 它不是 .sub/*.jsonl 审计日志，也不出现在 /api/sub-sessions 列表。
const fusionCheckpointFile = ".fusion-context.json"

// fusionCheckpoint 是一次成功交接留下的执行上下文快照。
type fusionCheckpoint struct {
	Scope  string           `json:"scope"`
	Events []*session.Event `json:"events"`
}

// restoreFusionCheckpoint 把与 scope 匹配的检查点事件按序回放到新
// 会话。文件不存在或作用域不同都是干净起步；损坏或缺作用域的文件
// 报错且不覆盖原记录，由用户新建会话重建上下文。
func restoreFusionCheckpoint(ctx context.Context, path, scope string, store session.Service, current session.Session) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取 Fusion 执行上下文失败: %w", err)
	}
	var checkpoint fusionCheckpoint
	if err := json.Unmarshal(raw, &checkpoint); err != nil {
		return fmt.Errorf("Fusion 执行上下文已损坏，未覆盖原记录；请新建会话后重试: %w", err)
	}
	if checkpoint.Scope == "" {
		return fmt.Errorf("Fusion 执行上下文缺少作用域，未覆盖原记录；请新建会话后重试")
	}
	if checkpoint.Scope != scope {
		return nil
	}
	for _, event := range checkpoint.Events {
		if err := ctx.Err(); err != nil {
			return err
		}
		if event == nil || event.Partial {
			continue
		}
		if err := store.AppendEvent(ctx, current, event); err != nil {
			return fmt.Errorf("恢复 Fusion 执行上下文失败: %w", err)
		}
	}
	return nil
}

// saveFusionCheckpoint 把本次会话的完整事件写成新的唯一检查点。
// 只在交接成功且未取消时调用：原子替换保证失败或中断不会截断
// 上一次成功的上下文。
func saveFusionCheckpoint(ctx context.Context, path, scope string, store session.Service, current session.Session) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	got, err := store.Get(ctx, &session.GetRequest{
		AppName: current.AppName(), UserID: current.UserID(), SessionID: current.ID(),
	})
	if err != nil {
		return fmt.Errorf("读取 Fusion 执行上下文失败: %w", err)
	}
	// Events().All() 取原始事件而非投影视图，StateDelta 等动作保留。
	data, err := json.Marshal(fusionCheckpoint{Scope: scope, Events: slices.Collect(got.Session.Events().All())})
	if err != nil {
		return fmt.Errorf("序列化 Fusion 执行上下文失败: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := repository.WriteFile(path, data); err != nil {
		return fmt.Errorf("保存 Fusion 执行上下文失败: %w", err)
	}
	return nil
}
