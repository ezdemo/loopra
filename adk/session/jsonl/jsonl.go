// Package jsonl 基于 Loopra 的 JSONL 会话文件实现 ADK 的 session.Service，
// 使 Go 与 Java 后端共享同一套磁盘上的
// 会话格式（参见 docs/SSE_AND_STORAGE_CONTRACT.md）。
//
// 根目录下的布局（通常是 ~/.loopra）：
//
//	workspace/{appName}/sessions/{session}.jsonl  仅追加的消息日志
//	workspace/{appName}/sessions/{session}.events 仅追加的审计镜像
//	workspace/{appName}/sessions/{session}.usage  token 用量计数器
//	workspace/{appName}/sessions/{session}.model_usage 按模型的计数器
//
// .jsonl/.events 是延迟创建的：Create 只在内存中登记会话，
// 首个事件追加时才创建文件，因此空白会话不会落盘。
//
// AppName 对应 Loopra 的工作区哈希；SessionID 对应会话
// 名。状态目前保存在内存中（.meta 伴随文件由
// 平台层负责）。
package jsonl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"google.golang.org/adk/v2/platform"
	"google.golang.org/adk/v2/session"
)

// Service 是基于 Loopra JSONL 文件的 session.Service。
type Service struct {
	root string

	mu         sync.Mutex
	created    map[string]struct{}       // 已创建但尚未落盘的会话的 key()
	owners     map[string]string         // fileKey(app, id) -> 所属用户
	states     map[string]map[string]any // 会话级状态（普通键）
	appStates  map[string]map[string]any // 按应用共享（"app:" 前缀已剥离）
	userStates map[string]map[string]any // 按应用+用户共享（"user:" 前缀已剥离）

	locks   lockShards
	dailyMu sync.Mutex
}

// NewService 构建以 Loopra 主目录为根的服务。
func NewService(root string) *Service {
	return &Service{
		root: root, created: map[string]struct{}{}, owners: map[string]string{},
		states: map[string]map[string]any{}, appStates: map[string]map[string]any{}, userStates: map[string]map[string]any{},
	}
}

// Root 返回配置的根目录。
func (s *Service) Root() string { return s.root }

func key(app, user, id string) string { return app + "\x00" + user + "\x00" + id }

var unsafeName = regexp.MustCompile(`[^\p{L}\p{N}_\-\[\]]`)

// SanitizeName 对应 Java 的会话文件名清理逻辑。
func SanitizeName(name string) string {
	return unsafeName.ReplaceAllString(name, "_")
}

func (s *Service) sessionDir(app string) string {
	return filepath.Join(s.root, "workspace", SanitizeName(app), "sessions")
}

func (s *Service) jsonlPath(app, id string) string {
	return filepath.Join(s.sessionDir(app), SanitizeName(id)+".jsonl")
}

func (s *Service) eventsPath(app, id string) string {
	return filepath.Join(s.sessionDir(app), SanitizeName(id)+".events")
}

func (s *Service) usagePath(app, id string) string {
	return filepath.Join(s.sessionDir(app), SanitizeName(id)+".usage")
}

func (s *Service) modelUsagePath(app, id string) string {
	return filepath.Join(s.sessionDir(app), SanitizeName(id)+".model_usage")
}

func fileKey(app, id string) string { return app + "/" + id }

// exists 判断该会话对当前用户是否可见：要么在内存中以匹配的
// 用户创建，要么存在于磁盘且属于（或已接管给）该用户。
// 属于其他用户的会话视为不存在。
func (s *Service) exists(app, user, id string) bool {
	if _, err := os.Stat(s.jsonlPath(app, id)); err == nil {
		s.mu.Lock()
		defer s.mu.Unlock()
		fk := fileKey(app, id)
		if owner, ok := s.owners[fk]; ok {
			return owner == user
		}
		s.owners[fk] = user
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.created[key(app, user, id)]
	return ok
}

// Create 实现 session.Service。
//
// 会话只在内存中登记，不落盘：对应 Java JsonlSessionStore 的延迟创建
// （“仅在首次写入消息时才真正创建 .jsonl 文件，避免空白会话产生空文件”）。
// 首个 AppendEvent 会按需创建父目录与日志文件，因此新建但从未发送消息的
// 会话不会在磁盘上留下任何会话记录。
func (s *Service) Create(ctx context.Context, req *session.CreateRequest) (*session.CreateResponse, error) {
	if req.AppName == "" || req.UserID == "" {
		return nil, fmt.Errorf("app_name and user_id are required, got app_name: %q, user_id: %q", req.AppName, req.UserID)
	}
	id := req.SessionID
	if id == "" {
		id = platform.NewUUID(ctx)
	}
	if s.exists(req.AppName, req.UserID, id) {
		return nil, fmt.Errorf("session %s already exists", id)
	}
	s.mu.Lock()
	s.created[key(req.AppName, req.UserID, id)] = struct{}{}
	s.owners[fileKey(req.AppName, id)] = req.UserID
	appDelta, userDelta, sessDelta := splitByPrefix(req.State)
	s.applyDelta(req.AppName, appDelta, s.appStates)
	s.applyDelta(req.AppName+"\x00"+req.UserID, userDelta, s.userStates)
	s.applyDelta(key(req.AppName, req.UserID, id), sessDelta, s.states)
	view := s.mergedView(req.AppName, req.UserID, id)
	s.mu.Unlock()
	sess := &jsonlSession{
		id: id, app: req.AppName, user: req.UserID,
		state:     view,
		updatedAt: platform.Now(ctx),
	}
	return &session.CreateResponse{Session: sess}, nil
}

// Get 实现 session.Service。
func (s *Service) Get(ctx context.Context, req *session.GetRequest) (*session.GetResponse, error) {
	if req.AppName == "" || req.UserID == "" || req.SessionID == "" {
		return nil, fmt.Errorf("app_name, user_id, session_id are required")
	}
	if !s.exists(req.AppName, req.UserID, req.SessionID) {
		return nil, fmt.Errorf("%w: %q", session.ErrNotFound, req.SessionID)
	}
	events, mtime, err := s.loadEvents(req.AppName, req.SessionID)
	if err != nil {
		return nil, err
	}
	if req.NumRecentEvents > 0 && len(events) > req.NumRecentEvents {
		events = events[len(events)-req.NumRecentEvents:]
	}
	if !req.After.IsZero() && len(events) > 0 {
		first := sort.Search(len(events), func(i int) bool {
			return !events[i].Timestamp.Before(req.After)
		})
		events = events[first:]
	}
	updatedAt := mtime
	if updatedAt.IsZero() {
		updatedAt = platform.Now(ctx)
	}
	sess := &jsonlSession{
		id: req.SessionID, app: req.AppName, user: req.UserID,
		events: events, updatedAt: updatedAt,
	}
	s.mu.Lock()
	sess.state = s.mergedView(req.AppName, req.UserID, req.SessionID)
	s.mu.Unlock()
	return &session.GetResponse{Session: sess}, nil
}

// List 实现 session.Service。
func (s *Service) List(ctx context.Context, req *session.ListRequest) (*session.ListResponse, error) {
	if req.AppName == "" {
		return nil, fmt.Errorf("app_name is required")
	}
	dir := s.sessionDir(req.AppName)
	entries, err := os.ReadDir(dir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	type item struct {
		id    string
		mtime time.Time
	}
	var items []item
	s.mu.Lock()
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		id := strings.TrimSuffix(name, ".jsonl")
		fk := fileKey(req.AppName, id)
		if owner, ok := s.owners[fk]; ok && req.UserID != "" && owner != req.UserID {
			continue
		}
		if _, ok := s.owners[fk]; !ok && req.UserID != "" {
			s.owners[fk] = req.UserID // 首次列表时接管，符合单用户现状
		}
		items = append(items, item{id: id, mtime: info.ModTime()})
	}
	s.mu.Unlock()
	s.mu.Lock()
	var memIDs []string
	for k := range s.created {
		parts := strings.SplitN(k, "\x00", 3)
		if len(parts) == 3 && parts[0] == req.AppName && (req.UserID == "" || parts[1] == req.UserID) {
			memIDs = append(memIDs, parts[2])
		}
	}
	s.mu.Unlock()
	for _, id := range memIDs {
		if _, err := os.Stat(s.jsonlPath(req.AppName, id)); err == nil {
			continue
		}
		items = append(items, item{id: SanitizeName(id), mtime: time.Time{}})
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].mtime.Equal(items[j].mtime) {
			return items[i].id < items[j].id
		}
		return items[i].mtime.After(items[j].mtime)
	})
	out := &session.ListResponse{}
	for _, it := range items {
		out.Sessions = append(out.Sessions, &jsonlSession{
			id: it.id, app: req.AppName, user: req.UserID, updatedAt: it.mtime,
		})
	}
	return out, nil
}

// Delete 实现 session.Service。会话不存在时不做任何操作。
func (s *Service) Delete(ctx context.Context, req *session.DeleteRequest) error {
	if req.AppName == "" || req.UserID == "" || req.SessionID == "" {
		return fmt.Errorf("app_name, user_id, session_id are required")
	}
	app, id := req.AppName, req.SessionID
	unlock := s.locks.lock(s.jsonlPath(app, id))
	defer unlock()
	for _, p := range []string{s.jsonlPath(app, id), s.eventsPath(app, id), s.usagePath(app, id), s.modelUsagePath(app, id)} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	s.mu.Lock()
	delete(s.created, key(req.AppName, req.UserID, id))
	delete(s.created, key(req.AppName, req.UserID, SanitizeName(id)))
	delete(s.owners, fileKey(req.AppName, id))
	delete(s.states, key(req.AppName, req.UserID, id))
	delete(s.states, key(req.AppName, req.UserID, SanitizeName(id)))
	s.mu.Unlock()
	return nil
}

// AppendEvent 实现 session.Service。
func (s *Service) AppendEvent(ctx context.Context, cur session.Session, event *session.Event) error {
	if cur == nil {
		return fmt.Errorf("session is nil")
	}
	if event == nil {
		return fmt.Errorf("event is nil")
	}
	if event.Partial {
		return nil
	}
	if event.ID == "" {
		event.ID = platform.NewUUID(ctx)
	}
	if !s.exists(cur.AppName(), cur.UserID(), cur.ID()) {
		return fmt.Errorf("%w: %q, cannot apply event", session.ErrNotFound, cur.ID())
	}
	if event.Timestamp.IsZero() {
		event.Timestamp = platform.Now(ctx)
	}
	trimTempState(event)
	lines := eventLines(event)
	if snapshot, _ := ctx.Value(snapshotKey{}).(string); snapshot != "" {
		for _, line := range lines {
			if line["role"] == "user" {
				line["rollback_id"], line["snapshot_id"] = snapshot, snapshot
			}
		}
	}
	app, id := cur.AppName(), cur.ID()
	unlock := s.locks.lock(s.jsonlPath(app, id))
	defer unlock()
	if len(lines) > 0 {
		if err := appendLines(s.jsonlPath(app, id), lines); err != nil {
			return err
		}
		if err := appendLines(s.eventsPath(app, id), lines); err != nil {
			return err
		}
	}
	if event.UsageMetadata != nil {
		if err := s.addUsage(app, id, event); err != nil {
			return err
		}
		if err := s.addDailyUsage(event); err != nil {
			return err
		}
	}
	s.mu.Lock()
	s.applyState(cur, event.Actions.StateDelta)
	s.mu.Unlock()
	// 把事件同步到内存会话，使运行期处理器
	//（工具审批恢复、请求组装）能观察到会话加载之后
	// 追加的事件。
	if js, ok := cur.(*jsonlSession); ok {
		js.mu.Lock()
		js.events = append(js.events, event)
		if event.Timestamp.After(js.updatedAt) {
			js.updatedAt = event.Timestamp
		}
		js.mu.Unlock()
	}
	return nil
}

// applyState 把 StateDelta（temp 键已被剔除）路由到
// app/user/会话存储。调用方需持有 s.mu。
func (s *Service) applyState(cur session.Session, delta map[string]any) {
	appDelta, userDelta, sessDelta := splitByPrefix(delta)
	s.applyDelta(cur.AppName(), appDelta, s.appStates)
	s.applyDelta(cur.AppName()+"\x00"+cur.UserID(), userDelta, s.userStates)
	s.applyDelta(key(cur.AppName(), cur.UserID(), cur.ID()), sessDelta, s.states)
}

// splitByPrefix 按 ADK 前缀路由状态键："app:" 值在同一应用
// 的用户间共享，"user:" 值在同一用户的会话间共享，"temp:"
// 值会从持久化状态中丢弃。键以剥离前缀后的形式存储。
func splitByPrefix(m map[string]any) (app, user, sess map[string]any) {
	app, user, sess = map[string]any{}, map[string]any{}, map[string]any{}
	for k, v := range m {
		switch {
		case strings.HasPrefix(k, "app:"):
			app[strings.TrimPrefix(k, "app:")] = v
		case strings.HasPrefix(k, "user:"):
			user[strings.TrimPrefix(k, "user:")] = v
		case strings.HasPrefix(k, "temp:"):
			// 丢弃
		default:
			sess[k] = v
		}
	}
	return app, user, sess
}

// applyDelta 把 delta 合并进 store[storeKey]，缺失时创建。
func (s *Service) applyDelta(storeKey string, delta map[string]any, store map[string]map[string]any) {
	if len(delta) == 0 {
		return
	}
	if store[storeKey] == nil {
		store[storeKey] = map[string]any{}
	}
	for k, v := range delta {
		store[storeKey][k] = v
	}
}

// mergedView 重建带前缀的视图：app: 与 user: 键保留
// 前缀，会话键保持普通形式。会话值优先于用户值，用户值优先于
// 应用值。调用方需持有 s.mu。
func (s *Service) mergedView(app, user, id string) map[string]any {
	view := map[string]any{}
	for k, v := range s.appStates[app] {
		view["app:"+k] = v
	}
	for k, v := range s.userStates[app+"\x00"+user] {
		view["user:"+k] = v
	}
	for k, v := range s.states[key(app, user, id)] {
		view[k] = v
	}
	return view
}

// loadEvents 把 .jsonl 文件读入事件列表，并返回其修改时间。
func (s *Service) loadEvents(app, id string) ([]*session.Event, time.Time, error) {
	path := s.jsonlPath(app, id)
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, time.Time{}, nil
		}
		return nil, time.Time{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	var events []*session.Event
	for seq, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			continue // 与 Java 加载器一样容忍损坏行
		}
		events = append(events, lineEvent(m, seq))
	}
	return events, info.ModTime(), nil
}

// AppendTranscript 直接追加 Loopra 行（外部 ACP 会话不经过 ADK 事件），
// 与 AppendEvent 一样同步写入主日志与 append-only 审计镜像。
func (s *Service) AppendTranscript(app, id string, lines []map[string]any) error {
	if len(lines) == 0 {
		return nil
	}
	unlock := s.locks.lock(s.jsonlPath(app, id))
	defer unlock()
	if err := appendLines(s.jsonlPath(app, id), lines); err != nil {
		return err
	}
	return appendLines(s.eventsPath(app, id), lines)
}

// appendLines 写入行并立即刷新，必要时创建父目录。
func appendLines(path string, lines []map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	w := json.NewEncoder(f)
	for _, line := range lines {
		if err := w.Encode(line); err != nil {
			return err
		}
	}
	return nil
}

// usageFile 是 {name}.usage 的 JSON 结构。
type usageFile struct {
	Prompt           int64 `json:"prompt"`
	Completion       int64 `json:"completion"`
	CacheHit         int64 `json:"cacheHit"`
	CacheMiss        int64 `json:"cacheMiss"`
	LastPromptTokens int64 `json:"lastPromptTokens"`
}

func (s *Service) addUsage(app, id string, event *session.Event) error {
	u := event.UsageMetadata
	upath := s.usagePath(app, id)
	unlock := s.locks.lock(upath)
	defer unlock()
	acc := usageFile{}
	if data, err := os.ReadFile(upath); err == nil {
		_ = json.Unmarshal(data, &acc)
	}
	hit := int64(u.CachedContentTokenCount)
	prompt := int64(u.PromptTokenCount)
	acc.Prompt += prompt
	acc.Completion += int64(u.CandidatesTokenCount)
	acc.CacheHit += hit
	acc.CacheMiss += prompt - hit
	acc.LastPromptTokens = prompt
	if err := writeJSONAtomic(upath, acc); err != nil {
		return err
	}
	// 按模型计数：{"<model>": [prompt, completion, cacheHit, cacheMiss]}。
	model := event.ModelVersion
	if model == "" {
		return nil
	}
	mpath := s.modelUsagePath(app, id)
	models := map[string][4]int64{}
	if data, err := os.ReadFile(mpath); err == nil {
		_ = json.Unmarshal(data, &models)
	}
	prev := models[model]
	prev[0] += prompt
	prev[1] += int64(u.CandidatesTokenCount)
	prev[2] += hit
	prev[3] += prompt - hit
	models[model] = prev
	return writeJSONAtomic(mpath, models)
}

func writeJSONAtomic(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// trimTempState 原地删除事件 StateDelta 中的 "temp:" 键；
// 这是所有 session.Service 后端共用的持久化差异约定。
func trimTempState(event *session.Event) {
	for k := range event.Actions.StateDelta {
		if strings.HasPrefix(k, "temp:") {
			delete(event.Actions.StateDelta, k)
		}
	}
}

// jsonlSession 实现 session.Session。
type jsonlSession struct {
	id, app, user string

	mu        sync.RWMutex
	events    []*session.Event
	state     map[string]any
	updatedAt time.Time
}

func (s *jsonlSession) ID() string      { return s.id }
func (s *jsonlSession) AppName() string { return s.app }
func (s *jsonlSession) UserID() string  { return s.user }
func (s *jsonlSession) LastUpdateTime() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.updatedAt
}
func (s *jsonlSession) State() session.State   { return stateView{s} }
func (s *jsonlSession) Events() session.Events { return eventList{s} }

type stateView struct{ s *jsonlSession }

func (v stateView) Get(k string) (any, error) {
	v.s.mu.RLock()
	defer v.s.mu.RUnlock()
	val, ok := v.s.state[k]
	if !ok {
		return nil, fmt.Errorf("%w: %q", session.ErrStateKeyNotExist, k)
	}
	return val, nil
}

func (v stateView) Set(k string, val any) error {
	v.s.mu.Lock()
	defer v.s.mu.Unlock()
	if v.s.state == nil {
		v.s.state = map[string]any{}
	}
	v.s.state[k] = val
	return nil
}

func (v stateView) All() iter.Seq2[string, any] {
	return func(yield func(string, any) bool) {
		v.s.mu.RLock()
		defer v.s.mu.RUnlock()
		for k, val := range v.s.state {
			if !yield(k, val) {
				return
			}
		}
	}
}

type eventList struct{ s *jsonlSession }

func (l eventList) All() iter.Seq[*session.Event] {
	return func(yield func(*session.Event) bool) {
		l.s.mu.RLock()
		events := append([]*session.Event(nil), l.s.events...)
		l.s.mu.RUnlock()
		for _, ev := range events {
			if !yield(ev) {
				return
			}
		}
	}
}

func (l eventList) Len() int {
	l.s.mu.RLock()
	defer l.s.mu.RUnlock()
	return len(l.s.events)
}

func (l eventList) At(i int) *session.Event {
	l.s.mu.RLock()
	defer l.s.mu.RUnlock()
	if i < 0 || i >= len(l.s.events) {
		return nil
	}
	return l.s.events[i]
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// lockShards 提供按路径分 64 片的互斥锁，对应 Java
// 存储层跨实例文件加锁的意图。
type lockShards struct {
	mu [64]sync.Mutex
}

func (l *lockShards) shard(path string) int {
	h := 5381
	for i := 0; i < len(path); i++ {
		h = ((h << 5) + h + int(path[i])) & 0x7fffffff
	}
	return h % 64
}

func (l *lockShards) lock(path string) func() {
	i := l.shard(filepath.ToSlash(filepath.Clean(path)))
	l.mu[i].Lock()
	return func() { l.mu[i].Unlock() }
}
