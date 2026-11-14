package connector

import (
	"context"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/auth"
)

// 自定义 MCP 服务的 OAuth 状态存放在与内置连接器相同的
// connectors.json 中，键为 "custom:<server-name>"，避免与
// 目录 id 冲突。只存 OAuth 凭据；启停仍以 mcp-servers.json 为准。

// CustomKey 返回自定义服务器的存储键。
func CustomKey(name string) string { return "custom:" + name }

// CustomAuthStatus 报告自定义服务器的授权状态：
// none（未授权）| connected | needs_reauth。
func (s *Service) CustomAuthStatus(key string) string {
	view := s.View(key)
	switch view.Status {
	case StatusConnected:
		return "connected"
	case StatusNeedsReauth:
		return "needs_reauth"
	default:
		return "none"
	}
}

// CustomRuntime 在存了 OAuth 凭据时返回与内置连接器一致的
// 运行时处理器：401 标记 needs_reauth，绝不打开浏览器。
func (s *Service) CustomRuntime(key string) OAuthRuntime {
	s.mu.Lock()
	if err := s.loadLocked(); err != nil {
		s.mu.Unlock()
		return nil
	}
	e := s.entries[key]
	has := e != nil && e.OAuth != nil && e.OAuth.Token != nil
	s.mu.Unlock()
	if !has {
		return nil
	}
	return &runtimeOAuth{svc: s, id: key}
}

// StartCustomAuthorization 对任意已渲染的远程 spec 发起
// 授权码 + 动态注册流程；结果写入 key 下的存储条目。
func (s *Service) StartCustomAuthorization(ctx context.Context, key string, spec Spec) (string, string, error) {
	if spec.Type != "streamable" && spec.Type != "sse" {
		return "", "", fmt.Errorf("该服务器的传输方式不支持 OAuth")
	}
	return s.startOAuth(ctx, key, spec, func(redirect string, f *flow) (*auth.AuthorizationCodeHandlerConfig, error) {
		return s.handlerConfig(key, nil, redirect, f)
	})
}

// ClearCustom 删除自定义服务器的存储条目（退出登录）。
func (s *Service) ClearCustom(key string) error {
	s.cancelFlowFor(key)
	return s.mutate(func() error {
		delete(s.entries, key)
		return nil
	})
}

// RenameCustom 把服务器改名前的凭据条目迁移到新名字。
func (s *Service) RenameCustom(oldKey, newKey string) error {
	if oldKey == newKey {
		return nil
	}
	return s.mutate(func() error {
		if e := s.entries[oldKey]; e != nil {
			s.entries[newKey] = e
			delete(s.entries, oldKey)
		}
		return nil
	})
}
