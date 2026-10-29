package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/gitops"
)

// fileChange 是一条被跟踪的 AI 编辑记录，与助手消息一起持久化
// （会话日志中的 file_changes 行）。
type fileChange struct {
	Path      string `json:"path"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Created   bool   `json:"created"`
	Diff      string `json:"diff"`
}

// applyResult 承载单个 diff 重建出的 before/after 内容对。
type applyResult struct {
	before string
	after  string
}

// parseWholeFileDiff 将整文件 unified diff 拆回 before
// 与 after 两侧。hunk 数量不限，但必须从
// 第 1 行开始（由跟踪器生成的整文件 diff）。
func parseWholeFileDiff(diff string) (applyResult, error) {
	var res applyResult
	var beforeDone, afterDone strings.Builder
	lines := strings.Split(strings.TrimRight(diff, "\n"), "\n")
	i := 0
	// 头部：--- a/... 然后是 +++ b/...
	if i >= len(lines) || !strings.HasPrefix(lines[i], "--- ") {
		return res, fmt.Errorf("diff 缺少 --- 头")
	}
	i++
	if i >= len(lines) || !strings.HasPrefix(lines[i], "+++ ") {
		return res, fmt.Errorf("diff 缺少 +++ 头")
	}
	i++
	for i < len(lines) {
		line := lines[i]
		if strings.HasPrefix(line, "@@") {
			i++
			// hunk 内容直到下一个 @@ 或文件结束
			for i < len(lines) && !strings.HasPrefix(lines[i], "@@") {
				body := lines[i]
				switch {
				case strings.HasPrefix(body, "+"):
					afterDone.WriteString(body[1:] + "\n")
				case strings.HasPrefix(body, "-"):
					beforeDone.WriteString(body[1:] + "\n")
				case strings.HasPrefix(body, " "):
					beforeDone.WriteString(body[1:] + "\n")
					afterDone.WriteString(body[1:] + "\n")
				case body == "\\ No newline at end of file":
					trimTrailingNewline(&beforeDone)
					trimTrailingNewline(&afterDone)
				default:
					return res, fmt.Errorf("无法解析的 diff 行: %q", body)
				}
				i++
			}
			continue
		}
		return res, fmt.Errorf("diff 缺少 hunk 头")
	}
	res.before = beforeDone.String()
	res.after = afterDone.String()
	return res, nil
}

func trimTrailingNewline(sb *strings.Builder) {
	s := sb.String()
	if strings.HasSuffix(s, "\n") {
		sb.Reset()
		sb.WriteString(s[:len(s)-1])
	}
}

// fileChangesRevert 实现 POST /api/sessions/file-changes/revert：
// 先针对当前文件校验每个变更，然后一次性反向应用
// before 侧内容（Java FileChangeRevertService）。
func (s *Controller) fileChangesRevert(w http.ResponseWriter, r *http.Request) {
	var body struct {
		WorkspaceHash string       `json:"workspaceHash"`
		Changes       []fileChange `json:"changes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeFail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}
	if strings.TrimSpace(body.WorkspaceHash) == "" {
		writeFail(w, http.StatusBadRequest, "workspaceHash 必填")
		return
	}
	root := s.workspaceRoot()
	type pending struct {
		abs    string
		before string
		create bool
	}
	var plan []pending
	seen := map[string]bool{}
	for _, change := range body.Changes {
		if change.Path == "" || change.Diff == "" {
			writeFail(w, http.StatusBadRequest, "变更项缺少 path 或 diff")
			return
		}
		clean, err := gitops.ValidatePath(root, change.Path)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		if seen[clean] {
			continue // 重复条目像 Java 的 set 一样合并
		}
		seen[clean] = true
		res, err := parseWholeFileDiff(change.Diff)
		if err != nil {
			writeFail(w, http.StatusBadRequest, change.Path+": "+err.Error())
			return
		}
		abs := filepath.Join(root, filepath.FromSlash(clean))
		if change.Created && res.before == "" {
			// 新建文件：撤销即删除（通过逐字匹配 after 内容校验）
			data, err := os.ReadFile(abs)
			if err != nil || string(data) != res.after {
				writeFail(w, http.StatusBadRequest, "文件已被后续修改，无法撤销: "+clean)
				return
			}
			plan = append(plan, pending{abs: abs, before: "", create: true})
			continue
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			writeFail(w, http.StatusBadRequest, "当前项目中未找到此文件: "+clean)
			return
		}
		if string(data) != res.after {
			writeFail(w, http.StatusBadRequest, "文件已被后续修改，无法撤销: "+clean)
			return
		}
		plan = append(plan, pending{abs: abs, before: res.before})
	}
	// 全部校验通过：一次性执行该计划
	for _, p := range plan {
		if p.create {
			_ = os.Remove(p.abs)
			continue
		}
		if err := os.WriteFile(p.abs, []byte(p.before), 0o644); err != nil {
			writeFail(w, http.StatusInternalServerError, "撤销写入失败: "+err.Error())
			return
		}
	}
	writeOK(w, http.StatusOK, map[string]any{
		"message": "已撤销本次 AI 的文件修改", "revertedFiles": len(plan),
	})
}
