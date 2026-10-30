package gitops

import (
	"os"
	"time"
)

// Snapshot 对应 SnapshotDTO。
type Snapshot struct {
	MsgID      string `json:"msgId"`
	CommitHash string `json:"commitHash"`
	TreeHash   string `json:"treeHash"`
	CreatedAt  int64  `json:"createdAt"`
}

const (
	snapshotAuthorName  = "Loopra-Snapshot"
	snapshotAuthorEmail = "snapshot@loopra.local"
	RefPrefix           = "refs/snapshots/msg/"
)

// Checkpoint 将完整工作树保存为 refs/snapshots/msg/<msgId> 下的
// 悬空提交，随后恢复用户的暂存区。
func Checkpoint(dir, msgID string) (Snapshot, error) {
	r := Runner{Dir: dir}
	snap := Snapshot{MsgID: msgID, CreatedAt: time.Now().UnixMilli()}
	index, err := os.CreateTemp("", "loopra-snapshot-index-*")
	if err != nil {
		return snap, err
	}
	index.Close()
	os.Remove(index.Name())
	defer os.Remove(index.Name())
	// 使用独立索引可在出错时保留部分暂存内容与用户原有索引。
	r.Env = []string{"GIT_INDEX_FILE=" + index.Name()}
	if _, _, err := r.Git(TimeoutSnapshot, "rev-parse", "--verify", "HEAD"); err == nil {
		if _, _, err := r.Git(TimeoutSnapshot, "read-tree", "HEAD"); err != nil {
			return snap, err
		}
	}
	if _, _, err := r.Git(TimeoutSnapshot, "add", "-A"); err != nil {
		return snap, err
	}
	tree, err := r.Line(TimeoutSnapshot, "write-tree")
	if err != nil {
		return snap, err
	}
	snap.TreeHash = tree
	args := []string{"-c", "user.name=" + snapshotAuthorName,
		"-c", "user.email=" + snapshotAuthorEmail,
		"commit-tree", tree,
		"-m", "snapshot: checkpoint before AI modification [" + msgID + "]"}
	if head, err := r.Line(TimeoutSnapshot, "rev-parse", "HEAD"); err == nil && head != "" {
		args = append(args, "-p", head)
	}
	commit, err := r.Line(TimeoutSnapshot, args...)
	if err != nil {
		return snap, err
	}
	snap.CommitHash = commit
	if _, _, err := r.Git(TimeoutSnapshot, "update-ref", RefPrefix+msgID, commit); err != nil {
		return snap, err
	}
	return snap, nil
}

// ResolveSnapshot 解析 refs/snapshots/msg/<msgId> 指向的提交。
func ResolveSnapshot(dir, msgID string) (Snapshot, error) {
	r := Runner{Dir: dir}
	commit, err := r.Line(TimeoutSnapshot, "rev-parse", RefPrefix+msgID)
	if err != nil {
		return Snapshot{}, err
	}
	tree, err := r.Line(TimeoutSnapshot, "rev-parse", commit+"^{tree}")
	if err != nil {
		return Snapshot{MsgID: msgID, CommitHash: commit}, err
	}
	return Snapshot{MsgID: msgID, CommitHash: commit, TreeHash: tree}, nil
}

// RestoreTree 将快照树检出到工作树，并将索引重置回 HEAD，
// 使这些改动显示为单一变更集。
func RestoreTree(dir, tree string) error {
	r := Runner{Dir: dir}
	if _, _, err := r.Git(TimeoutSnapshot, "read-tree", tree); err != nil {
		return err
	}
	if _, _, err := r.Git(TimeoutSnapshot, "checkout-index", "-a", "-f"); err != nil {
		return err
	}
	_, _, _ = r.Git(TimeoutSnapshot, "reset", "HEAD", "--")
	return nil
}

// DeleteSnapshotRef 删除一个快照引用。
func DeleteSnapshotRef(dir, msgID string) {
	_, _, _ = Runner{Dir: dir}.Git(TimeoutSnapshot, "update-ref", "-d", RefPrefix+msgID)
}
