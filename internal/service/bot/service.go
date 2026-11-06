// Package bot 管理机器人授权、连接和聊天到工作台会话的绑定。
package bot

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/model"
)

var (
	ErrNotFound = errors.New("Bot 不存在")
	ErrClosed   = errors.New("Bot 服务已关闭")
	ErrStorage  = errors.New("保存 Bot 配置失败")
)

type Store interface {
	Load() ([]model.Bot, error)
	Save([]model.Bot) error
}

type Provider interface {
	Register(context.Context, string, string, func(string, int)) (model.BotCredentials, error)
	Connect(context.Context, model.Bot, func(context.Context, model.BotMessage, func(context.Context, string) error) error, func(string)) error
}

// Host 将工作台执行入口传给连接生命周期，不另建一套 Agent。
type Host interface {
	PrepareBotProject(context.Context, string) (string, error)
	RunBotTurn(context.Context, string, string, string) (string, error)
}

type View struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Platform       string          `json:"platform"`
	AppID          string          `json:"appId"`
	OwnerID        string          `json:"ownerId"`
	WorkspaceHash  string          `json:"workspaceHash"`
	Enabled        bool            `json:"enabled"`
	AllowedUserIDs []string        `json:"allowedUserIds"`
	AllowedChatIDs []string        `json:"allowedChatIds"`
	Chats          []model.BotChat `json:"chats"`
	State          string          `json:"state"`
	Error          string          `json:"error,omitempty"`
	CreatedAt      int64           `json:"createdAt"`
}

type Update struct {
	Name           string   `json:"name"`
	Enabled        bool     `json:"enabled"`
	AllowedUserIDs []string `json:"allowedUserIds"`
	AllowedChatIDs []string `json:"allowedChatIds"`
}

type Registration struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	State     string `json:"state"`
	URL       string `json:"url,omitempty"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
	BotID     string `json:"botId,omitempty"`
	Error     string `json:"error,omitempty"`
	cancel    context.CancelFunc
	target    string
}

type connection struct {
	cancel context.CancelFunc
	state  string
	error  string
	busy   map[string]bool
}

type Service struct {
	mu            sync.Mutex
	store         Store
	provider      Provider
	records       []model.Bot
	connections   map[string]*connection
	registrations map[string]*Registration
	host          Host
	ctx           context.Context
	cancel        context.CancelFunc
	wg            sync.WaitGroup
	closed        bool
	active        int
}

func New(store Store, provider Provider) (*Service, error) {
	records, err := store.Load()
	if err != nil {
		return nil, err
	}
	ids, apps := map[string]bool{}, map[string]bool{}
	for _, record := range records {
		if record.ID == "" || record.Platform != "feishu" || record.AppID == "" || record.AppSecret == "" ||
			record.OwnerID == "" || record.WorkspaceHash == "" || ids[record.ID] || apps[record.AppID] {
			return nil, fmt.Errorf("invalid Bot configuration")
		}
		ids[record.ID], apps[record.AppID] = true, true
	}
	return &Service{store: store, provider: provider, records: records, connections: map[string]*connection{}, registrations: map[string]*Registration{}}, nil
}

func (s *Service) Start(ctx context.Context, host Host) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.ctx != nil {
		return
	}
	s.ctx, s.cancel = context.WithCancel(ctx)
	s.host = host
	for _, record := range s.records {
		s.connectLocked(record)
	}
}

func (s *Service) Close() error {
	s.mu.Lock()
	s.closed = true
	if s.cancel != nil {
		s.cancel()
	}
	s.mu.Unlock()
	s.wg.Wait()
	return nil
}

func (s *Service) index(id string) int {
	return slices.IndexFunc(s.records, func(b model.Bot) bool { return b.ID == id })
}

func (s *Service) view(record model.Bot) View {
	view := View{ID: record.ID, Name: record.Name, Platform: record.Platform, AppID: record.AppID,
		OwnerID: record.OwnerID, WorkspaceHash: record.WorkspaceHash, Enabled: record.Enabled,
		AllowedUserIDs: append([]string{}, record.AllowedUserIDs...), AllowedChatIDs: append([]string{}, record.AllowedChatIDs...),
		Chats: append([]model.BotChat{}, record.Chats...), CreatedAt: record.CreatedAt, State: "disabled"}
	if record.Enabled {
		view.State = "offline"
	}
	if c := s.connections[record.ID]; c != nil && record.Enabled {
		view.State, view.Error = c.state, c.error
	}
	return view
}

func (s *Service) List() []View {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]View, 0, len(s.records))
	for _, record := range s.records {
		out = append(out, s.view(record))
	}
	return out
}

func validateUpdate(input Update) error {
	if strings.TrimSpace(input.Name) == "" || utf8.RuneCountInString(input.Name) > 80 {
		return fmt.Errorf("Bot 名称应为 1–80 个字符")
	}
	for _, ids := range [][]string{input.AllowedChatIDs, input.AllowedUserIDs} {
		if len(ids) > 100 {
			return fmt.Errorf("授权列表最多 100 项")
		}
		for _, id := range ids {
			if strings.TrimSpace(id) == "" || len(id) > 200 {
				return fmt.Errorf("授权 ID 无效")
			}
		}
	}
	return nil
}

func (s *Service) Update(id string, input Update) (View, error) {
	if err := validateUpdate(input); err != nil {
		return View{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return View{}, ErrClosed
	}
	i := s.index(id)
	if i < 0 {
		return View{}, ErrNotFound
	}
	next := slices.Clone(s.records)
	next[i].Name, next[i].Enabled = strings.TrimSpace(input.Name), input.Enabled
	next[i].AllowedUserIDs, next[i].AllowedChatIDs = slices.Clone(input.AllowedUserIDs), slices.Clone(input.AllowedChatIDs)
	next[i].UpdatedAt = time.Now().UnixMilli()
	if err := s.store.Save(next); err != nil {
		return View{}, fmt.Errorf("%w: %w", ErrStorage, err)
	}
	previous := s.records[i]
	s.records = next
	if previous.Enabled != input.Enabled || !slices.Equal(previous.AllowedUserIDs, input.AllowedUserIDs) || !slices.Equal(previous.AllowedChatIDs, input.AllowedChatIDs) {
		s.connectLocked(next[i])
	}
	return s.view(next[i]), nil
}

func (s *Service) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	i := s.index(id)
	if i < 0 {
		return ErrNotFound
	}
	next := slices.Delete(slices.Clone(s.records), i, i+1)
	if err := s.store.Save(next); err != nil {
		return fmt.Errorf("%w: %w", ErrStorage, err)
	}
	s.records = next
	if c := s.connections[id]; c != nil {
		c.cancel()
		delete(s.connections, id)
	}
	for _, reg := range s.registrations {
		if reg.target == id && (reg.State == "starting" || reg.State == "waiting") {
			reg.cancel()
			reg.State, reg.URL = "cancelled", ""
		}
	}
	return nil
}

func newID() (string, error) {
	var data [12]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(data[:]), nil
}

func (s *Service) BeginRegistration(name, target string) (Registration, error) {
	id, err := newID()
	if err != nil {
		return Registration{}, err
	}
	if strings.TrimSpace(name) == "" {
		name = "Bot-飞书-" + id[:5]
	}
	if err := validateUpdate(Update{Name: name}); err != nil {
		return Registration{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.ctx == nil {
		return Registration{}, ErrClosed
	}
	appID := ""
	if target != "" {
		i := s.index(target)
		if i < 0 {
			return Registration{}, ErrNotFound
		}
		appID, name = s.records[i].AppID, s.records[i].Name
	}
	for key, reg := range s.registrations {
		if target != "" && reg.target == target && (reg.State == "starting" || reg.State == "waiting") {
			reg.cancel()
			reg.State, reg.URL = "cancelled", ""
		}
		if reg.State != "starting" && reg.State != "waiting" && time.Now().UnixMilli()-reg.ExpiresAt > int64(15*time.Minute/time.Millisecond) {
			delete(s.registrations, key)
		}
	}
	if len(s.registrations) >= 32 {
		return Registration{}, fmt.Errorf("授权请求过多，请稍后重试")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Minute)
	reg := &Registration{ID: id, Name: strings.TrimSpace(name), State: "starting", ExpiresAt: time.Now().Add(10 * time.Minute).UnixMilli(), cancel: cancel, target: target}
	s.registrations[id] = reg
	s.wg.Add(1)
	go s.register(ctx, reg, appID)
	return *reg, nil
}

func (s *Service) Registration(id string) (Registration, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	reg := s.registrations[id]
	if reg == nil {
		return Registration{}, ErrNotFound
	}
	return *reg, nil
}

func (s *Service) CancelRegistration(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if reg := s.registrations[id]; reg != nil {
		reg.cancel()
		if reg.State == "starting" || reg.State == "waiting" {
			reg.State, reg.URL = "cancelled", ""
		}
		return nil
	}
	return ErrNotFound
}

func (s *Service) register(ctx context.Context, reg *Registration, appID string) {
	defer s.wg.Done()
	defer reg.cancel()
	credentials, err := s.provider.Register(ctx, appID, reg.Name, func(url string, seconds int) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if ctx.Err() == nil && reg.State != "cancelled" {
			reg.URL, reg.State, reg.ExpiresAt = url, "waiting", time.Now().Add(time.Duration(seconds)*time.Second).UnixMilli()
		}
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	if reg.State == "cancelled" || s.closed {
		return
	}
	fail := func(message string) { reg.State, reg.Error, reg.URL = "failed", message, "" }
	if err != nil || ctx.Err() != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			fail("二维码已过期，请重新授权")
		} else {
			fail("飞书授权未完成，请重试")
		}
		return
	}
	if credentials.AppID == "" || credentials.AppSecret == "" || credentials.OwnerID == "" {
		fail("飞书授权缺少应用或用户信息，请重试")
		return
	}
	next := slices.Clone(s.records)
	record := model.Bot{ID: reg.ID, Name: reg.Name, Platform: "feishu", Enabled: true, CreatedAt: time.Now().UnixMilli()}
	index := s.index(reg.target)
	if reg.target != "" {
		if index < 0 || credentials.AppID != appID {
			fail("重新授权的应用不匹配")
			return
		}
		record = next[index]
	}
	for _, existing := range next {
		if existing.AppID == credentials.AppID && existing.ID != record.ID {
			fail("此飞书应用已经添加")
			return
		}
	}
	record.AppID, record.AppSecret, record.OwnerID, record.TenantBrand = credentials.AppID, credentials.AppSecret, credentials.OwnerID, credentials.TenantBrand
	if record.WorkspaceHash == "" {
		// 项目路径按 Bot ID 固定，保存失败后重试不会重复创建目录。
		record.WorkspaceHash, err = s.host.PrepareBotProject(ctx, record.ID)
		if err != nil {
			fail("创建 Bot 项目失败，请检查本地目录后重试")
			return
		}
	}
	record.UpdatedAt = time.Now().UnixMilli()
	if index < 0 {
		next = append(next, record)
	} else {
		next[index] = record
	}
	if err := s.store.Save(next); err != nil {
		fail("保存 Bot 失败，请检查本地配置目录")
		return
	}
	s.records = next
	reg.State, reg.BotID, reg.URL = "completed", record.ID, ""
	s.connectLocked(record)
}

func (s *Service) connectLocked(record model.Bot) {
	if c := s.connections[record.ID]; c != nil {
		c.cancel()
		delete(s.connections, record.ID)
	}
	if !record.Enabled || s.ctx == nil || s.closed {
		return
	}
	ctx, cancel := context.WithCancel(s.ctx)
	c := &connection{cancel: cancel, state: "connecting", busy: map[string]bool{}}
	s.connections[record.ID] = c
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for ctx.Err() == nil {
			err := s.provider.Connect(ctx, record, func(_ context.Context, message model.BotMessage, reply func(context.Context, string) error) error {
				return s.receive(ctx, record.ID, c, message, reply)
			}, func(state string) {
				s.mu.Lock()
				if s.connections[record.ID] == c && ctx.Err() == nil {
					c.state, c.error = state, ""
				}
				s.mu.Unlock()
			})
			s.mu.Lock()
			if s.connections[record.ID] == c && ctx.Err() == nil {
				c.state, c.error = "error", "飞书连接中断，正在重试"
			}
			s.mu.Unlock()
			if err != nil && ctx.Err() == nil {
				logging.Warnf("bot", "connection ended bot=%s; retry in 30s", record.ID)
			}
			timer := time.NewTimer(30 * time.Second)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
}

func (s *Service) receive(ctx context.Context, id string, c *connection, msg model.BotMessage, reply func(context.Context, string) error) error {
	s.mu.Lock()
	i := s.index(id)
	if s.closed || ctx.Err() != nil || i < 0 || s.connections[id] != c {
		s.mu.Unlock()
		return nil
	}
	record := s.records[i]
	if msg.ID == "" || msg.ChatID == "" || msg.UserID == "" || strings.TrimSpace(msg.Text) == "" ||
		(msg.UserID != record.OwnerID && !slices.Contains(record.AllowedUserIDs, msg.UserID)) ||
		(msg.ChatType != "p2p" && (msg.ChatType != "group" || !msg.MentionedBot || !slices.Contains(record.AllowedChatIDs, msg.ChatID))) ||
		slices.Contains(record.SeenMessages, msg.ID) {
		s.mu.Unlock()
		return nil
	}
	if c.busy[msg.ChatID] {
		s.noticeLocked(ctx, reply, "当前会话正在执行，请等待完成后再发送。")
		s.mu.Unlock()
		return nil
	}
	if msg.HasAttachments {
		s.noticeLocked(ctx, reply, "目前支持文字消息，请将图片或附件中的任务内容以文字发送。")
		s.mu.Unlock()
		return nil
	}
	if s.active >= 64 {
		s.mu.Unlock()
		return fmt.Errorf("Bot 正在处理过多消息，请稍后重试")
	}
	sessionName := ""
	chats := slices.Clone(record.Chats)
	for j := range chats {
		if chats[j].ChatID == msg.ChatID {
			sessionName = chats[j].SessionName
			chats[j].UpdatedAt = time.Now().UnixMilli()
		}
	}
	if sessionName == "" {
		digest := sha256.Sum256([]byte(id + ":" + msg.ChatID))
		sessionName = "bot-" + hex.EncodeToString(digest[:10])
		chats = append(chats, model.BotChat{ChatID: msg.ChatID, ChatType: msg.ChatType, SessionName: sessionName, UpdatedAt: time.Now().UnixMilli()})
	}
	next := slices.Clone(s.records)
	next[i].Chats = chats
	next[i].SeenMessages = append(slices.Clone(record.SeenMessages), msg.ID)
	if len(next[i].SeenMessages) > 512 {
		next[i].SeenMessages = slices.Clone(next[i].SeenMessages[len(next[i].SeenMessages)-512:])
	}
	if err := s.store.Save(next); err != nil {
		s.mu.Unlock()
		return fmt.Errorf("persist bot message: %w", err)
	}
	s.records = next
	c.busy[msg.ChatID] = true
	s.active++
	// 回调执行也纳入关闭等待，避免连接停止后仍有旧轮次写入会话。
	s.wg.Add(1)
	s.mu.Unlock()
	// 收到消息后立即确认事件，模型执行不能占用飞书事件回调的响应窗口。
	go func() {
		defer s.wg.Done()
		defer func() {
			s.mu.Lock()
			delete(c.busy, msg.ChatID)
			s.active--
			s.mu.Unlock()
		}()
		runCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
		defer cancel()
		ackCtx, ackCancel := context.WithTimeout(runCtx, 10*time.Second)
		if err := reply(ackCtx, "已收到，正在处理。需要审批时请在 Loopra 工作台确认。"); err != nil && runCtx.Err() == nil {
			logging.Warnf("bot", "acknowledgement failed bot=%s", id)
		}
		ackCancel()
		if runCtx.Err() != nil {
			return
		}
		text, err := s.host.RunBotTurn(runCtx, record.WorkspaceHash, sessionName, msg.Text)
		if runCtx.Err() != nil {
			return
		}
		if err != nil {
			text = "本次执行未完成，请在 Loopra 工作台查看会话后重试。"
		}
		if strings.TrimSpace(text) == "" {
			text = "已处理完成。"
		}
		if err := reply(runCtx, text); err != nil && runCtx.Err() == nil {
			s.mu.Lock()
			if s.connections[id] == c {
				c.error = "回复发送失败，请在工作台查看会话"
			}
			s.mu.Unlock()
			logging.Warnf("bot", "reply failed bot=%s", id)
		}
	}()
	return nil
}

func (s *Service) noticeLocked(ctx context.Context, reply func(context.Context, string) error, text string) {
	if s.active >= 64 {
		return
	}
	s.active++
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		defer func() {
			s.mu.Lock()
			s.active--
			s.mu.Unlock()
		}()
		replyCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := reply(replyCtx, text); err != nil && ctx.Err() == nil {
			logging.Warnf("bot", "notice delivery failed")
		}
	}()
}
