//go:build webdist

package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Bundle 是 pnpm build 产出的工作台。调用前 dist 目录必须已经存在。
func Bundle() fs.FS {
	files, err := fs.Sub(dist, "dist")
	if err != nil {
		return nil
	}
	return files
}
