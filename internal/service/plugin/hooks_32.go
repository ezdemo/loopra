//go:build 386 || arm

package plugin

import "context"

// RunHook 在 32 位安装包里不调用插件。moejs 只支持 64 位 int。
func (*Host) RunHook(_ context.Context, _ string, input map[string]any, _ func(map[string]any) bool) (map[string]any, map[string]bool) {
	return cloneMap(input), map[string]bool{}
}
