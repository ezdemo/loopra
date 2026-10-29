package schedule

import (
	"testing"
	"time"
)

func mustParse(t *testing.T, expr string) *Cron {
	t.Helper()
	c, err := ParseCron(expr)
	if err != nil {
		t.Fatalf("parse %s: %v", expr, err)
	}
	return c
}

func TestCronEvery5Seconds(t *testing.T) {
	c := mustParse(t, "*/5 * * * * ?")
	base := time.Date(2026, 10, 27, 12, 0, 3, 0, time.Local)
	next, ok := c.Next(base)
	if !ok || next.Second() != 5 || next.Minute() != 0 {
		t.Fatalf("next = %v", next)
	}
	after, _ := c.Next(next)
	if !after.Equal(next.Add(5 * time.Second)) {
		t.Fatalf("chain = %v -> %v", next, after)
	}
}

func TestCronDailyAt(t *testing.T) {
	c := mustParse(t, "0 30 8 * * ?")
	base := time.Date(2026, 10, 27, 9, 0, 0, 0, time.Local) // 位于当天执行时间之后
	next, ok := c.Next(base)
	if !ok {
		t.Fatal("no next")
	}
	if next.Day() != 28 || next.Hour() != 8 || next.Minute() != 30 {
		t.Fatalf("next = %v", next)
	}
}

func TestCronWeekdayRange(t *testing.T) {
	// 周一到周五 09:00
	c := mustParse(t, "0 0 9 ? * 1-5")
	base := time.Date(2026, 10, 30, 0, 0, 0, 0, time.Local) // 周五 2026-10-30
	next, ok := c.Next(base)
	if !ok {
		t.Fatal("no next")
	}
	// 周五 9:00 在 00:00 已经过了吗？没有—— 00:00 早于 09:00，
	// 因此下一次就是周五 09:00 本身。
	if next.Weekday() != time.Friday || next.Hour() != 9 {
		t.Fatalf("next = %v (%v)", next, next.Weekday())
	}
	// 以周六为基准会跳到周一
	sat := time.Date(2026, 10, 31, 10, 0, 0, 0, time.Local)
	next, _ = c.Next(sat)
	if next.Weekday() != time.Monday {
		t.Fatalf("weekend skip = %v (%v)", next, next.Weekday())
	}
}

func TestCronSundayAs7(t *testing.T) {
	c := mustParse(t, "0 0 12 ? * 7")                       // 7 表示周日
	base := time.Date(2026, 10, 27, 0, 0, 0, 0, time.Local) // 周二
	next, ok := c.Next(base)
	if !ok {
		t.Fatal("no next")
	}
	if next.Weekday() != time.Sunday {
		t.Fatalf("next = %v (%v)", next, next.Weekday())
	}
}

func TestCronListAndStep(t *testing.T) {
	c := mustParse(t, "30 0,15,30 10-12 1 * ?")
	base := time.Date(2026, 10, 1, 9, 0, 0, 0, time.Local)
	next, ok := c.Next(base)
	if !ok {
		t.Fatal("no next")
	}
	if next.Hour() != 10 || next.Minute() != 0 || next.Second() != 30 {
		t.Fatalf("next = %v", next)
	}
}

func TestCronInvalid(t *testing.T) {
	for _, expr := range []string{"* * * * *", "60 * * * * ?", "* * * * * 8", "abc * * * * ?", "* * 25 * * ?"} {
		if _, err := ParseCron(expr); err == nil {
			t.Fatalf("accepted %q", expr)
		}
	}
}

func TestCronMonthSkip(t *testing.T) {
	// 2 月 29 日只存在于闰年；搜索会推进到 2028 年
	c := mustParse(t, "0 0 0 29 2 ?")
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.Local)
	next, ok := c.Next(base)
	if !ok {
		t.Fatal("no next in 4 years")
	}
	if next.Day() != 29 || next.Month() != time.February || next.Year() != 2028 {
		t.Fatalf("next = %v", next)
	}
}
