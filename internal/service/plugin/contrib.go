package plugin

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/model"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service/schedule"
)

const contribTextLimit = 1 << 20

// SkillDecl 是已启用插件声明的一条技能。
type SkillDecl struct {
	PluginID    string
	Name        string
	Description string
}

// SubagentDecl 是已启用插件声明的一个子代理。ID 固定为 plugin-<插件 id>。
type SubagentDecl struct {
	ID           string
	Name         string
	Description  string
	Instructions string
	ReadOnly     bool
}

// Skills 返回已启用插件声明的技能。文件缺失或越出插件目录时略过。
func (h *Host) Skills() []SkillDecl {
	if h == nil {
		return nil
	}
	var out []SkillDecl
	for _, item := range h.enabledPackages() {
		decl, ok := h.skillDecl(item.rec, item.info)
		if !ok {
			continue
		}
		out = append(out, decl)
	}
	return out
}

// ReadSkill 读取插件技能正文。rel 为空时读声明的文件，否则读该文件所在目录里的配套文件。
func (h *Host) ReadSkill(pluginID, rel string) (string, error) {
	if h == nil || !safeID(pluginID) {
		return "", errText("技能来源不存在")
	}
	var rec record
	var info pkgFile
	found := false
	for _, item := range h.enabledPackages() {
		if item.rec.ID == pluginID {
			rec, info, found = item.rec, item.info, true
			break
		}
	}
	if !found {
		return "", errText("技能来源不存在")
	}
	file, dir, pkgRoot, ok := h.skillLocation(rec.ID, info)
	if !ok {
		return "", errText("技能来源不存在")
	}
	target := file
	if rel != "" && rel != "SKILL.md" {
		resolved, err := resolveInside(pkgRoot, dir, rel)
		if err != nil {
			return "", errText("技能文件不可读取")
		}
		target = resolved
	}
	return readPluginText(target)
}

// Subagents 返回已启用插件声明的子代理。
func (h *Host) Subagents() []SubagentDecl {
	if h == nil {
		return nil
	}
	var out []SubagentDecl
	for _, item := range h.enabledPackages() {
		decl, ok := h.subagentDecl(item.rec, item.info)
		if !ok {
			continue
		}
		out = append(out, decl)
	}
	return out
}

// ScheduledTasks 返回已启用插件声明的定时任务，并带上上次执行状态。
func (h *Host) ScheduledTasks() []model.ScheduledTask {
	if h == nil {
		return nil
	}
	pkgs := h.enabledPackages()
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.loadScheduleLocked()
	dirty := false
	var tasks []model.ScheduledTask
	for _, item := range pkgs {
		task, ok := h.scheduleDecl(item.rec, item.info)
		if !ok {
			continue
		}
		st := state.Tasks[task.ID]
		task.LastRunAt = st.LastRunAt
		task.RunCount = st.RunCount
		task.LastResult = st.LastResult
		task.LastError = st.LastError
		task.Runs = st.Runs
		if task.Runs == nil {
			task.Runs = []model.ScheduleRun{}
		}
		task.NextRunAt = st.NextRunAt
		if task.NextRunAt == 0 {
			task.NextRunAt = schedule.NextRunAt(task)
			st.NextRunAt = task.NextRunAt
			if state.Tasks == nil {
				state.Tasks = map[string]scheduleState{}
			}
			state.Tasks[task.ID] = st
			dirty = true
		}
		tasks = append(tasks, task)
	}
	if dirty {
		h.saveScheduleLocked(state)
	}
	if tasks == nil {
		return []model.ScheduledTask{}
	}
	return tasks
}

// RecordSchedule 记下一次插件定时任务的执行结果，并计算下次时间。
func (h *Host) RecordSchedule(task model.ScheduledTask, run model.ScheduleRun, reply string, runErr error) {
	if h == nil || task.ID == "" {
		return
	}
	if run.FinishedAt == 0 {
		run.FinishedAt = time.Now().UnixMilli()
	}
	if runErr != nil {
		run.Status = "failed"
		if run.Error == "" {
			run.Error = runErr.Error()
		}
	} else {
		run.Status = "completed"
		reply = clipRunes(reply, 200)
		run.Result = reply
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.loadScheduleLocked()
	if state.Tasks == nil {
		state.Tasks = map[string]scheduleState{}
	}
	st := state.Tasks[task.ID]
	st.Runs = append([]model.ScheduleRun{run}, st.Runs...)
	if len(st.Runs) > 20 {
		st.Runs = st.Runs[:20]
	}
	st.RunCount++
	st.LastRunAt = run.FinishedAt
	if runErr != nil {
		st.LastError = run.Error
		st.LastResult = ""
	} else {
		st.LastError = ""
		st.LastResult = reply
	}
	base := task
	base.Enabled = true
	base.LastRunAt = run.FinishedAt
	st.NextRunAt = schedule.NextRunAt(base)
	state.Tasks[task.ID] = st
	h.saveScheduleLocked(state)
}

func (h *Host) forgetSchedule(id string) {
	if h == nil || id == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	state := h.loadScheduleLocked()
	if _, ok := state.Tasks[id]; !ok {
		return
	}
	delete(state.Tasks, id)
	h.saveScheduleLocked(state)
}

type enabledPackage struct {
	rec  record
	info pkgFile
}

func (h *Host) enabledPackages() []enabledPackage {
	h.mu.Lock()
	h.ensureManifest()
	recs := append([]record(nil), h.records...)
	h.mu.Unlock()
	var out []enabledPackage
	for _, rec := range recs {
		if !rec.Enabled {
			continue
		}
		out = append(out, enabledPackage{rec: rec, info: readPkg(h.pkgDir(rec.ID))})
	}
	return out
}

func contributionID(pluginID string) string { return "plugin-" + strings.ToLower(pluginID) }

func (h *Host) skillDecl(rec record, info pkgFile) (SkillDecl, bool) {
	file, _, _, ok := h.skillLocation(rec.ID, info)
	if !ok {
		return SkillDecl{}, false
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return SkillDecl{}, false
	}
	name, description := skillHeading(data, displayName(rec), rec.Description)
	return SkillDecl{PluginID: rec.ID, Name: name, Description: description}, true
}

func (h *Host) skillLocation(id string, info pkgFile) (file, dir, pkgRoot string, ok bool) {
	if info.SkillFile == "" {
		return "", "", "", false
	}
	cleaned, err := cleanPluginPath(info.SkillFile)
	if err != nil {
		logging.Warnf("plugin", "%s 的技能路径无效", id)
		return "", "", "", false
	}
	pkgRoot, err = osPathEval(h.pkgDir(id))
	if err != nil {
		return "", "", "", false
	}
	file, err = resolveInside(pkgRoot, pkgRoot, cleaned)
	if err != nil || !strings.EqualFold(filepath.Ext(file), ".md") || filepath.Base(file) != "SKILL.md" {
		logging.Warnf("plugin", "%s 的技能文件无效", id)
		return "", "", "", false
	}
	return file, filepath.Dir(file), pkgRoot, true
}

func (h *Host) subagentDecl(rec record, info pkgFile) (SubagentDecl, bool) {
	if !info.SubagentSet {
		return SubagentDecl{}, false
	}
	instructions := info.SubagentInstructions
	if info.SubagentFile != "" {
		text, err := h.readPackageText(rec.ID, info.SubagentFile)
		if err != nil {
			logging.Warnf("plugin", "%s 的子代理说明无法读取", rec.ID)
			return SubagentDecl{}, false
		}
		instructions = text
	}
	instructions = strings.TrimSpace(instructions)
	if instructions == "" {
		logging.Warnf("plugin", "%s 的子代理没有说明", rec.ID)
		return SubagentDecl{}, false
	}
	name := clipRunes(info.SubagentName, 80)
	if name == "" {
		name = clipRunes(displayName(rec), 80)
	}
	return SubagentDecl{
		ID: contributionID(rec.ID), Name: name,
		Description: clipRunes(info.SubagentDescription, 200), Instructions: instructions,
		ReadOnly: info.SubagentReadOnly,
	}, true
}

func (h *Host) scheduleDecl(rec record, info pkgFile) (model.ScheduledTask, bool) {
	if info.ScheduleMessage == "" && info.ScheduleCron == "" && info.ScheduleInterval == 0 {
		return model.ScheduledTask{}, false
	}
	message := strings.TrimSpace(info.ScheduleMessage)
	if message == "" || len(message) > 8<<10 {
		logging.Warnf("plugin", "%s 的定时任务缺少有效内容", rec.ID)
		return model.ScheduledTask{}, false
	}
	task := model.ScheduledTask{
		ID: contributionID(rec.ID), Name: clipRunes(info.ScheduleName, 80),
		Message: message, Enabled: true, SessionMode: "independent", Plugin: true,
	}
	if task.Name == "" {
		task.Name = clipRunes(displayName(rec), 80)
	}
	if info.ScheduleCron != "" {
		if _, err := schedule.ParseCron(info.ScheduleCron); err != nil {
			logging.Warnf("plugin", "%s 的定时任务 Cron 无效", rec.ID)
			return model.ScheduledTask{}, false
		}
		task.CronExpr = info.ScheduleCron
		return task, true
	}
	if info.ScheduleInterval < 60 {
		logging.Warnf("plugin", "%s 的定时任务间隔无效", rec.ID)
		return model.ScheduledTask{}, false
	}
	task.IntervalSec = info.ScheduleInterval
	return task, true
}

func (h *Host) readPackageText(id, rel string) (string, error) {
	cleaned, err := cleanPluginPath(rel)
	if err != nil {
		return "", err
	}
	pkgRoot, err := osPathEval(h.pkgDir(id))
	if err != nil {
		return "", err
	}
	file, err := resolveInside(pkgRoot, pkgRoot, cleaned)
	if err != nil {
		return "", err
	}
	return readPluginText(file)
}

func displayName(rec record) string {
	if rec.DisplayName != "" {
		return rec.DisplayName
	}
	if rec.Name != "" {
		return rec.Name
	}
	return rec.ID
}

func skillHeading(data []byte, fallbackName, fallbackDesc string) (string, string) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	name, description := strings.TrimSpace(fallbackName), strings.TrimSpace(fallbackDesc)
	if !strings.HasPrefix(text, "---\n") {
		return name, description
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return name, description
	}
	var header struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	if yaml.Unmarshal([]byte(text[4:4+end]), &header) != nil {
		return name, description
	}
	if strings.TrimSpace(header.Name) != "" {
		name = strings.TrimSpace(header.Name)
	}
	if strings.TrimSpace(header.Description) != "" {
		description = strings.TrimSpace(header.Description)
	}
	return name, description
}

func readPluginText(file string) (string, error) {
	stat, err := os.Stat(file)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > contribTextLimit {
		return "", errText("技能文件不可读取")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(data) {
		return "", errText("技能文件不可读取")
	}
	return string(data), nil
}

func osPathEval(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}

func clipRunes(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}

type scheduleStateFile struct {
	Tasks map[string]scheduleState `json:"tasks"`
}

type scheduleState struct {
	NextRunAt  int64               `json:"nextRunAt,omitempty"`
	LastRunAt  int64               `json:"lastRunAt,omitempty"`
	RunCount   int                 `json:"runCount,omitempty"`
	LastResult string              `json:"lastResult,omitempty"`
	LastError  string              `json:"lastError,omitempty"`
	Runs       []model.ScheduleRun `json:"runs,omitempty"`
}

func (h *Host) scheduleStatePath() string {
	return filepath.Join(h.base(), "schedule-state.json")
}

func (h *Host) loadScheduleLocked() scheduleStateFile {
	var file scheduleStateFile
	data, err := os.ReadFile(h.scheduleStatePath())
	if err != nil || json.Unmarshal(data, &file) != nil || file.Tasks == nil {
		file.Tasks = map[string]scheduleState{}
	}
	return file
}

func (h *Host) saveScheduleLocked(file scheduleStateFile) {
	if file.Tasks == nil {
		file.Tasks = map[string]scheduleState{}
	}
	if err := repository.WriteJSON(h.scheduleStatePath(), file); err != nil {
		logging.Warnf("plugin", "保存插件定时任务状态失败: %v", err)
	}
}
