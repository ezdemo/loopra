package almarelay

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
)

type ConfigStore interface {
	Load() (map[string]any, error)
	Save(map[string]any) error
}

var ErrConfigStorage = errors.New("保存远程访问配置失败")

// Update uses pointers so an omitted key preserves the saved secret, while
// an explicit empty string clears it. Secrets never appear in status replies.
type Update struct {
	Enabled         *bool   `json:"enabled,omitempty"`
	RelayURL        *string `json:"relayUrl,omitempty"`
	RegistrationKey *string `json:"registrationKey,omitempty"`
}

// Manager owns replacement transports. Each Service keeps an immutable Config;
// saving, pairing rotation, startup and shutdown share one operation boundary.
type Manager struct {
	op      sync.Mutex
	mu      sync.Mutex
	store   ConfigStore
	config  Config
	enabled bool
	service *Service
	ctx     context.Context
	cancel  context.CancelFunc
	host    Host
	closed  bool
}

func NewManager(store ConfigStore, defaults Config) (*Manager, error) {
	fields, err := store.Load()
	if err != nil {
		return nil, err
	}
	m := &Manager{store: store, config: defaults, enabled: defaults.URL != ""}
	if enabled, exists := fields["enabled"]; exists {
		value, ok := enabled.(bool)
		if !ok {
			return nil, errors.New("无效的远程访问配置")
		}
		m.enabled = value
		// A UI save is authoritative, including disabling an environment opt-in.
		m.config.URL, m.config.Key = "", ""
	}
	for field, target := range map[string]*string{"relayUrl": &m.config.URL, "registrationKey": &m.config.Key, "connectCode": &m.config.ConnectCode} {
		if value, exists := fields[field]; exists {
			text, ok := value.(string)
			if !ok {
				return nil, errors.New("无效的远程访问配置")
			}
			*target = text
		}
	}
	config, service, err := prepareRemote(m.config, m.enabled)
	if err != nil {
		return nil, err
	}
	if config.ConnectCode != m.config.ConnectCode {
		if err := store.Save(map[string]any{"connectCode": config.ConnectCode}); err != nil {
			return nil, fmt.Errorf("保存配对信息失败: %w", err)
		}
	}
	m.config, m.service = config, service
	return m, nil
}

func prepareRemote(config Config, enabled bool) (Config, *Service, error) {
	config.URL = strings.TrimRight(strings.TrimSpace(config.URL), "/")
	if len(config.URL) > 512 {
		return config, nil, errors.New("中继地址过长")
	}
	if len(config.Key) > 8192 {
		return config, nil, errors.New("注册密钥过长")
	}
	if enabled && config.URL == "" {
		return config, nil, errors.New("请填写中继地址")
	}
	if config.ConnectCode == "" && enabled {
		code := make([]byte, 32)
		if _, err := rand.Read(code); err != nil {
			return config, nil, err
		}
		config.ConnectCode = base64.RawURLEncoding.EncodeToString(code)
	}
	if config.ConnectCode != "" {
		code, err := base64.RawURLEncoding.DecodeString(config.ConnectCode)
		if err != nil || len(code) != 32 {
			return config, nil, errors.New("配对信息无效，请检查 alma-relay.json")
		}
	}
	if config.URL != "" {
		probe := config
		if probe.ConnectCode == "" {
			probe.ConnectCode = base64.RawURLEncoding.EncodeToString(make([]byte, 32))
		}
		if _, err := New(probe); err != nil {
			return config, nil, errors.New("请输入有效的 HTTP / HTTPS 中继地址，不要包含路径或查询参数")
		}
	}
	if !enabled {
		service, err := New(Config{})
		return config, service, err
	}
	service, err := New(config)
	return config, service, err
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	status := m.service.Status()
	status.RelayURL, status.HasRegistrationKey = m.config.URL, m.config.Key != ""
	return status
}

func (m *Manager) Start(ctx context.Context, host Host) {
	m.op.Lock()
	defer m.op.Unlock()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.host != nil {
		return
	}
	m.ctx, m.cancel = context.WithCancel(ctx)
	m.host = host
	m.service.Start(m.ctx, host)
}

func (m *Manager) Update(update Update) (Status, error) { return m.apply(update, false) }
func (m *Manager) ResetPairing() (Status, error)        { return m.apply(Update{}, true) }

func (m *Manager) apply(update Update, rotate bool) (Status, error) {
	m.op.Lock()
	defer m.op.Unlock()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return Status{}, errors.New("远程访问服务已关闭")
	}
	config, enabled := m.config, m.enabled
	old := m.service
	m.mu.Unlock()
	if update.Enabled != nil {
		enabled = *update.Enabled
	}
	if update.RelayURL != nil {
		config.URL = *update.RelayURL
	}
	if update.RegistrationKey != nil {
		config.Key = strings.TrimSpace(*update.RegistrationKey)
	}
	if rotate {
		code := make([]byte, 32)
		if _, err := rand.Read(code); err != nil {
			return Status{}, err
		}
		config.ConnectCode = base64.RawURLEncoding.EncodeToString(code)
	}
	config, next, err := prepareRemote(config, enabled)
	if err != nil {
		return Status{}, err
	}
	patch := map[string]any{"enabled": enabled, "relayUrl": config.URL, "registrationKey": config.Key}
	if config.ConnectCode != "" {
		patch["connectCode"] = config.ConnectCode
	}
	if err := m.store.Save(patch); err != nil {
		return Status{}, fmt.Errorf("%w: %w", ErrConfigStorage, err)
	}
	// Persistence succeeds before publishing or disconnecting the old transport.
	if err := old.Close(); err != nil {
		return Status{}, err
	}
	m.mu.Lock()
	m.config, m.enabled, m.service = config, enabled, next
	if m.host != nil {
		next.Start(m.ctx, m.host)
	}
	m.mu.Unlock()
	return m.Status(), nil
}

func (m *Manager) Close() error {
	m.op.Lock()
	defer m.op.Unlock()
	m.mu.Lock()
	m.closed = true
	if m.cancel != nil {
		m.cancel()
	}
	service := m.service
	m.mu.Unlock()
	return service.Close()
}
