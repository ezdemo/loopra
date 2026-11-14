package connector

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"golang.org/x/oauth2"

	"github.com/ezdemo/looprax/internal/repository"
)

// 连接状态：connected 正常可用；needs_reauth 令牌失效、需要用户
// 重新走授权流程。
const (
	StatusConnected   = "connected"
	StatusNeedsReauth = "needs_reauth"
)

// entry 是 connectors.json 中单个连接器的持久化记录。
type entry struct {
	Enabled     bool              `json:"enabled"`
	ConnectedAt int64             `json:"connectedAt,omitempty"` // 毫秒时间戳
	Status      string            `json:"status"`
	Fields      map[string]string `json:"fields,omitempty"`
	OAuth       *OAuthState       `json:"oauth,omitempty"`

	extra map[string]json.RawMessage // 未知字段原样保留
}

// OAuthState 保存授权流程结束时由 SDK 交付的客户端配置与令牌，
// 供后续会话轮次重建刷新令牌源。
type OAuthState struct {
	ClientID     string       `json:"clientId"`
	ClientSecret string       `json:"clientSecret,omitempty"`
	AuthURL      string       `json:"authUrl"`
	TokenURL     string       `json:"tokenUrl"`
	AuthStyle    int          `json:"authStyle"`
	Scopes       []string     `json:"scopes,omitempty"`
	Token        *StoredToken `json:"token,omitempty"`
}

// StoredToken 与 oauth2.Token 的可序列化子集对应。
type StoredToken struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	TokenType    string    `json:"token_type,omitempty"`
	Expiry       time.Time `json:"expiry,omitempty"`
}

func (e *entry) UnmarshalJSON(data []byte) error {
	type plain entry
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	var value plain
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*e = entry(value)
	for _, key := range []string{"enabled", "connectedAt", "status", "fields", "oauth"} {
		delete(raw, key)
	}
	e.extra = raw
	return nil
}

func (e entry) MarshalJSON() ([]byte, error) {
	out := map[string]json.RawMessage{}
	for key, value := range e.extra {
		out[key] = value
	}
	type plain entry
	data, err := json.Marshal(plain(e))
	if err != nil {
		return nil, err
	}
	var known map[string]json.RawMessage
	if err := json.Unmarshal(data, &known); err != nil {
		return nil, err
	}
	for key, value := range known {
		out[key] = value
	}
	return json.Marshal(out)
}

func storedTokenFrom(token *oauth2.Token) *StoredToken {
	if token == nil {
		return nil
	}
	return &StoredToken{
		AccessToken:  token.AccessToken,
		RefreshToken: token.RefreshToken,
		TokenType:    token.TokenType,
		Expiry:       token.Expiry,
	}
}

func (t *StoredToken) oauth2Token() *oauth2.Token {
	return &oauth2.Token{
		AccessToken:  t.AccessToken,
		RefreshToken: t.RefreshToken,
		TokenType:    t.TokenType,
		Expiry:       t.Expiry,
	}
}

func (s *OAuthState) oauth2Config() *oauth2.Config {
	return &oauth2.Config{
		ClientID:     s.ClientID,
		ClientSecret: s.ClientSecret,
		Scopes:       s.Scopes,
		Endpoint: oauth2.Endpoint{
			AuthURL:   s.AuthURL,
			TokenURL:  s.TokenURL,
			AuthStyle: oauth2.AuthStyle(s.AuthStyle),
		},
	}
}

// loadLocked 读取 connectors.json。文件不存在返回空表；顶层未知
// 字段与条目内未知字段都在写回时保留。
func (s *Service) loadLocked() error {
	if s.loaded {
		return nil
	}
	s.entries = map[string]*entry{}
	s.fileExtra = map[string]json.RawMessage{}
	data, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			s.loaded = true
			return nil
		}
		return fmt.Errorf("read connectors store: %w", err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return fmt.Errorf("invalid connectors store: %w", err)
	}
	for key, value := range raw {
		if key != "connectors" {
			s.fileExtra[key] = value
		}
	}
	if connectors, ok := raw["connectors"]; ok {
		var entries map[string]*entry
		if err := json.Unmarshal(connectors, &entries); err != nil {
			return fmt.Errorf("invalid connectors store: %w", err)
		}
		for id, e := range entries {
			if e != nil {
				s.entries[id] = e
			}
		}
	}
	s.loaded = true
	return nil
}

// saveLocked 原子写回（repository.WriteFile 的临时文件即 0600，
// 重命名后保留该权限），调用方须已持有 s.mu。
func (s *Service) saveLocked() error {
	out := map[string]json.RawMessage{}
	for key, value := range s.fileExtra {
		out[key] = value
	}
	connectors, err := json.Marshal(s.entries)
	if err != nil {
		return err
	}
	out["connectors"] = connectors
	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	return repository.WriteFile(s.path, append(data, '\n'))
}

// mutate 在单互斥锁内完成 读-改-写，避免半文件与并发覆盖。
func (s *Service) mutate(fn func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.loadLocked(); err != nil {
		return err
	}
	if err := fn(); err != nil {
		return err
	}
	return s.saveLocked()
}
