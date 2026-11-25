//go:build !microacp

package microacp

// 普通构建不内嵌 micro-acp；Available 返回 false，tui 走内置终端界面。
var (
	payload []byte
	notice  []byte
)
