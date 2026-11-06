package bot

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ezdemo/looprax/internal/model"
)

type memoryStore struct {
	data []byte
	fail bool
}

func (m *memoryStore) Load() ([]model.Bot, error) {
	var records []model.Bot
	if len(m.data) == 0 {
		return []model.Bot{}, nil
	}
	err := json.Unmarshal(m.data, &records)
	return records, err
}
func (m *memoryStore) Save(records []model.Bot) error {
	if m.fail {
		return errors.New("disk unavailable")
	}
	data, err := json.Marshal(records)
	if err == nil {
		m.data = data
	}
	return err
}

type fakeConnection struct {
	ctx     context.Context
	receive func(context.Context, model.BotMessage, func(context.Context, string) error) error
	state   func(string)
}

type fakeProvider struct {
	connections chan fakeConnection
	credentials chan model.BotCredentials
}

func (p *fakeProvider) Register(ctx context.Context, _, _ string, qr func(string, int)) (model.BotCredentials, error) {
	qr("https://accounts.feishu.cn/test-authorization", 600)
	select {
	case credentials := <-p.credentials:
		return credentials, nil
	case <-ctx.Done():
		return model.BotCredentials{}, ctx.Err()
	}
}
func (p *fakeProvider) Connect(ctx context.Context, _ model.Bot, receive func(context.Context, model.BotMessage, func(context.Context, string) error) error, state func(string)) error {
	state("connected")
	select {
	case p.connections <- fakeConnection{ctx, receive, state}:
	case <-ctx.Done():
		return ctx.Err()
	}
	<-ctx.Done()
	return ctx.Err()
}

type fakeHost struct {
	mu       sync.Mutex
	prepared []string
	turns    [][3]string
	run      func(context.Context) error
}

func (h *fakeHost) PrepareBotProject(_ context.Context, id string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.prepared = append(h.prepared, id)
	return "workspace-" + id, nil
}
func (h *fakeHost) RunBotTurn(ctx context.Context, hash, session, text string) (string, error) {
	h.mu.Lock()
	h.turns = append(h.turns, [3]string{hash, session, text})
	run := h.run
	h.mu.Unlock()
	if run != nil {
		return "", run(ctx)
	}
	return "agent reply", nil
}

func fixture(t *testing.T, records ...model.Bot) (*Service, *memoryStore, *fakeProvider, *fakeHost) {
	t.Helper()
	store := &memoryStore{}
	if records == nil {
		records = []model.Bot{}
	}
	if err := store.Save(records); err != nil {
		t.Fatal(err)
	}
	p := &fakeProvider{connections: make(chan fakeConnection, 10), credentials: make(chan model.BotCredentials, 10)}
	host := &fakeHost{}
	s, err := New(store, p)
	if err != nil {
		t.Fatal(err)
	}
	s.Start(context.Background(), host)
	t.Cleanup(func() { _ = s.Close() })
	return s, store, p, host
}

func connected(t *testing.T, p *fakeProvider) fakeConnection {
	t.Helper()
	select {
	case c := <-p.connections:
		return c
	case <-time.After(3 * time.Second):
		t.Fatal("connection did not start")
		return fakeConnection{}
	}
}

func waitRegistration(t *testing.T, s *Service, id, state string) Registration {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		reg, err := s.Registration(id)
		if err != nil {
			t.Fatal(err)
		}
		if reg.State == state {
			return reg
		}
		time.Sleep(time.Millisecond)
	}
	reg, _ := s.Registration(id)
	t.Fatalf("registration = %+v, want %s", reg, state)
	return reg
}

func existingBot() model.Bot {
	return model.Bot{ID: "bot-one", Name: "Bot", Platform: "feishu", AppID: "cli-test", AppSecret: "test-secret",
		OwnerID: "owner", WorkspaceHash: "main", Enabled: true, AllowedChatIDs: []string{"group"}, AllowedUserIDs: []string{"trusted"}}
}

func waitIdle(t *testing.T, s *Service) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		active := s.active
		s.mu.Unlock()
		if active == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("bot tasks did not finish")
}

func TestRegistrationCreatesOneProjectAndReauthorizationKeepsBindings(t *testing.T) {
	s, _, p, host := fixture(t)
	reg, err := s.BeginRegistration("", "")
	if err != nil {
		t.Fatal(err)
	}
	waitRegistration(t, s, reg.ID, "waiting")
	if len(s.List()) != 0 {
		t.Fatal("Bot created before authorization")
	}
	p.credentials <- model.BotCredentials{AppID: "cli-new", AppSecret: "test-secret", OwnerID: "owner"}
	reg = waitRegistration(t, s, reg.ID, "completed")
	connected(t, p)
	view := s.List()[0]
	if view.WorkspaceHash == "" || view.Name != "Bot-飞书-"+reg.ID[:5] {
		t.Fatalf("created = %+v", view)
	}
	data, _ := json.Marshal(view)
	if strings.Contains(string(data), "test-secret") || strings.Contains(string(data), "appSecret") {
		t.Fatal("HTTP view exposes credentials")
	}
	again, err := s.BeginRegistration("", view.ID)
	if err != nil {
		t.Fatal(err)
	}
	p.credentials <- model.BotCredentials{AppID: "cli-new", AppSecret: "rotated-secret", OwnerID: "owner"}
	waitRegistration(t, s, again.ID, "completed")
	connected(t, p)
	host.mu.Lock()
	defer host.mu.Unlock()
	if len(host.prepared) != 1 || len(s.List()) != 1 || s.List()[0].WorkspaceHash != view.WorkspaceHash {
		t.Fatal("reauthorization recreated a project or Bot")
	}
}

func TestCancelledRegistrationCannotCreateBot(t *testing.T) {
	s, _, _, host := fixture(t)
	reg, err := s.BeginRegistration("", "")
	if err != nil {
		t.Fatal(err)
	}
	waitRegistration(t, s, reg.ID, "waiting")
	if err := s.CancelRegistration(reg.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if len(s.List()) != 0 || len(host.prepared) != 0 {
		t.Fatal("cancelled registration created local data")
	}
	if _, err := s.BeginRegistration("", ""); !errors.Is(err, ErrClosed) {
		t.Fatalf("register after close = %v", err)
	}
}

func TestPersistenceFailureKeepsConnectionAndPreviousConfiguration(t *testing.T) {
	s, store, p, _ := fixture(t, existingBot())
	c := connected(t, p)
	s.mu.Lock()
	store.fail = true
	s.mu.Unlock()
	if _, err := s.Update("bot-one", Update{Name: "changed", Enabled: false}); err == nil {
		t.Fatal("save failure ignored")
	}
	if err := s.Delete("bot-one"); err == nil {
		t.Fatal("delete failure ignored")
	}
	view := s.List()[0]
	if view.Name != "Bot" || !view.Enabled || c.ctx.Err() != nil {
		t.Fatalf("failed update changed live state: %+v", view)
	}
	s.mu.Lock()
	store.fail = false
	s.mu.Unlock()
	if _, err := s.Update("bot-one", Update{Name: "renamed", Enabled: true, AllowedUserIDs: []string{"trusted"}, AllowedChatIDs: []string{"group"}}); err != nil {
		t.Fatal(err)
	}
	if c.ctx.Err() != nil {
		t.Fatal("renaming cancelled the active connection")
	}
}

func TestMessagePersistenceFailureDoesNotExecuteAndCanRetry(t *testing.T) {
	s, store, p, host := fixture(t, existingBot())
	c := connected(t, p)
	message := model.BotMessage{ID: "retryable", ChatID: "dm", ChatType: "p2p", UserID: "owner", Text: "task"}
	reply := func(context.Context, string) error { return nil }
	s.mu.Lock()
	store.fail = true
	s.mu.Unlock()
	if err := c.receive(c.ctx, message, reply); err == nil {
		t.Fatal("message executed without durable acceptance")
	}
	if len(s.List()[0].Chats) != 0 || len(host.turns) != 0 {
		t.Fatal("failed persistence changed bindings or executed a turn")
	}
	s.mu.Lock()
	store.fail = false
	s.mu.Unlock()
	if err := c.receive(c.ctx, message, reply); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, s)
	if len(host.turns) != 1 {
		t.Fatal("failed acceptance could not be retried")
	}
}

func TestMessagesAreAuthorizedDeduplicatedAndIsolated(t *testing.T) {
	s, store, p, host := fixture(t, existingBot())
	c := connected(t, p)
	replies := make(chan string, 30)
	reply := func(_ context.Context, text string) error { replies <- text; return nil }
	for _, msg := range []model.BotMessage{
		{ID: "unknown-user", ChatID: "dm", ChatType: "p2p", UserID: "unknown", Text: "ignore"},
		{ID: "unknown-group", ChatID: "other-group", ChatType: "group", UserID: "owner", Text: "ignore", MentionedBot: true},
		{ID: "no-mention", ChatID: "group", ChatType: "group", UserID: "owner", Text: "ignore"},
	} {
		if err := c.receive(c.ctx, msg, reply); err != nil {
			t.Fatal(err)
		}
	}
	if len(replies) != 0 {
		t.Fatal("replied to unauthorized input")
	}
	msg := model.BotMessage{ID: "m1", ChatID: "dm", ChatType: "p2p", UserID: "owner", Text: "first"}
	if err := c.receive(c.ctx, msg, reply); err != nil {
		t.Fatal(err)
	}
	waitIdle(t, s)
	if err := c.receive(c.ctx, msg, reply); err != nil {
		t.Fatal(err)
	}
	msg.ID, msg.Text = "m2", "second"
	c.receive(c.ctx, msg, reply)
	waitIdle(t, s)
	msg.ID, msg.ChatID, msg.ChatType, msg.MentionedBot = "m3", "group", "group", true
	c.receive(c.ctx, msg, reply)
	waitIdle(t, s)
	trusted := model.BotMessage{ID: "trusted-message", ChatID: "trusted-dm", ChatType: "p2p", UserID: "trusted", Text: "task"}
	c.receive(c.ctx, trusted, reply)
	waitIdle(t, s)
	host.mu.Lock()
	turns := append([][3]string{}, host.turns...)
	host.mu.Unlock()
	if len(turns) != 4 || turns[0][1] != turns[1][1] || turns[0][1] == turns[2][1] || turns[0][1] == turns[3][1] || turns[0][0] != "main" {
		t.Fatalf("turn routing = %v", turns)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	// 重启后重复投递仍不能再次执行。
	records, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	s2, _, p2, host2 := fixture(t, records...)
	c2 := connected(t, p2)
	if err := c2.receive(c2.ctx, msg, reply); err != nil {
		t.Fatal(err)
	}
	if len(host2.turns) != 0 || !reflect.DeepEqual(s.List()[0].Chats, s2.List()[0].Chats) {
		t.Fatal("restart lost message deduplication or bindings")
	}
}

func TestDisableCancelsOldTurnAndOldCallbacksCannotChangeNewState(t *testing.T) {
	s, _, p, host := fixture(t, existingBot())
	c := connected(t, p)
	started := make(chan struct{})
	cancelled := make(chan struct{})
	host.run = func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(cancelled)
		return ctx.Err()
	}
	notices := make(chan string, 10)
	reply := func(_ context.Context, text string) error { notices <- text; return nil }
	if err := c.receive(c.ctx, model.BotMessage{ID: "m", ChatID: "dm", ChatType: "p2p", UserID: "owner", Text: "run"}, reply); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("turn not started")
	}
	if err := c.receive(c.ctx, model.BotMessage{ID: "busy", ChatID: "dm", ChatType: "p2p", UserID: "owner", Text: "second"}, reply); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(3 * time.Second)
	foundBusy := false
	for !foundBusy {
		select {
		case text := <-notices:
			foundBusy = strings.Contains(text, "正在执行")
		case <-deadline:
			t.Fatal("busy conversation did not respond")
		}
	}
	if _, err := s.Update("bot-one", Update{Name: "Bot", Enabled: false}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("old turn survived disabling")
	}
	if _, err := s.Update("bot-one", Update{Name: "Bot", Enabled: true}); err != nil {
		t.Fatal(err)
	}
	connected(t, p)
	c.state("error")
	if s.List()[0].State != "connected" {
		t.Fatal("old callback overwrote new connection")
	}
	if err := s.Delete("bot-one"); err != nil || len(s.List()) != 0 {
		t.Fatalf("delete = %v", err)
	}
}
