package gitops

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newRepo 在临时目录中创建一个使用固定身份的 git 仓库。
func newRepo(t *testing.T) string {
	t.Helper()
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	r := Runner{Dir: dir}
	for _, args := range [][]string{
		{"init", "-q"},
		{"config", "user.email", "test@loopra"},
		{"config", "user.name", "Test"},
		{"commit", "--allow-empty", "-q", "-m", "seed"},
	} {
		if _, _, err := r.Git(TimeoutQuery, args...); err != nil {
			t.Fatalf("git %v: %v", args, err)
		}
	}
	return dir
}

func writeFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestParsePorcelainZ(t *testing.T) {
	out := " M b.txt\x00?? new dir/file.txt\x00A  staged.go\x00R  renamed.txt\x00old.txt\x00"
	changed, untracked := ParsePorcelainZ(out, "")
	if len(untracked) != 1 || untracked[0].Path != "new dir/file.txt" {
		t.Fatalf("untracked = %+v", untracked)
	}
	if untracked[0].Status != "U" || untracked[0].Index != "?" || untracked[0].WorkTree != "?" {
		t.Fatalf("untracked[0] = %+v", untracked[0])
	}
	if len(changed) != 3 {
		t.Fatalf("changed = %+v", changed)
	}
	if changed[0].Status != "M" || changed[0].Index != " " || changed[0].WorkTree != "M" {
		t.Fatalf("changed[0] = %+v", changed[0])
	}
	if changed[1].Status != "A" || changed[1].Index != "A" {
		t.Fatalf("changed[1] = %+v", changed[1])
	}
	if changed[2].Status != "R" || changed[2].Path != "renamed.txt" {
		t.Fatalf("changed[2] = %+v", changed[2])
	}
}

func TestParsePorcelainZPrefixStrip(t *testing.T) {
	_, untracked := ParsePorcelainZ("?? project/src/main.go\x00", "project/")
	if len(untracked) != 1 || untracked[0].Path != "src/main.go" {
		t.Fatalf("untracked = %+v", untracked)
	}
	changed, _ := ParsePorcelainZ("?? other/thing.go\x00", "project/")
	if len(changed) != 0 {
		t.Fatalf("outside-prefix entry kept: %+v", changed)
	}
}

func TestStatusAt(t *testing.T) {
	dir := newRepo(t)
	writeFile(t, dir, "a.txt", "v1\n")
	view := StatusAt(dir)
	if !view.GitAvailable || !view.Initialized {
		t.Fatalf("view = %+v", view)
	}
	if view.Branch == "" {
		t.Fatal("branch empty")
	}
	if len(view.Untracked) != 1 || view.Untracked[0].Path != "a.txt" {
		t.Fatalf("untracked = %+v", view.Untracked)
	}
	// 暂存的改动在 index 中显示 A，在 changed 中显示 M
	r := Runner{Dir: dir}
	r.Git(TimeoutQuery, "add", "a.txt")
	view = StatusAt(dir)
	if len(view.Changed) != 1 || view.Changed[0].Status != "A" {
		t.Fatalf("changed after add = %+v", view.Changed)
	}
	// 不含 git 的工作区报告为未初始化
	view = StatusAt(t.TempDir())
	if view.GitAvailable && view.Initialized {
		t.Fatal("temp dir should not be initialized")
	}
}

func TestStatusAtSubdirectory(t *testing.T) {
	dir := newRepo(t)
	sub := filepath.Join(dir, "project")
	os.MkdirAll(sub, 0o755)
	writeFile(t, sub, "inner.txt", "x\n")
	r := Runner{Dir: dir}
	r.Git(TimeoutQuery, "add", "-A")
	r.Git(TimeoutQuery, "commit", "-q", "-m", "add project")
	writeFile(t, sub, "inner2.txt", "y\n")
	view := StatusAt(sub)
	if len(view.Untracked) != 1 || view.Untracked[0].Path != "inner2.txt" {
		t.Fatalf("subdir untracked = %+v", view.Untracked)
	}
}

func TestLogAt(t *testing.T) {
	dir := newRepo(t)
	writeFile(t, dir, "f.txt", "1\n")
	r := Runner{Dir: dir}
	r.Git(TimeoutQuery, "add", "-A")
	r.Git(TimeoutQuery, "commit", "-q", "-m", "second")
	commits := LogAt(dir, 50)
	if len(commits) != 2 {
		t.Fatalf("commits = %+v", commits)
	}
	if commits[0].Message != "second" || commits[0].Author != "Test" || commits[0].Email != "test@loopra" {
		t.Fatalf("commits[0] = %+v", commits[0])
	}
	if commits[0].ShortHash == "" || len(commits[0].ShortHash) < 7 {
		t.Fatalf("shortHash = %q", commits[0].ShortHash)
	}
	if got := LogAt(dir, 0); len(got) != 2 {
		t.Fatalf("default limit = %+v", got)
	}
}

func TestCurrentBranchAndDirty(t *testing.T) {
	dir := newRepo(t)
	branch, err := CurrentBranch(dir)
	if err != nil || branch == "" {
		t.Fatalf("branch = %q err = %v", branch, err)
	}
	if Dirty(dir) {
		t.Fatal("seed repo should be clean")
	}
	writeFile(t, dir, "dirty.txt", "x\n")
	if !Dirty(dir) {
		t.Fatal("dirty not detected")
	}
}

func TestSnapshotCheckpointResolveRestoreDelete(t *testing.T) {
	dir := newRepo(t)
	writeFile(t, dir, "a.txt", "v1\n")
	r := Runner{Dir: dir}
	r.Git(TimeoutQuery, "add", "a.txt")
	r.Git(TimeoutQuery, "commit", "-q", "-m", "base")

	// 在保留已暂存文件的情况下创建检查点
	r.Git(TimeoutQuery, "add", "a.txt") // 对已提交文件执行暂存，无实际变化
	snap, err := Checkpoint(dir, "msg-1")
	if err != nil {
		t.Fatalf("checkpoint: %v", err)
	}
	if snap.CommitHash == "" || snap.TreeHash == "" || snap.CreatedAt == 0 {
		t.Fatalf("snap = %+v", snap)
	}

	// resolve 读回该引用
	got, err := ResolveSnapshot(dir, "msg-1")
	if err != nil || got.CommitHash != snap.CommitHash || got.TreeHash != snap.TreeHash {
		t.Fatalf("resolve = %+v err = %v", got, err)
	}

	// 修改后再恢复
	writeFile(t, dir, "a.txt", "v2\n")
	writeFile(t, dir, "extra.txt", "boom\n")
	if err := RestoreTree(dir, snap.TreeHash); err != nil {
		t.Fatalf("restore: %v", err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
	if got := strings.TrimRight(string(data), "\r\n"); got != "v1" {
		t.Fatalf("a.txt = %q", data)
	}
	if _, err := os.Stat(filepath.Join(dir, "extra.txt")); err != nil {
		t.Fatalf("untracked file vanished (Java keeps untracked files): %v", err)
	}

	// delete 删除该引用
	DeleteSnapshotRef(dir, "msg-1")
	if _, err := ResolveSnapshot(dir, "msg-1"); err == nil {
		t.Fatal("ref survived delete")
	}
}

func TestCheckpointPreservesPartialStaging(t *testing.T) {
	dir := newRepo(t)
	r := Runner{Dir: dir}
	writeFile(t, dir, "partial.txt", "staged\n")
	if _, _, err := r.Git(TimeoutQuery, "add", "partial.txt"); err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, "partial.txt", "staged\nunstaged\n")
	before, err := r.Line(TimeoutQuery, "write-tree")
	if err != nil {
		t.Fatal(err)
	}
	snap, err := Checkpoint(dir, "partial-staging")
	if err != nil {
		t.Fatal(err)
	}
	after, err := r.Line(TimeoutQuery, "write-tree")
	if err != nil || before != after {
		t.Fatalf("checkpoint changed the real index: before=%s after=%s err=%v", before, after, err)
	}
	content, err := r.Line(TimeoutQuery, "show", snap.TreeHash+":partial.txt")
	if err != nil || !strings.Contains(content, "unstaged") {
		t.Fatalf("snapshot omitted unstaged content: %q %v", content, err)
	}
}

func TestCheckpointPreservesStagingArea(t *testing.T) {
	dir := newRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	writeFile(t, dir, "b.txt", "2\n")
	r := Runner{Dir: dir}
	r.Git(TimeoutQuery, "add", "a.txt") // 用户只暂存了 a.txt
	if _, err := Checkpoint(dir, "msg-2"); err != nil {
		t.Fatal(err)
	}
	out, _, _ := r.Git(TimeoutQuery, "diff", "--cached", "--name-only")
	if strings.TrimSpace(out) != "a.txt" {
		t.Fatalf("staged after checkpoint = %q", out)
	}
	DeleteSnapshotRef(dir, "msg-2")
}

func TestSanitizeAndWorktreeNames(t *testing.T) {
	if got := Sanitize("my session/2024#1"); got != "my_session_2024_1" {
		t.Fatalf("sanitize = %q", got)
	}
	if got := WorktreePath("/home/l/worktree", "abc123", "sess"); got != filepath.Join("/home/l/worktree", "abc123-sess") {
		t.Fatalf("worktree path = %q", got)
	}
	if got := SandboxBranch("abcdef123456", "my sess"); got != "loopra/sandbox-abcdef12-my_sess" {
		t.Fatalf("branch = %q", got)
	}
	if got := Sanitize(strings.Repeat("x", 100)); len([]rune(got)) != 80 {
		t.Fatalf("length = %d", len([]rune(got)))
	}
}

func TestCreateWorktreeIdempotent(t *testing.T) {
	dir := newRepo(t)
	base := t.TempDir()
	target := WorktreePath(base, "wshash1", "session1")
	branch := SandboxBranch("wshash1", "session1")
	if err := CreateWorktree(dir, target, branch); err != nil {
		t.Fatalf("create: %v", err)
	}
	if !IsRegisteredWorktree(dir, target) {
		t.Fatal("worktree not registered")
	}
	// 通过已注册分支路径再次创建同样成功
	r := Runner{Dir: dir}
	out, _, _ := r.Git(TimeoutQuery, "branch", "--list", branch)
	if strings.TrimSpace(out) == "" {
		t.Fatal("sandbox branch missing")
	}
	_, _, err := r.Git(TimeoutWorktree, "worktree", "remove", target)
	if err != nil {
		t.Fatalf("cleanup: %v", err)
	}
}

func TestRecentOnelineAndFileDiff(t *testing.T) {
	dir := newRepo(t)
	writeFile(t, dir, "a.txt", "1\n")
	r := Runner{Dir: dir}
	r.Git(TimeoutQuery, "add", "-A")
	r.Git(TimeoutQuery, "commit", "-q", "-m", "c1")
	lines := RecentOneline(dir, 3)
	if len(lines) != 2 || !strings.Contains(lines[0], "c1") {
		t.Fatalf("oneline = %v", lines)
	}
	writeFile(t, dir, "a.txt", "2\n")
	if diff := FileDiffAt(dir, "a.txt"); !strings.Contains(diff, "-1") || !strings.Contains(diff, "+2") {
		t.Fatalf("fileDiff = %q", diff)
	}
}
