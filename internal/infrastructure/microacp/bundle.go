//go:build microacp

package microacp

import _ "embed"

// payload.gz 由打包脚本在编译期通过 -overlay 提供，内容固定为
// BrokkAi/micro-acp 官方 v0.8.1 发布物的可执行文件；仓库不提交二进制。

//go:embed payload.gz
var payload []byte

//go:embed LICENSE
var notice []byte
