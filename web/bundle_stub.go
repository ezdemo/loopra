//go:build !webdist

package web

import "io/fs"

// Bundle 在默认构建里为空。执行 web 目录的 pnpm build 后，
// go build -tags webdist 会把 web/dist 嵌进二进制。
func Bundle() fs.FS { return nil }
