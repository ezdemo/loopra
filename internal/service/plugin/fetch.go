package plugin

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxDownload  = 32 << 20
	maxExtract   = 64 << 20
	maxFiles     = 4000
	maxOneFile   = 8 << 20
	maxDeps      = 40
	registryHost = "registry.npmjs.org"
)

type pkgFile struct {
	Name                 string
	Version              string
	Description          string
	Loopra               string
	Services             []string
	Settings             string
	Sidebar              string
	SidebarTitle         string
	SidebarIcon          pkgIcon
	Icon                 pkgIcon
	MenuTitle            string
	MenuCategory         string
	MenuIcon             pkgIcon
	MenuPage             string
	MenuChildren         []pkgMenuChild
	SkillFile            string
	SubagentName         string
	SubagentDescription  string
	SubagentFile         string
	SubagentInstructions string
	SubagentReadOnly     bool
	SubagentSet          bool
	ScheduleName         string
	ScheduleMessage      string
	ScheduleCron         string
	ScheduleInterval     int64
	DefaultEnabled       bool
	Module               string
	Main                 string
	Entry                string
	Exports              json.RawMessage
	Dependencies         map[string]string
}

type pkgIcon struct {
	Hidden bool
	Name   string
	File   string
}

type pkgMenuChild struct {
	ID    string
	Title string
	Icon  pkgIcon
	Page  string
}

type versionDoc struct {
	Version string `json:"version"`
	Dist    struct {
		Tarball string `json:"tarball"`
	} `json:"dist"`
}

type packument struct {
	Versions map[string]versionDoc `json:"versions"`
}

type semver struct{ major, minor, patch int }

func newClient() *http.Client {
	return &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("重定向过多")
			}
			if req.URL.Scheme != "https" || !allowedHost(req.URL.Hostname()) {
				return fmt.Errorf("拒绝重定向到 %s", req.URL.Host)
			}
			return nil
		},
	}
}

func allowedHost(host string) bool {
	switch strings.ToLower(host) {
	case registryHost, "github.com", "codeload.github.com", "api.github.com", "objects.githubusercontent.com":
		return true
	default:
		return false
	}
}

func (h *Host) materialize(ctx context.Context, src origin, dest string) (pkgFile, error) {
	switch src.Kind {
	case "npm":
		version, tarball, err := h.resolveNPM(ctx, src.Name, src.Version)
		if err != nil {
			return pkgFile{}, err
		}
		if err := h.extractTarball(ctx, tarball, dest); err != nil {
			return pkgFile{}, err
		}
		info := readPkg(dest)
		if info.Name == "" {
			info.Name = src.Name
		}
		if info.Version == "" {
			info.Version = version
		}
		if err := h.installDeps(ctx, dest); err != nil {
			return pkgFile{}, err
		}
		entry, err := findEntry(dest, "")
		if err != nil {
			return pkgFile{}, err
		}
		info.Entry = entry
		return info, nil
	case "github":
		data, err := h.githubTar(ctx, src)
		if err != nil {
			return pkgFile{}, err
		}
		if err := extractTarGz(data, dest); err != nil {
			return pkgFile{}, err
		}
		if err := focus(dest, src.Subdir); err != nil {
			return pkgFile{}, err
		}
		info := readPkg(dest)
		if info.Name == "" {
			info.Name = src.Repo
		}
		if info.Version == "" {
			info.Version = src.Ref
		}
		if info.Version == "" {
			info.Version = "main"
		}
		if err := h.installDeps(ctx, dest); err != nil {
			return pkgFile{}, err
		}
		entry, err := findEntry(dest, "")
		if err != nil {
			return pkgFile{}, err
		}
		info.Entry = entry
		return info, nil
	case "local":
		return h.materializeLocal(ctx, src, dest)
	default:
		return pkgFile{}, fmt.Errorf("未知插件来源")
	}
}

func (h *Host) materializeLocal(ctx context.Context, src origin, dest string) (pkgFile, error) {
	path, err := filepath.Abs(src.Path)
	if err != nil {
		return pkgFile{}, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return pkgFile{}, fmt.Errorf("找不到本地插件 %s", src.Path)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return pkgFile{}, fmt.Errorf("不使用符号链接作为插件来源")
	}
	switch {
	case info.IsDir():
		if err := copyTree(path, dest); err != nil {
			return pkgFile{}, err
		}
	case isArchiveName(strings.ToLower(path)):
		if info.Size() > maxDownload {
			return pkgFile{}, fmt.Errorf("插件包超过 %d MiB", maxDownload>>20)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return pkgFile{}, err
		}
		if err := extractTarGz(data, dest); err != nil {
			return pkgFile{}, err
		}
	case isModuleName(strings.ToLower(path)):
		if err := stageModule(path, dest, info); err != nil {
			return pkgFile{}, err
		}
	default:
		return pkgFile{}, fmt.Errorf("本地插件需要是目录、.tgz/.tar.gz，或 .js/.ts 文件")
	}
	pkg := readPkg(dest)
	if pkg.Name == "" {
		pkg.Name = localPackageName(path)
	}
	if pkg.Version == "" {
		pkg.Version = "0.0.0"
	}
	if err := h.installDeps(ctx, dest); err != nil {
		return pkgFile{}, err
	}
	entry, err := findEntry(dest, "")
	if err != nil {
		return pkgFile{}, err
	}
	pkg.Entry = entry
	return pkg, nil
}

func localPackageName(path string) string {
	base := filepath.Base(path)
	lower := strings.ToLower(base)
	switch {
	case strings.HasSuffix(lower, ".tar.gz"):
		base = base[:len(base)-len(".tar.gz")]
	default:
		base = strings.TrimSuffix(base, filepath.Ext(base))
	}
	if strings.TrimSpace(base) == "" {
		return "plugin"
	}
	return base
}

func stageModule(src, dest string, info os.FileInfo) error {
	if info.Size() > maxOneFile {
		return fmt.Errorf("插件文件过大")
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	ext := filepath.Ext(src)
	entry := "plugin" + ext
	if err := os.WriteFile(filepath.Join(dest, entry), data, 0o644); err != nil {
		return err
	}
	body := fmt.Sprintf("{\"name\":%q,\"version\":\"0.0.0\",\"loopra\":%q}\n", localPackageName(src), "./"+entry)
	return os.WriteFile(filepath.Join(dest, "package.json"), []byte(body), 0o644)
}

func copyTree(src, dest string) error {
	absDest, err := filepath.Abs(dest)
	if err != nil {
		return err
	}
	var written int64
	files := 0
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		absPath, err := filepath.Abs(path)
		if err != nil {
			return err
		}
		if absPath == absDest {
			return filepath.SkipDir
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		target := filepath.Join(dest, rel)
		if !inside(dest, target) {
			return fmt.Errorf("本地路径非法")
		}
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		meta, err := d.Info()
		if err != nil {
			return err
		}
		if meta.Size() > maxOneFile {
			return fmt.Errorf("插件文件过大")
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			in.Close()
			return err
		}
		n, copyErr := io.Copy(out, io.LimitReader(in, maxOneFile+1))
		closeIn, closeOut := in.Close(), out.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeIn != nil {
			return closeIn
		}
		if closeOut != nil {
			return closeOut
		}
		if n > maxOneFile {
			return fmt.Errorf("插件文件过大")
		}
		written += n
		files++
		if written > maxExtract || files > maxFiles {
			return fmt.Errorf("插件包超过大小或文件数限制")
		}
		return nil
	})
}

func (h *Host) installDeps(ctx context.Context, dir string) error {
	return h.walkDeps(ctx, dir, 0, map[string]int{})
}

func (h *Host) walkDeps(ctx context.Context, dir string, depth int, seen map[string]int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if depth > 6 {
		return nil
	}
	deps := readPkg(dir).Dependencies
	names := make([]string, 0, len(deps))
	for name := range deps {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		spec := strings.TrimSpace(deps[name])
		if unsupportedSpec(spec) {
			return fmt.Errorf("依赖 %s 使用了不支持的版本 %s", name, spec)
		}
		version, tarball, err := h.resolveNPM(ctx, name, spec)
		if err != nil {
			return fmt.Errorf("依赖 %s: %w", name, err)
		}
		key := name + "@" + version
		dest := filepath.Join(dir, "node_modules", filepath.FromSlash(name))
		if _, err := os.Stat(filepath.Join(dest, "package.json")); err == nil {
			continue
		}
		if seen[key] == 0 {
			if len(seen) >= maxDeps {
				return fmt.Errorf("依赖超过 %d 个，请换用已打包、不带深层依赖的插件", maxDeps)
			}
			seen[key] = 1
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := h.extractTarball(ctx, tarball, dest); err != nil {
			return err
		}
		if err := h.walkDeps(ctx, dest, depth+1, seen); err != nil {
			return err
		}
	}
	return nil
}

func unsupportedSpec(spec string) bool {
	s := strings.TrimSpace(spec)
	return strings.Contains(s, "://") || strings.HasPrefix(s, "file:") || strings.HasPrefix(s, "workspace:") || strings.HasPrefix(s, "git+") || strings.HasPrefix(s, "github:") || strings.HasPrefix(s, "http:") || strings.HasPrefix(s, "https:")
}

func (h *Host) resolveNPM(ctx context.Context, name, spec string) (string, string, error) {
	name = strings.TrimSpace(name)
	spec = strings.TrimSpace(spec)
	if !validNPMName(name) {
		return "", "", fmt.Errorf("无效的 npm 包名")
	}
	switch spec {
	case "", "*", "x", "X", "latest":
		return h.fetchVersion(ctx, name, "latest")
	}
	if isExactVersion(spec) {
		return h.fetchVersion(ctx, name, strings.TrimPrefix(spec, "v"))
	}
	if isDistTag(spec) {
		return h.fetchVersion(ctx, name, spec)
	}
	data, err := h.get(ctx, npmURL(name, ""))
	if err != nil {
		return "", "", err
	}
	var doc packument
	if json.Unmarshal(data, &doc) != nil {
		return "", "", fmt.Errorf("无法解析 %s 的版本列表", name)
	}
	versions := make([]string, 0, len(doc.Versions))
	for version := range doc.Versions {
		versions = append(versions, version)
	}
	chosen, err := bestVersion(versions, spec)
	if err != nil {
		return "", "", fmt.Errorf("%s: %w", name, err)
	}
	item := doc.Versions[chosen]
	if item.Dist.Tarball == "" || !allowedTarball(item.Dist.Tarball) {
		return "", "", fmt.Errorf("npm 上没有 %s@%s 的安装包", name, chosen)
	}
	return chosen, item.Dist.Tarball, nil
}

func (h *Host) fetchVersion(ctx context.Context, name, version string) (string, string, error) {
	data, err := h.get(ctx, npmURL(name, version))
	if err != nil {
		return "", "", err
	}
	var doc versionDoc
	if json.Unmarshal(data, &doc) != nil || doc.Dist.Tarball == "" || !allowedTarball(doc.Dist.Tarball) {
		return "", "", fmt.Errorf("npm 上没有 %s@%s", name, version)
	}
	if doc.Version == "" {
		doc.Version = version
	}
	return doc.Version, doc.Dist.Tarball, nil
}

func npmURL(name, version string) string {
	var b strings.Builder
	b.WriteString("https://")
	b.WriteString(registryHost)
	b.WriteByte('/')
	if scope, pkg, ok := strings.Cut(strings.TrimPrefix(name, "@"), "/"); ok && strings.HasPrefix(name, "@") {
		b.WriteByte('@')
		b.WriteString(url.PathEscape(scope))
		b.WriteString("%2F")
		b.WriteString(url.PathEscape(pkg))
	} else {
		b.WriteString(url.PathEscape(name))
	}
	if version != "" {
		b.WriteByte('/')
		b.WriteString(url.PathEscape(version))
	}
	return b.String()
}

func (h *Host) githubTar(ctx context.Context, src origin) ([]byte, error) {
	refs := []string{src.Ref}
	if src.Ref == "" {
		refs = []string{"refs/heads/main", "refs/heads/master"}
	} else if !strings.HasPrefix(src.Ref, "refs/") {
		refs = []string{"refs/heads/" + src.Ref, "refs/tags/" + src.Ref, src.Ref}
	}
	var last error
	for _, ref := range refs {
		rawURL := "https://codeload.github.com/" + url.PathEscape(src.Owner) + "/" + url.PathEscape(src.Repo) + "/tar.gz/" + escapeRef(ref)
		data, err := h.get(ctx, rawURL)
		if err == nil && len(data) > 0 {
			return data, nil
		}
		last = err
	}
	if last == nil {
		last = fmt.Errorf("下载失败")
	}
	return nil, fmt.Errorf("无法下载 %s/%s: %w", src.Owner, src.Repo, last)
}

func escapeRef(ref string) string {
	parts := strings.Split(ref, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return strings.Join(parts, "/")
}

func (h *Host) extractTarball(ctx context.Context, rawURL, dest string) error {
	if h.Fetcher == nil && !allowedTarball(rawURL) {
		return fmt.Errorf("拒绝下载 %s", rawURL)
	}
	data, err := h.get(ctx, rawURL)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	return extractTarGz(data, dest)
}

func allowedTarball(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && allowedHost(u.Hostname())
}

func (h *Host) get(ctx context.Context, rawURL string) ([]byte, error) {
	if h.Fetcher != nil {
		data, err := h.Fetcher(ctx, rawURL)
		if err != nil {
			return nil, err
		}
		if int64(len(data)) > maxDownload {
			return nil, fmt.Errorf("下载超过 32 MiB")
		}
		return data, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || !allowedHost(u.Hostname()) {
		return nil, fmt.Errorf("拒绝下载 %s", rawURL)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "loopra-plugin")
	if strings.HasSuffix(u.Path, ".tgz") || strings.Contains(u.Path, ".tar") {
		req.Header.Set("Accept", "application/octet-stream")
	} else {
		req.Header.Set("Accept", "application/vnd.npm.install-v1+json, application/json")
	}
	client := h.client
	if client == nil {
		client = newClient()
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := readLimited(resp.Body, maxDownload)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载 %s 失败: %s", u.Host, resp.Status)
	}
	return data, nil
}

func readLimited(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("下载超过 %d 字节", limit)
	}
	return data, nil
}

func extractTarGz(data []byte, dest string) error {
	if int64(len(data)) > maxDownload {
		return fmt.Errorf("插件包超过 32 MiB")
	}
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("插件包不是 gzip 压缩的 tar")
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	var written int64
	files := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := path.Clean(hdr.Name)
		if name == "." || name == "" || name == "pax_global_header" {
			continue
		}
		if path.IsAbs(name) || name == ".." || strings.HasPrefix(name, "../") || strings.Contains(hdr.Name, `\`) {
			return fmt.Errorf("插件包路径非法")
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		if !inside(dest, target) {
			return fmt.Errorf("插件包路径非法")
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if hdr.Size > maxOneFile {
				return fmt.Errorf("插件文件过大")
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			n, copyErr := io.Copy(f, io.LimitReader(tr, maxOneFile+1))
			closeErr := f.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			if n > maxOneFile {
				return fmt.Errorf("插件文件过大")
			}
			written += n
			files++
			if written > maxExtract || files > maxFiles {
				return fmt.Errorf("插件包超过大小或文件数限制")
			}
		case tar.TypeXGlobalHeader, tar.TypeXHeader:
			continue
		default:
			continue
		}
	}
	return hoist(dest)
}

func hoist(dest string) error {
	entries, err := os.ReadDir(dest)
	if err != nil || len(entries) != 1 || !entries[0].IsDir() {
		return err
	}
	sub := filepath.Join(dest, entries[0].Name())
	kids, err := os.ReadDir(sub)
	if err != nil {
		return err
	}
	for _, kid := range kids {
		if err := os.Rename(filepath.Join(sub, kid.Name()), filepath.Join(dest, kid.Name())); err != nil {
			return err
		}
	}
	return os.Remove(sub)
}

func focus(dest, sub string) error {
	if strings.TrimSpace(sub) == "" {
		return nil
	}
	sub = filepath.Clean(filepath.FromSlash(sub))
	if sub == "." || sub == ".." || strings.HasPrefix(sub, ".."+string(filepath.Separator)) {
		return fmt.Errorf("子目录非法")
	}
	src := filepath.Join(dest, sub)
	if !inside(dest, src) {
		return fmt.Errorf("子目录非法")
	}
	info, err := os.Stat(src)
	if err != nil || !info.IsDir() {
		return fmt.Errorf("仓库里没有目录 %s", sub)
	}
	tmp := dest + ".focus"
	os.RemoveAll(tmp)
	if err := os.Rename(src, tmp); err != nil {
		return err
	}
	if err := os.RemoveAll(dest); err != nil {
		return err
	}
	return os.Rename(tmp, dest)
}

func readPkg(dir string) pkgFile {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil || len(data) > 1<<20 {
		return pkgFile{}
	}
	var raw struct {
		Name         string            `json:"name"`
		Version      string            `json:"version"`
		Description  string            `json:"description"`
		Module       string            `json:"module"`
		Main         string            `json:"main"`
		Loopra       json.RawMessage   `json:"loopra"`
		Exports      json.RawMessage   `json:"exports"`
		Dependencies map[string]string `json:"dependencies"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return pkgFile{}
	}
	ui := parseLoopraUI(raw.Loopra)
	var capabilities struct {
		Services []string `json:"services"`
	}
	_ = json.Unmarshal(raw.Loopra, &capabilities)
	return pkgFile{
		Name: raw.Name, Version: raw.Version, Description: raw.Description,
		Module: raw.Module, Main: raw.Main, Loopra: loopraPath(raw.Loopra),
		Services: capabilities.Services,
		Settings: ui.Settings, Sidebar: ui.SidebarPage, SidebarTitle: ui.SidebarTitle, SidebarIcon: ui.SidebarIcon,
		Icon: ui.Icon, MenuTitle: ui.MenuTitle, MenuCategory: ui.MenuCategory, MenuIcon: ui.MenuIcon, MenuPage: ui.MenuPage, MenuChildren: ui.Children,
		SkillFile: ui.SkillFile, SubagentName: ui.SubagentName, SubagentDescription: ui.SubagentDescription,
		SubagentFile: ui.SubagentFile, SubagentInstructions: ui.SubagentInstructions, SubagentReadOnly: ui.SubagentReadOnly, SubagentSet: ui.SubagentSet,
		ScheduleName: ui.ScheduleName, ScheduleMessage: ui.ScheduleMessage, ScheduleCron: ui.ScheduleCron, ScheduleInterval: ui.ScheduleInterval,
		DefaultEnabled: ui.DefaultEnabled,
		Exports:        raw.Exports, Dependencies: raw.Dependencies,
	}
}

func loopraPath(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var obj struct {
		Plugin string `json:"plugin"`
		Main   string `json:"main"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		if obj.Plugin != "" {
			return obj.Plugin
		}
		return obj.Main
	}
	return ""
}

type loopraUI struct {
	Settings             string
	SidebarTitle         string
	SidebarPage          string
	SidebarIcon          pkgIcon
	Icon                 pkgIcon
	MenuTitle            string
	MenuCategory         string
	MenuIcon             pkgIcon
	MenuPage             string
	Children             []pkgMenuChild
	SkillFile            string
	SubagentName         string
	SubagentDescription  string
	SubagentFile         string
	SubagentInstructions string
	SubagentReadOnly     bool
	SubagentSet          bool
	ScheduleName         string
	ScheduleMessage      string
	ScheduleCron         string
	ScheduleInterval     int64
	DefaultEnabled       bool
}

func parseLoopraUI(raw json.RawMessage) loopraUI {
	ui := loopraUI{DefaultEnabled: true}
	if len(raw) == 0 || string(raw) == "null" {
		return ui
	}
	var box struct {
		DefaultEnabled *bool           `json:"defaultEnabled"`
		Icon           json.RawMessage `json:"icon"`
		Skill          json.RawMessage `json:"skill"`
		Subagent       json.RawMessage `json:"subagent"`
		Schedule       json.RawMessage `json:"schedule"`
		UI             struct {
			Settings string          `json:"settings"`
			Sidebar  json.RawMessage `json:"sidebar"`
			Menu     json.RawMessage `json:"menu"`
		} `json:"ui"`
	}
	if json.Unmarshal(raw, &box) != nil {
		return ui
	}
	if box.DefaultEnabled != nil {
		ui.DefaultEnabled = *box.DefaultEnabled
	}
	ui.Settings = strings.TrimSpace(box.UI.Settings)
	ui.Icon = parseIcon(box.Icon)
	ui.SidebarTitle, ui.SidebarPage, ui.SidebarIcon = parseSidebar(box.UI.Sidebar)
	ui.MenuTitle, ui.MenuPage, ui.MenuCategory, ui.MenuIcon, ui.Children = parseMenu(box.UI.Menu)
	ui.SkillFile = parseSkill(box.Skill)
	ui.SubagentName, ui.SubagentDescription, ui.SubagentFile, ui.SubagentInstructions, ui.SubagentReadOnly, ui.SubagentSet = parseSubagent(box.Subagent)
	ui.ScheduleName, ui.ScheduleMessage, ui.ScheduleCron, ui.ScheduleInterval = parseSchedule(box.Schedule)
	return ui
}

func parseSkill(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var obj struct {
		File string `json:"file"`
	}
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	return strings.TrimSpace(obj.File)
}

func parseSubagent(raw json.RawMessage) (name, description, file, instructions string, readOnly, ok bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", "", "", "", false, false
	}
	var obj struct {
		Name         string `json:"name"`
		Description  string `json:"description"`
		File         string `json:"file"`
		Instructions string `json:"instructions"`
		ReadOnly     *bool  `json:"readOnly"`
	}
	if json.Unmarshal(raw, &obj) != nil {
		return "", "", "", "", false, false
	}
	if strings.TrimSpace(obj.Name) == "" && strings.TrimSpace(obj.File) == "" && strings.TrimSpace(obj.Instructions) == "" {
		return "", "", "", "", false, false
	}
	readOnly = true
	if obj.ReadOnly != nil {
		readOnly = *obj.ReadOnly
	}
	return strings.TrimSpace(obj.Name), strings.TrimSpace(obj.Description), strings.TrimSpace(obj.File), strings.TrimSpace(obj.Instructions), readOnly, true
}

func parseSchedule(raw json.RawMessage) (name, message, cron string, interval int64) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", "", "", 0
	}
	var obj struct {
		Name        string  `json:"name"`
		Message     string  `json:"message"`
		Cron        string  `json:"cron"`
		IntervalSec float64 `json:"intervalSec"`
	}
	if json.Unmarshal(raw, &obj) != nil {
		return "", "", "", 0
	}
	return strings.TrimSpace(obj.Name), strings.TrimSpace(obj.Message), strings.TrimSpace(obj.Cron), int64(obj.IntervalSec)
}

func parseSidebar(raw json.RawMessage) (title, page string, icon pkgIcon) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", "", pkgIcon{}
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return "", strings.TrimSpace(text), pkgIcon{}
	}
	var obj struct {
		Title string          `json:"title"`
		Page  string          `json:"page"`
		Icon  json.RawMessage `json:"icon"`
	}
	if json.Unmarshal(raw, &obj) != nil {
		return "", "", pkgIcon{}
	}
	return strings.TrimSpace(obj.Title), strings.TrimSpace(obj.Page), parseIcon(obj.Icon)
}

func parseMenu(raw json.RawMessage) (title, page, category string, icon pkgIcon, children []pkgMenuChild) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", "", "", pkgIcon{}, nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return "", strings.TrimSpace(text), "", pkgIcon{}, nil
	}
	var obj struct {
		Title    string          `json:"title"`
		Category string          `json:"category"`
		Icon     json.RawMessage `json:"icon"`
		Page     string          `json:"page"`
		Children []struct {
			ID    string          `json:"id"`
			Title string          `json:"title"`
			Icon  json.RawMessage `json:"icon"`
			Page  string          `json:"page"`
		} `json:"children"`
	}
	if json.Unmarshal(raw, &obj) != nil {
		return "", "", "", pkgIcon{}, nil
	}
	seen := map[string]bool{}
	for i, child := range obj.Children {
		if len(children) >= 12 {
			break
		}
		id := strings.TrimSpace(child.ID)
		if id == "" {
			id = strconv.Itoa(i + 1)
		}
		title := strings.TrimSpace(child.Title)
		page := strings.TrimSpace(child.Page)
		if title == "" || page == "" || !safeID(id) || id == "open" || id == "icons" || seen[id] {
			continue
		}
		seen[id] = true
		children = append(children, pkgMenuChild{ID: id, Title: title, Icon: parseIcon(child.Icon), Page: page})
	}
	return strings.TrimSpace(obj.Title), strings.TrimSpace(obj.Page), clipLabel(obj.Category), parseIcon(obj.Icon), children
}

func parseIcon(raw json.RawMessage) pkgIcon {
	if strings.TrimSpace(string(raw)) == "false" {
		return pkgIcon{Hidden: true}
	}
	if len(raw) == 0 || string(raw) == "null" {
		return pkgIcon{}
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return pkgIcon{}
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return pkgIcon{}
	}
	if strings.ContainsAny(text, `/\`) || strings.HasPrefix(text, ".") {
		return pkgIcon{File: text}
	}
	if validIconName(text) {
		return pkgIcon{Name: text}
	}
	return pkgIcon{}
}

func validIconName(name string) bool {
	if name == "" || len(name) > 40 || name[0] == '-' || name[len(name)-1] == '-' {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
		default:
			return false
		}
	}
	return true
}

func exportDot(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var obj map[string]json.RawMessage
	if json.Unmarshal(raw, &obj) != nil {
		return ""
	}
	if dot, ok := obj["."]; ok {
		return exportTarget(dot, 0)
	}
	return ""
}

func exportTarget(raw json.RawMessage, depth int) string {
	if depth > 6 || len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var cond map[string]json.RawMessage
	if json.Unmarshal(raw, &cond) != nil {
		return ""
	}
	for _, key := range []string{"import", "default", "module", "require", "node"} {
		if value, ok := cond[key]; ok {
			if target := exportTarget(value, depth+1); target != "" {
				return target
			}
		}
	}
	return ""
}

func isExactVersion(spec string) bool {
	s := strings.TrimPrefix(strings.TrimSpace(spec), "v")
	if s == "" || strings.ContainsAny(s, "^~><=* xX|") {
		return false
	}
	base := s
	if i := strings.IndexAny(base, "-+"); i >= 0 {
		base = base[:i]
	}
	_, _, ok := parseVer(base)
	return ok
}

func isDistTag(spec string) bool {
	if spec == "" || spec[0] < 'A' || (spec[0] > 'Z' && spec[0] < 'a') || spec[0] > 'z' {
		return false
	}
	for _, r := range spec {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

func parseVer(s string) (semver, int, bool) {
	s = strings.TrimSpace(strings.TrimPrefix(s, "v"))
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return semver{}, 0, false
	}
	parts := strings.Split(s, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return semver{}, 0, false
	}
	var n [3]int
	for i, part := range parts {
		if part == "" {
			return semver{}, 0, false
		}
		v, err := strconv.Atoi(part)
		if err != nil || v < 0 {
			return semver{}, 0, false
		}
		n[i] = v
	}
	return semver{n[0], n[1], n[2]}, len(parts), true
}

func lessVer(a, b semver) bool {
	if a.major != b.major {
		return a.major < b.major
	}
	if a.minor != b.minor {
		return a.minor < b.minor
	}
	return a.patch < b.patch
}

func matchSpec(v semver, spec string) bool {
	spec = strings.TrimSpace(spec)
	if spec == "" || spec == "*" || spec == "x" || spec == "X" {
		return true
	}
	op, rest := "=", spec
	switch {
	case strings.HasPrefix(spec, ">="):
		op, rest = ">=", spec[2:]
	case strings.HasPrefix(spec, ">"):
		op, rest = ">", spec[1:]
	case strings.HasPrefix(spec, "^"):
		op, rest = "^", spec[1:]
	case strings.HasPrefix(spec, "~"):
		op, rest = "~", spec[1:]
	case strings.HasPrefix(spec, "="):
		op, rest = "=", spec[1:]
	}
	base, parts, ok := parseVer(rest)
	if !ok {
		return false
	}
	switch op {
	case "=":
		return v == base
	case ">=":
		return !lessVer(v, base)
	case ">":
		return lessVer(base, v)
	case "^":
		if lessVer(v, base) {
			return false
		}
		switch {
		case base.major > 0 || parts <= 1:
			return v.major == base.major
		case base.minor > 0 || parts <= 2:
			return v.major == 0 && v.minor == base.minor
		default:
			return v.major == 0 && v.minor == 0 && v.patch == base.patch
		}
	case "~":
		if lessVer(v, base) {
			return false
		}
		if parts <= 1 {
			return v.major == base.major
		}
		return v.major == base.major && v.minor == base.minor
	default:
		return false
	}
}

func bestVersion(versions []string, spec string) (string, error) {
	spec = strings.TrimSpace(spec)
	if cut, _, ok := strings.Cut(spec, "||"); ok {
		spec = strings.TrimSpace(cut)
	}
	var best string
	var bestV semver
	for _, raw := range versions {
		if strings.Contains(raw, "-") && !strings.Contains(spec, "-") {
			continue
		}
		v, _, ok := parseVer(raw)
		if !ok || !matchSpec(v, spec) {
			continue
		}
		if best == "" || lessVer(bestV, v) {
			best, bestV = raw, v
		}
	}
	if best == "" {
		return "", fmt.Errorf("没有满足 %s 的版本", spec)
	}
	return best, nil
}
