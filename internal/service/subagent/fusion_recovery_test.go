package subagent

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/ezdemo/looprax/internal/infrastructure/filediff"
)

// 未收尾的恢复要点按"交接被打断"呈现：进程在 end 之前消失只留下
// running 状态，独立读取磁盘文件（等价于重启）仍能拿到任务、最新
// 改动路径与逐个工具的终态，且不含原始工具输出。
func TestFusionRecoveryNoteFromUnclosedHandoff(t *testing.T) {
	dir := t.TempDir()
	p := startFusionRecovery(dir, "scope-a", "sub-1", "update settings")
	p.changed([]filediff.FileChange{{Path: "Settings.tsx"}})
	p.called("done", "shell", map[string]any{"command": "go test ./config"})
	p.finished("done", "shell", map[string]any{"exit_code": 0, "result": "RAW_RESULT_MARKER"})
	p.called("wait", "shell", map[string]any{"command": "go test ./ui"})

	state, ok := readFusionRecovery(dir, "scope-a")
	if !ok || state.Status != "running" {
		t.Fatalf("persisted state = %+v ok=%v", state, ok)
	}
	if len(state.Paths) != 1 || state.Paths[0] != "Settings.tsx" {
		t.Fatalf("paths = %v", state.Paths)
	}
	id, note := FusionRecoveryNote(dir, "scope-a")
	if id != "fusion-recovery-sub-1" {
		t.Fatalf("note id = %q", id)
	}
	for _, want := range []string{
		"Prior Fusion handoff",
		"state: interrupted; no terminal result",
		`task: "update settings"`,
		`changed: "Settings.tsx"`,
		`"shell" "go test ./ui": outcome unknown`,
		`"shell" "go test ./config": returned, exit=0`,
	} {
		if !strings.Contains(note, want) {
			t.Fatalf("note missing %q:\n%s", want, note)
		}
	}
	if strings.Contains(note, "RAW_RESULT_MARKER") {
		t.Fatalf("raw tool result leaked into note:\n%s", note)
	}
	if len(note) > fusionRecoveryMaxBytes || !utf8.ValidString(note) {
		t.Fatalf("note %d bytes valid=%v:\n%s", len(note), utf8.ValidString(note), note)
	}
}

// 恢复要点按作用域隔离：scope 不匹配时读不出、清不掉；end 之后
// 迟到的回调不再改写文件；匹配 scope 的确认删除文件。
func TestFusionRecoveryScopeGuardAndClear(t *testing.T) {
	dir := t.TempDir()
	p := startFusionRecovery(dir, "scope-a", "sub-1", "update settings")
	if id, note := FusionRecoveryNote(dir, "scope-b"); id != "" || note != "" {
		t.Fatalf("mismatched scope id=%q note=%q", id, note)
	}
	ClearFusionRecovery(dir, "scope-b")
	if _, err := os.Stat(filepath.Join(dir, fusionRecoveryFile)); err != nil {
		t.Fatalf("mismatched clear removed file: %v", err)
	}
	p.end("aborted", "")
	if _, note := FusionRecoveryNote(dir, "scope-a"); !strings.Contains(note, "state: interrupted") {
		t.Fatalf("aborted note = %q", note)
	}
	p.called("late", "shell", map[string]any{"command": "late"})
	p.finished("late", "shell", map[string]any{"exit_code": 1})
	p.changed([]filediff.FileChange{{Path: "late.go"}})
	if state, _ := readFusionRecovery(dir, "scope-a"); len(state.Tools) != 0 || len(state.Paths) != 0 {
		t.Fatalf("closed recovery still recorded activity: %+v", state)
	}
	ClearFusionRecovery(dir, "scope-a")
	if _, err := os.Stat(filepath.Join(dir, fusionRecoveryFile)); !os.IsNotExist(err) {
		t.Fatalf("matching clear left file: %v", err)
	}
	if id, note := FusionRecoveryNote(dir, "scope-a"); id != "" || note != "" {
		t.Fatalf("note after clear id=%q note=%q", id, note)
	}
}

// 交接先于主代理轮次结束完成：要点仍保留给被打断的下一轮，
// 附带截断后的执行回复，直到主轮次成功收尾才被清除。
func TestFusionRecoveryCompletedBeforeLeadFinished(t *testing.T) {
	dir := t.TempDir()
	p := startFusionRecovery(dir, "scope-a", "sub-1", "update settings")
	p.end("completed", "worker final answer")
	_, note := FusionRecoveryNote(dir, "scope-a")
	for _, want := range []string{
		"state: handoff returned before lead turn finished",
		`worker reply: "worker final answer"`,
	} {
		if !strings.Contains(note, want) {
			t.Fatalf("completed note missing %q:\n%s", want, note)
		}
	}
}

// 失败交接如实标注，且要点始终限制在 2 KiB 内的合法 UTF-8：
// 长 Unicode 任务、路径与工具目标在中间截断也不会产生坏字节，
// 原始工具输出永远不进入要点。
func TestFusionRecoveryNoteBoundedUTF8(t *testing.T) {
	dir := t.TempDir()
	p := startFusionRecovery(dir, "scope-a", "sub-2", strings.Repeat("界面重构任务", 40))
	for i := 0; i < 12; i++ {
		p.changed([]filediff.FileChange{{Path: fmt.Sprintf("%s-%d.tsx", strings.Repeat("目录/文件名", 6), i)}})
		id := fmt.Sprintf("调用标识-%d", i)
		p.called(id, "shell", map[string]any{"command": strings.Repeat("执行超长命令", 20)})
		p.finished(id, "shell", map[string]any{"result": strings.Repeat("原始结果", 200)})
	}
	p.changed([]filediff.FileChange{{Path: strings.Repeat("目录/", 40) + "last-edited.tsx"}})
	p.end("error", strings.Repeat("失败详情", 50))
	_, note := FusionRecoveryNote(dir, "scope-a")
	if len(note) <= 500 || len(note) > fusionRecoveryMaxBytes || !utf8.ValidString(note) {
		t.Fatalf("note %d bytes valid=%v:\n%s", len(note), utf8.ValidString(note), note)
	}
	if strings.Contains(note, "原始结果") {
		t.Fatalf("raw result leaked:\n%s", note)
	}
	if !strings.Contains(note, "state: handoff failed") {
		t.Fatalf("error note = %q", note)
	}
	changedTail := false
	for _, line := range strings.Split(note, "\n") {
		if strings.HasPrefix(line, "changed: ") && strings.HasSuffix(line, `last-edited.tsx"`) {
			changedTail = true
		}
	}
	if !changedTail {
		t.Fatalf("no changed line keeps the basename:\n%s", note)
	}
}

// 工具终态在单个调用完成时落盘，不依赖合并事件或 SSE 接收端：
// 没有 sink 时结果照样进要点，等待审批的占位结果不算完成。
func TestSubToolResultsFeedsRecoveryWithoutSink(t *testing.T) {
	dir := t.TempDir()
	p := startFusionRecovery(dir, "scope-a", "sub-3", "task")
	results := newSubToolResults(7, nil, p)
	results.ToolFinished("c1", "shell", map[string]any{"result": "ok", "exit_code": 0})
	results.ToolFinished("gate", "shell", map[string]any{"error": "operation requires confirmation, please approve or reject"})
	state, ok := readFusionRecovery(dir, "scope-a")
	if !ok || len(state.Tools) != 1 {
		t.Fatalf("tools = %+v ok=%v", state.Tools, ok)
	}
	if got := state.Tools[0]; got.ID != "c1" || got.Status != "returned" || got.Exit != "0" {
		t.Fatalf("tool = %+v", got)
	}
}
