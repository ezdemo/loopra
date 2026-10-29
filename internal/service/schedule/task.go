package schedule

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/model"
)

// NextRunAt 计算任务的下次执行时间：优先使用 cron，
// 否则为 base+interval；已禁用的任务返回 0。
func NextRunAt(task model.ScheduledTask) int64 {
	if !task.Enabled {
		return 0
	}
	base := time.Now()
	if task.LastRunAt > 0 {
		base = time.UnixMilli(task.LastRunAt)
	}
	if task.CronExpr != "" {
		if cron, err := ParseCron(task.CronExpr); err == nil {
			if next, ok := cron.Next(base); ok {
				return next.UnixMilli()
			}
		}
		return 0
	}
	if task.IntervalSec > 0 {
		return base.Add(time.Duration(task.IntervalSec) * time.Second).UnixMilli()
	}
	return 0
}

// ValidateTask 校验 Java 的规则。
func ValidateTask(task model.ScheduledTask, fields map[string]json.RawMessage, required bool) error {
	has := func(key string) bool { raw, ok := fields[key]; return ok && string(raw) != "null" }
	if required && strings.TrimSpace(task.Message) == "" {
		return fmt.Errorf("消息内容不能为空")
	}
	if task.SessionMode != "" && task.SessionMode != "existing" && task.SessionMode != "independent" {
		return fmt.Errorf("无效的会话方式")
	}
	if task.SessionMode != "independent" && (required || task.SessionMode == "existing" || has("sessionName")) && strings.TrimSpace(task.SessionName) == "" {
		return fmt.Errorf("目标会话名称不能为空")
	}
	if strings.TrimSpace(task.CronExpr) != "" {
		if _, err := ParseCron(task.CronExpr); err != nil {
			return fmt.Errorf("Cron 表达式无效")
		}
		return nil
	}
	if has("intervalSec") {
		if task.IntervalSec <= 0 {
			return fmt.Errorf("执行间隔必须大于 0 秒")
		}
		return nil
	}
	if required || has("cronExpr") {
		return fmt.Errorf("请选择有效的执行时间")
	}
	return nil
}
