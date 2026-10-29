// Package schedule 复现 Java 端 CronParser（带秒的 6 字段 cron）
// 以及定时任务存储的语义。
package schedule

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Cron 表示一条解析后的 6 字段表达式：秒 分 时 日 月 周，
// 每个字段都支持 *、?、列表、范围与步长。
type Cron struct {
	seconds, minutes, hours, months *fieldSet
	dom, dow                        *fieldSet
	domStar, dowStar                bool
}

// fieldSet 保存单个字段匹配到的取值。
type fieldSet struct {
	values map[int]bool
}

func newFieldSet() *fieldSet { return &fieldSet{values: map[int]bool{}} }

func (f *fieldSet) add(v int)      { f.values[v] = true }
func (f *fieldSet) has(v int) bool { return f.values[v] }

// parseField 按给定的闭区间解析单个字段；
// 超出范围的步长基数会被收紧到 min。
func parseField(expr string, min, max int, week bool) (*fieldSet, bool, error) {
	set := newFieldSet()
	star := false
	if expr == "*" || expr == "?" {
		star = true
		for v := min; v <= max; v++ {
			set.add(v)
		}
		return set, star, nil
	}
	for _, part := range strings.Split(expr, ",") {
		part = strings.TrimSpace(part)
		step := 1
		if i := strings.Index(part, "/"); i >= 0 {
			s, err := strconv.Atoi(part[i+1:])
			if err != nil || s <= 0 {
				return nil, false, fmt.Errorf("无效的 cron 步长: %s", part)
			}
			step = s
			part = part[:i]
		}
		lo, hi := min, max
		switch {
		case part == "*" || part == "":
			// */m 作用于整个范围
		case strings.Contains(part, "-"):
			bounds := strings.SplitN(part, "-", 2)
			var err error
			if lo, err = strconv.Atoi(bounds[0]); err != nil {
				return nil, false, fmt.Errorf("无效的 cron 范围: %s", part)
			}
			if hi, err = strconv.Atoi(bounds[1]); err != nil {
				return nil, false, fmt.Errorf("无效的 cron 范围: %s", part)
			}
		default:
			v, err := strconv.Atoi(part)
			if err != nil {
				return nil, false, fmt.Errorf("无效的 cron 字段: %s", part)
			}
			lo, hi = v, v
		}
		if lo < min || hi > max || lo > hi {
			return nil, false, fmt.Errorf("cron 字段越界: %s", expr)
		}
		for v := lo; v <= hi; v += step {
			if week && v == 7 {
				set.add(0) // 0 和 7 都表示周日
			} else {
				set.add(v)
			}
		}
	}
	return set, star, nil
}

// ParseCron 解析 6 字段表达式。
func ParseCron(expr string) (*Cron, error) {
	fields := strings.Fields(strings.TrimSpace(expr))
	if len(fields) != 6 {
		return nil, fmt.Errorf("cron 表达式必须是 6 个字段（秒 分 时 日 月 周）: %s", expr)
	}
	var c Cron
	var err error
	if c.seconds, _, err = parseField(fields[0], 0, 59, false); err != nil {
		return nil, err
	}
	if c.minutes, _, err = parseField(fields[1], 0, 59, false); err != nil {
		return nil, err
	}
	if c.hours, _, err = parseField(fields[2], 0, 23, false); err != nil {
		return nil, err
	}
	if c.dom, c.domStar, err = parseField(fields[3], 1, 31, false); err != nil {
		return nil, err
	}
	if c.months, _, err = parseField(fields[4], 1, 12, false); err != nil {
		return nil, err
	}
	if c.dow, c.dowStar, err = parseField(fields[5], 0, 7, true); err != nil {
		return nil, err
	}
	return &c, nil
}

// dayMatches 遵循标准 cron 的日期语义：两个日期字段都被限定时，
// 任一匹配即视为当天匹配。
func (c *Cron) dayMatches(t time.Time) bool {
	domOK := c.dom.has(t.Day())
	dowOK := c.dow.has(int(t.Weekday()))
	if !c.domStar && !c.dowStar {
		return domOK || dowOK
	}
	if !c.domStar {
		return domOK
	}
	if !c.dowStar {
		return dowOK
	}
	return true
}

// Next 返回严格晚于给定基准时间的首个匹配时刻
// （搜索窗口为 4 年，与 CronParser.nextTime 一致）。
func (c *Cron) Next(after time.Time) (time.Time, bool) {
	t := after.Truncate(time.Second).Add(time.Second)
	limit := t.AddDate(4, 0, 0)
	for t.Before(limit) {
		if !c.months.has(int(t.Month())) {
			t = time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, t.Location()).AddDate(0, 1, 0)
			continue
		}
		if !c.dayMatches(t) {
			t = time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location()).AddDate(0, 0, 1)
			continue
		}
		if !c.hours.has(t.Hour()) {
			t = t.Truncate(time.Hour).Add(time.Hour)
			continue
		}
		if !c.minutes.has(t.Minute()) {
			t = t.Truncate(time.Minute).Add(time.Minute)
			continue
		}
		if !c.seconds.has(t.Second()) {
			t = t.Add(time.Second)
			continue
		}
		return t, true
	}
	return time.Time{}, false
}
