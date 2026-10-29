package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
	"github.com/ezdemo/looprax/internal/repository"
)

// snapshotRegistry 按工作区哈希维护内存中的快照列表。
// Java 对齐：条目始终以裸 <hash> 键注册，与查询的
// sessionName 无关，且该列表在重启后不保留。
type snapshotRegistry struct {
	mu    sync.Mutex
	byKey map[string][]gitops.Snapshot
}

func newSnapshotRegistry() *snapshotRegistry {
	return &snapshotRegistry{byKey: map[string][]gitops.Snapshot{}}
}

type snapshotLocation struct {
	Session string `json:"session"`
	Root    string `json:"root"`
}

func (s *Controller) snapshotLocationsPath() string {
	return filepath.Join(s.home, "workspace", s.agent.App(), "snapshot-locations.json")
}

func (s *Controller) recordSnapshot(session, root string, snap gitops.Snapshot) error {
	s.state.files.Lock()
	defer s.state.files.Unlock()
	locations := repository.ReadObject(s.snapshotLocationsPath())
	locations[snap.MsgID] = snapshotLocation{Session: session, Root: filepath.Clean(root)}
	if err := repository.WriteJSON(s.snapshotLocationsPath(), locations); err != nil {
		return err
	}
	s.snapshots.register(s.agent.App(), snap)
	return nil
}

func (s *Controller) snapshotRoot(session, msgID string) (string, error) {
	var location snapshotLocation
	s.state.files.Lock()
	data, _ := json.Marshal(repository.ReadObject(s.snapshotLocationsPath())[msgID])
	s.state.files.Unlock()
	if json.Unmarshal(data, &location) == nil && location.Root != "" {
		if location.Session != session {
			return "", fmt.Errorf("快照不属于当前会话")
		}
		main := s.workspaceRoot()
		if filepath.Clean(main) != location.Root {
			expected := gitops.WorktreePath(s.worktreeBase(), s.agent.App(), session)
			if filepath.Clean(expected) != location.Root || !gitops.IsRegisteredWorktree(main, expected) {
				return "", fmt.Errorf("快照所在的隔离分支不可用")
			}
		}
		if _, err := os.Stat(location.Root); err != nil {
			return "", fmt.Errorf("快照所在目录不可用")
		}
		return location.Root, nil
	}
	env := s.resolveEnvironment(session)
	if s.sessionMetaRead(session)["worktreeMode"] == true && (env.Mode != "worktree" || env.Current == "") {
		return "", fmt.Errorf("隔离分支不可用，无法安全恢复快照")
	}
	return env.Current, nil
}

func (reg *snapshotRegistry) register(hash string, snap gitops.Snapshot) {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	reg.byKey[hash] = append(reg.byKey[hash], snap)
}

func (reg *snapshotRegistry) list(key string) []gitops.Snapshot {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	out := reg.byKey[key]
	if out == nil {
		return []gitops.Snapshot{}
	}
	return append([]gitops.Snapshot(nil), out...)
}

// discardAfter 丢弃 msgId 及其之后注册的所有条目，
// 返回需要从 git 中删除的 msgId。
func (reg *snapshotRegistry) discardAfter(key, msgID string) []string {
	reg.mu.Lock()
	defer reg.mu.Unlock()
	snaps := reg.byKey[key]
	for i, snap := range snaps {
		if snap.MsgID == msgID {
			var dropped []string
			for _, s := range snaps[i:] {
				dropped = append(dropped, s.MsgID)
			}
			reg.byKey[key] = snaps[:i]
			return dropped
		}
	}
	// 不在内存中（重启或由 Java 创建）：仅删除该引用
	return []string{msgID}
}

// snapshotCheckpoint 实现 POST /api/snapshots/checkpoint。
// 参数错误仍返回 HTTP 200 且 success:false（控制器级失败）。
func (s *Controller) snapshotCheckpoint(w http.ResponseWriter, r *http.Request) {
	msgID := strings.TrimSpace(r.URL.Query().Get("msgId"))
	if msgID == "" {
		writeFail(w, http.StatusOK, "msgId 不能为空")
		return
	}
	name := r.URL.Query().Get("sessionName")
	if name == "" {
		name = s.currentSession()
	}
	if name == "" {
		name = "default"
	}
	dir, err := s.snapshotRoot(name, "")
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	if !gitops.IsRepo(dir) {
		writeFail(w, http.StatusBadRequest, "Not a git repository")
		return
	}
	snap, err := gitops.Checkpoint(dir, msgID)
	if err != nil {
		writeFail(w, http.StatusInternalServerError, "创建快照失败: "+err.Error())
		return
	}
	if err := s.recordSnapshot(name, dir, snap); err != nil {
		writeFail(w, http.StatusInternalServerError, "保存快照位置失败: "+err.Error())
		return
	}
	writeOK(w, http.StatusOK, map[string]any{
		"msgId": snap.MsgID, "commitHash": snap.CommitHash,
		"treeHash": snap.TreeHash, "createdAt": snap.CreatedAt,
	})
}

// snapshotRollback 实现 POST /api/snapshots/rollback。rollbackCode
// 默认为 true；恢复代码需要提供 msgId。
func (s *Controller) snapshotRollback(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MsgID             string `json:"msgId"`
		RollbackTimestamp any    `json:"rollbackTimestamp"`
		RollbackCode      *bool  `json:"rollbackCode"`
		SessionName       string `json:"sessionName"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	// msgId 也可通过查询参数传入，以对齐表单形式
	if body.MsgID == "" {
		body.MsgID = strings.TrimSpace(r.URL.Query().Get("msgId"))
	}
	if strings.TrimSpace(body.MsgID) == "" && body.RollbackTimestamp == nil {
		writeFail(w, http.StatusOK, "msgId 或 rollbackTimestamp 必填")
		return
	}
	restoreCode := true
	if body.RollbackCode != nil {
		restoreCode = *body.RollbackCode
	}
	if restoreCode && strings.TrimSpace(body.MsgID) == "" {
		writeFail(w, http.StatusOK, "撤回代码需要有效的快照 ID")
		return
	}
	hash := s.agent.App()
	name := body.SessionName
	if name == "" {
		name = r.URL.Query().Get("sessionName")
	}
	if name == "" {
		name = s.currentSession()
	}
	if name == "" {
		name = "default"
	}
	if s.sessionRunning(name) != "" {
		writeFail(w, http.StatusConflict, "请先中止正在运行的会话")
		return
	}
	truncate := func() (string, error) {
		if _, err := s.agent.Sessions.Get(r.Context(), getSessionRequest(s.agent, name)); err != nil {
			return "", nil
		}
		return s.agent.Sessions.Truncate(r.Context(), hash, s.agent.User(), name, body.MsgID, number(body.RollbackTimestamp))
	}
	if !restoreCode {
		text, err := truncate()
		if err != nil {
			writeFail(w, http.StatusBadRequest, "撤回失败: "+err.Error())
			return
		}
		writeOK(w, http.StatusOK, map[string]any{
			"msgId": body.MsgID, "success": true,
			"message":          "会话消息已撤回，项目代码未修改",
			"rollbackUserText": text,
		})
		return
	}
	dir, err := s.snapshotRoot(name, body.MsgID)
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	snap, err := gitops.ResolveSnapshot(dir, body.MsgID)
	if err != nil {
		writeFail(w, http.StatusBadRequest, "撤回失败: 未找到消息 "+body.MsgID+" 的快照")
		return
	}
	if err := gitops.RestoreTree(dir, snap.TreeHash); err != nil {
		writeFail(w, http.StatusInternalServerError, "撤回失败: "+err.Error())
		return
	}
	for _, id := range s.snapshots.discardAfter(hash, body.MsgID) {
		gitops.DeleteSnapshotRef(dir, id)
	}
	text, err := truncate()
	if err != nil {
		writeFail(w, http.StatusInternalServerError, "代码已恢复，但会话历史撤回失败: "+err.Error())
		return
	}
	writeOK(w, http.StatusOK, map[string]any{
		"msgId": body.MsgID, "commitHash": snap.CommitHash, "treeHash": snap.TreeHash,
		"success": true, "message": "项目已恢复到消息 " + body.MsgID + " 之前的状态",
		"rollbackUserText": text,
	})
}

// snapshotList 实现 GET /api/snapshots（内存注册表视图）。
func (s *Controller) snapshotList(w http.ResponseWriter, r *http.Request) {
	hash := s.agent.App()
	session := r.URL.Query().Get("sessionName")
	key := hash
	if session != "" {
		key = hash + "::" + session
	}
	writeOK(w, http.StatusOK, s.snapshots.list(key))
}

func (s *Controller) snapshotStatus(w http.ResponseWriter, r *http.Request) {
	writeOK(w, http.StatusOK, map[string]any{"gitRepo": gitops.IsRepo(s.workspaceRoot())})
}

func (s *Controller) snapshotDelete(w http.ResponseWriter, r *http.Request) {
	msgID := r.PathValue("msgId")
	dir := s.workspaceRoot()
	gitops.DeleteSnapshotRef(dir, msgID)
	s.snapshots.mu.Lock()
	for key, snaps := range s.snapshots.byKey {
		kept := snaps[:0]
		for _, snap := range snaps {
			if snap.MsgID != msgID {
				kept = append(kept, snap)
			}
		}
		s.snapshots.byKey[key] = kept
	}
	s.snapshots.mu.Unlock()
	writeOK(w, http.StatusOK, "快照已删除")
}
