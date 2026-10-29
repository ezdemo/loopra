package hitl

import (
	"context"
	"testing"
	"time"
)

func formSchema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []any{"branch"},
		"properties": map[string]any{
			"branch": map[string]any{"type": "string", "maxLength": float64(5)},
			"force":  map[string]any{"type": "boolean"},
			"count":  map[string]any{"type": "integer", "minimum": float64(0)},
			"mode":   map[string]any{"type": "string", "enum": []any{"fast", "safe"}},
		},
	}
}

func TestElicitationValidatesForm(t *testing.T) {
	registry := NewElicitationRegistry()
	item := registry.Register("s1", "请确认", formSchema())
	go func() {
		time.Sleep(10 * time.Millisecond)
		if err := registry.Resolve(item.ID, "s1", "accept", map[string]any{
			"branch": "feat", "force": true, "count": float64(2), "mode": "fast",
		}); err != nil {
			t.Errorf("resolve: %v", err)
			// 校验失败时唤醒等待方，避免测试挂死。
			registry.Cancel("s1")
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	answer, ok := registry.Wait(ctx, item)
	if !ok || answer.Action != "accept" {
		t.Fatalf("answer = %+v ok=%v", answer, ok)
	}
	if answer.Content["branch"] != "feat" {
		t.Fatalf("content = %+v", answer.Content)
	}
}

func TestElicitationRejectsInvalidAnswers(t *testing.T) {
	registry := NewElicitationRegistry()
	cases := []map[string]any{
		{},                                      // 缺少必答项
		{"branch": "too-long"},                  // maxLength
		{"branch": "ok", "count": float64(1.5)}, // integer
		{"branch": "ok", "count": float64(-1)},  // minimum
		{"branch": "ok", "mode": "turbo"},       // enum
		{"branch": "ok", "unknown": "field"},    // 未知字段
	}
	for index, content := range cases {
		item := registry.Register("s1", "请确认", formSchema())
		if err := registry.Resolve(item.ID, "s1", "accept", content); err == nil {
			t.Fatalf("case %d should fail: %+v", index, content)
		}
	}
}

func TestElicitationCancelReleasesWaiter(t *testing.T) {
	registry := NewElicitationRegistry()
	item := registry.Register("s1", "请确认", formSchema())
	go func() {
		time.Sleep(10 * time.Millisecond)
		registry.Cancel("s1")
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	answer, _ := registry.Wait(ctx, item)
	if answer.Action != "cancel" {
		t.Fatalf("answer = %+v", answer)
	}
	if len(registry.Pending("s1")) != 0 {
		t.Fatal("pending should be cleared")
	}
}
