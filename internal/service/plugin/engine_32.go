//go:build 386 || arm

package plugin

import (
	"context"
	"encoding/json"
	"errors"
)

// BoundTool 是插件导出的工具。32 位安装包没有 moejs，这个类型只为了和 64 位接口一致。
type BoundTool struct {
	Name        string
	Description string
	ReadOnly    bool
	Chat        bool
	Parameters  json.RawMessage
	Call        func(ctx context.Context, args map[string]any) (map[string]any, error)
}

// running 是未加载的插件。32 位上 openPackage 不会成功，这些字段留着给宿主编译。
type running struct {
	names       []string
	bound       []BoundTool
	displayName string
	description string
	entry       string
}

func (p *running) setHostServices(map[string]ServiceHandler, []string, string) error {
	return nil
}

func (*running) hasRequest() bool { return false }
func (*running) request(context.Context, map[string]any) (any, error) {
	return nil, errors.New("32 位安装包不能运行插件")
}

func (p *running) close() {
	if p == nil {
		return
	}
}

func (p *running) hookNames() []string {
	return nil
}

func openPackage(context.Context, string, record) (*running, error) {
	return nil, errors.New("32 位安装包不能运行插件，请使用 64 位 Loopra")
}
