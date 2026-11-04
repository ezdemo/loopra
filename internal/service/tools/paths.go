package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ezdemo/looprax/internal/infrastructure/fsutil"
)

// linkedProjectsKey 携带本轮显式关联的项目根目录。
type linkedProjectsKey struct{}

// WithLinkedProjects 仅授予当前轮次访问显式关联根目录的权限。
func WithLinkedProjects(ctx context.Context, roots []string) context.Context {
	return context.WithValue(ctx, linkedProjectsKey{}, append([]string(nil), roots...))
}

// scopedKey 携带“写入类工具只能访问项目内路径”的设置。
// 缺省（未安装）表示不限制：允许项目外的绝对路径。
type scopedKey struct{}

// WithWorkspaceScope 安装工作区限制开关。它只作用于会改动文件的工具
// （write、edit 以及命令工具的工作目录）；只读工具永远不受它影响。
func WithWorkspaceScope(ctx context.Context, restrict bool) context.Context {
	return context.WithValue(ctx, scopedKey{}, restrict)
}

// workspaceScope 报告当前运行是否限定在项目内。
func workspaceScope(ctx context.Context) bool {
	restrict, _ := ctx.Value(scopedKey{}).(bool)
	return restrict
}

// safePath 在 root 下解析 rel，并拒绝路径逃逸。
func safePath(root, rel string) (string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	clean := filepath.Clean(rel)
	if filepath.IsAbs(clean) {
		return "", fmt.Errorf("仅允许项目内相对路径")
	}
	abs := filepath.Join(root, clean)
	if root != abs && !strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return "", fmt.Errorf("路径越出项目边界")
	}
	realRoot, err := fsutil.Resolve(root)
	if err != nil {
		return "", err
	}
	return resolveInside(realRoot, abs)
}

// resolveInside 把 abs 解析成不含链接的真实路径，并要求它仍在 realRoot 内。
// abs 可以是尚未创建的路径：解析最近的已存在祖先目录。
func resolveInside(realRoot, abs string) (string, error) {
	// 解析最近的已存在祖先目录，包含新文件之上的链接。
	for ancestor := abs; ; ancestor = filepath.Dir(ancestor) {
		resolved, err := fsutil.Resolve(ancestor)
		if err == nil {
			inside, err := filepath.Rel(realRoot, resolved)
			if err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) || filepath.IsAbs(inside) {
				return "", fmt.Errorf("路径越出项目边界")
			}
			suffix, _ := filepath.Rel(ancestor, abs)
			return filepath.Join(resolved, suffix), nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		if _, linkErr := os.Lstat(ancestor); linkErr == nil {
			return "", fmt.Errorf("路径包含无法解析的符号链接")
		}
		if filepath.Dir(ancestor) == ancestor {
			return "", err
		}
	}
}

// readOnlyPath 解析只读工具（read、rg、read_image）的路径。
//
// 读取不改变任何状态，所以永远不套用工作区限制：项目外的相对路径和绝对路径
// 都直接可用，方便查看依赖、日志、配置和项目外的参考代码。相对路径仍然
// 相对项目根解析，与写入工具保持一致。
func readOnlyPath(root, path string) (string, error) {
	if filepath.IsAbs(path) {
		return filepath.Clean(path), nil
	}
	abs, err := filepath.Abs(filepath.Join(root, path))
	if err != nil {
		return "", err
	}
	return abs, nil
}

// contextualPath 解析会改动文件的工具的路径，包括命令工具的工作目录。
//
// 限制开启时只接受项目内相对路径，以及当前项目或本轮关联项目内的绝对路径；
// 限制关闭时项目内相对路径仍相对项目根解析，项目外路径按原样接受
// （包含符号链接在内的越界检查交给操作系统）。
func contextualPath(ctx context.Context, root, path string) (string, error) {
	restrict := workspaceScope(ctx)
	if filepath.IsAbs(path) {
		roots, _ := ctx.Value(linkedProjectsKey{}).([]string)
		for _, candidate := range append([]string{root}, roots...) {
			rel, err := filepath.Rel(candidate, path)
			if err == nil && rel != ".." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
				return safePath(candidate, rel)
			}
		}
		if restrict {
			return "", fmt.Errorf("路径不属于当前项目或本轮关联项目")
		}
		return filepath.Abs(path)
	}
	if restrict {
		return safePath(root, path)
	}
	if abs, err := safePath(root, path); err == nil {
		return abs, nil
	}
	// 相对路径也可能指向项目内目录之外的普通位置（例如 ../ 或盘符相对写法）。
	relative, err := filepath.Abs(filepath.Join(root, path))
	if err != nil {
		return "", err
	}
	return relative, nil
}

// displayPath 返回用于展示与 diff 的路径：尽量相对项目根。
func displayPath(root, abs string) string {
	if rel, err := filepath.Rel(root, abs); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
		return rel
	}
	return abs
}
