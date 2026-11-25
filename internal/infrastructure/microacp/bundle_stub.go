//go:build !microacp

package microacp

// 普通构建不内嵌 micro-acp，由 CLI 从 PATH 查找客户端。
var (
	payload []byte
	notice  []byte
)
