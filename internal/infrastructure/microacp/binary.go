// Package microacp 只在打包构建里提供官方 micro-acp 终端客户端。
// 二进制在编译期随可执行文件内嵌，运行时在系统临时目录就地解包，
// 不访问网络、不查询 PATH。
package microacp

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

const maxBinarySize = 64 * 1024 * 1024

// Available 报告当前构建是否内嵌了 micro-acp。
func Available() bool {
	return len(payload) != 0
}

// Stage 把内嵌的 micro-acp 解包到系统临时目录，返回可执行文件路径
// 和移除本次解包目录的清理函数。
func Stage() (executable string, cleanup func() error, err error) {
	return stage(os.TempDir(), payload, notice)
}

func stage(root string, data, license []byte) (executable string, cleanup func() error, err error) {
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return "", nil, fmt.Errorf("open bundled micro-acp: %w", err)
	}
	defer reader.Close() // gzip reader owns no files
	dir, err := os.MkdirTemp(root, "loopra-micro-acp-")
	if err != nil {
		return "", nil, fmt.Errorf("create micro-acp temp directory: %w", err)
	}
	remove := func() error { return os.RemoveAll(dir) }
	defer func() {
		if err != nil {
			err = errors.Join(err, remove())
		}
	}()
	name := "micro-acp"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	dest := filepath.Join(dir, name)
	file, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return "", nil, fmt.Errorf("create micro-acp executable: %w", err)
	}
	n, copyErr := io.Copy(file, io.LimitReader(reader, maxBinarySize+1))
	if err := errors.Join(copyErr, file.Close()); err != nil {
		return "", nil, fmt.Errorf("extract micro-acp executable: %w", err)
	}
	if n == 0 || n > maxBinarySize {
		return "", nil, fmt.Errorf("invalid bundled micro-acp size: %d", n)
	}
	if err := os.WriteFile(filepath.Join(dir, "LICENSE"), license, 0o600); err != nil {
		return "", nil, fmt.Errorf("write micro-acp license: %w", err)
	}
	return dest, remove, nil
}
