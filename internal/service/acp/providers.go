package acp

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/BurntSushi/toml"
)

// Availability 描述某个外部 Agent 是否可用于当前机器。
type Availability struct {
	Available bool
	Detail    string
}

// Launch 是启动一个 ACP Agent 所需的命令与环境变量增量。
type Launch struct {
	Command []string
	Env     map[string]string
}

// Provider 是一个外部 ACP Agent 的发现与启动规则。
type Provider struct {
	ID      string
	Name    string
	Detect  func() Availability
	Prepare func(cwd string) (Launch, error)
	// Credential 返回要放进 authenticate _meta 的本机凭据；
	// 为 nil 或返回 nil 表示没有可复用的登录态（Devin ACP 不直接
	// 读 CLI 凭据，但接受把同一个 api_key 显式传回）。
	Credential func() map[string]any
}

// Providers 按 Java 运行时顺序列出全部外部 Agent。
var Providers = []Provider{
	{ID: "claude-code", Name: "Claude Code", Detect: detectClaude, Prepare: prepareClaude},
	{ID: "codex", Name: "Codex", Detect: detectCodex, Prepare: prepareCodex},
	{ID: "devin", Name: "Devin", Detect: detectDevin, Prepare: prepareDevin, Credential: devinCredential},
}

// Lookup 按 id 查找外部 Agent。
func Lookup(id string) (Provider, bool) {
	for _, provider := range Providers {
		if provider.ID == id {
			return provider, true
		}
	}
	return Provider{}, false
}

// IsExternal 报告 id 是否代表一个外部 Agent；未知 id 返回 false。
func IsExternal(id string) bool {
	if id == "" || id == "native" {
		return false
	}
	_, ok := Lookup(id)
	return ok
}

// ---- 路径发现 ----

func windows() bool { return runtime.GOOS == "windows" }

func envValue(name string) string {
	if !windows() {
		return os.Getenv(name)
	}
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok && strings.EqualFold(key, name) {
			return value
		}
	}
	return ""
}

// searchRoots 复刻 Java AcpRuntimePaths.searchRoots 的搜索顺序。
func searchRoots() []string {
	var roots []string
	add := func(path string) {
		path = strings.TrimSpace(path)
		if path == "" {
			return
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			return
		}
		roots = append(roots, abs)
	}
	add(envValue("NVM_BIN"))
	add(envValue("NVM_SYMLINK"))
	add(envValue("NODE_HOME"))
	for _, part := range strings.Split(envValue("PATH"), string(os.PathListSeparator)) {
		add(part)
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".local", "bin"))
		add(filepath.Join(home, ".npm-global", "bin"))
		add(filepath.Join(home, ".nvm", "current", "bin"))
	}
	if prefix := envValue("NPM_CONFIG_PREFIX"); prefix != "" {
		before := len(roots)
		add(prefix)
		if len(roots) > before {
			add(filepath.Join(roots[len(roots)-1], "bin"))
		}
	}
	if !windows() {
		for _, root := range []string{"/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"} {
			add(root)
		}
	}
	if appData := envValue("APPDATA"); appData != "" {
		add(filepath.Join(appData, "npm"))
	}
	if programFiles := envValue("ProgramFiles"); programFiles != "" {
		add(filepath.Join(programFiles, "nodejs"))
	}
	return roots
}

func regularFile(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func isScript(path string) bool {
	lower := strings.ToLower(path)
	for _, suffix := range []string{".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}

// executable 判断路径是否可作为本机 CLI 使用。
func executable(path string) string {
	if !regularFile(path) {
		return ""
	}
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	if windows() || isScript(path) || info.Mode()&0o111 != 0 {
		abs, err := filepath.Abs(path)
		if err != nil {
			return path
		}
		return abs
	}
	return ""
}

// findNode 解析 node 可执行文件。
func findNode(roots []string) string {
	if override := envValue("LOOPRA_NODE_EXECUTABLE"); override != "" && regularFile(override) {
		return override
	}
	name := "node"
	if windows() {
		name = "node.exe"
	}
	for _, root := range roots {
		if found := executable(filepath.Join(root, name)); found != "" {
			return found
		}
	}
	return ""
}

// findAdapter 在全局 node_modules 中定位适配器入口。
func findAdapter(roots []string, override string, packages ...string) string {
	if override != "" {
		if regularFile(override) {
			return override
		}
		return ""
	}
	home, _ := os.UserHomeDir()
	candidates := append([]string(nil), roots...)
	candidates = append(candidates, filepath.Join(home, ".npm-global", "lib"))
	for _, root := range candidates {
		for _, base := range []string{root, filepath.Clean(filepath.Join(root, "..", "lib"))} {
			for _, pkg := range packages {
				script := filepath.Join(base, "node_modules", filepath.FromSlash(pkg), "dist", "index.js")
				if regularFile(script) {
					abs, _ := filepath.Abs(script)
					return abs
				}
			}
		}
	}
	return ""
}

// findClaude 定位 Claude Code CLI（原生可执行文件或 npm 包声明）。
func findClaude(roots []string) string {
	if override := envValue("CLAUDE_CODE_EXECUTABLE"); override != "" {
		// npm 的 Windows shim（claude.cmd/.ps1/.bat）不是可执行文件，
		// 需要解析包内真实入口（Java ClaudeAcpProcess.npmClaudeExecutable）。
		if windows() && windowsShim(override) {
			if found := claudePackageEntry(filepath.Dir(override)); found != "" {
				return found
			}
			// 非 npm 包布局（自定义 shim/脚本）仍按原样使用。
		}
		if found := executable(override); found != "" {
			return found
		}
		return ""
	}
	for _, root := range roots {
		name := "claude"
		if windows() {
			name = "claude.exe"
		}
		if found := executable(filepath.Join(root, name)); found != "" {
			return found
		}
		if found := claudePackageEntry(root); found != "" {
			return found
		}
	}
	return ""
}

// windowsShim 报告路径是否是 npm 在 Windows 上生成的启动垫片。
func windowsShim(path string) bool {
	name := strings.ToLower(filepath.Base(path))
	return strings.HasSuffix(name, ".cmd") || strings.HasSuffix(name, ".ps1") ||
		strings.HasSuffix(name, ".bat") || name == "claude"
}

// claudePackageEntry 从安装前缀（以及 ../lib）解析 @anthropic-ai/claude-code
// package.json 的 bin 入口。
func claudePackageEntry(prefix string) string {
	for _, base := range []string{prefix, filepath.Clean(filepath.Join(prefix, "..", "lib"))} {
		pkg := filepath.Join(base, "node_modules", "@anthropic-ai", "claude-code")
		manifest, err := os.ReadFile(filepath.Join(pkg, "package.json"))
		if err != nil {
			continue
		}
		var meta struct {
			Bin any `json:"bin"`
		}
		if json.Unmarshal(manifest, &meta) != nil {
			continue
		}
		entry := ""
		switch value := meta.Bin.(type) {
		case string:
			entry = value
		case map[string]any:
			if text, ok := value["claude"].(string); ok {
				entry = text
			}
		}
		if entry == "" {
			continue
		}
		if found := executable(filepath.Join(pkg, filepath.FromSlash(entry))); found != "" {
			return found
		}
	}
	return ""
}

// ---- 按提供方组装 ----

type installation struct {
	node    string
	adapter string
	extra   string
}

func (i installation) available() bool { return i.node != "" && i.adapter != "" }

// withNodeRoots 把 Node 安装前缀（含 realpath）加入搜索根，
// 使仅通过 LOOPRA_NODE_EXECUTABLE 指定的全局包也能被找到
// （Java AcpRuntimePaths 在解析出 node 后扩根）。
func withNodeRoots(roots []string, node string) []string {
	if node == "" {
		return roots
	}
	dir := filepath.Dir(node)
	extra := []string{dir}
	if real, err := filepath.EvalSymlinks(dir); err == nil && real != dir {
		extra = append(extra, real)
	}
	return append(extra, roots...)
}

// claudeInstall 解析 Node、ACP 适配器与 Claude CLI。
func claudeInstall() installation {
	roots := searchRoots()
	node := findNode(roots)
	roots = withNodeRoots(roots, node)
	return installation{
		node:    node,
		adapter: findAdapter(roots, envValue("LOOPRA_CLAUDE_ACP_SCRIPT"), "@agentclientprotocol/claude-agent-acp", "@zed-industries/claude-agent-acp"),
		extra:   findClaude(roots),
	}
}

func detectClaude() Availability {
	install := claudeInstall()
	switch {
	case install.node == "":
		return Availability{Detail: "后端未找到 Node.js，请检查后端进程的 Path 或 NVM_SYMLINK"}
	case install.extra == "":
		return Availability{Detail: "后端未找到 Claude Code，可用 CLAUDE_CODE_EXECUTABLE 指定路径"}
	case install.adapter == "":
		return Availability{Detail: "未找到 ACP 适配器，请安装 @agentclientprotocol/claude-agent-acp"}
	}
	return Availability{Available: true, Detail: "使用本机 Claude 登录和配置"}
}

func prepareClaude(cwd string) (Launch, error) {
	install := claudeInstall()
	if !install.available() || install.extra == "" {
		return Launch{}, fmt.Errorf("Claude Code ACP 不可用: %s", detectClaude().Detail)
	}
	env := map[string]string{"CLAUDE_CODE_EXECUTABLE": install.extra}
	env["PATH"] = prependPath(install.node, install.extra)
	return Launch{Command: []string{install.node, install.adapter}, Env: env}, nil
}

func detectCodex() Availability {
	roots := searchRoots()
	node := findNode(roots)
	roots = withNodeRoots(roots, node)
	install := installation{node: node, adapter: findAdapter(roots, envValue("LOOPRA_CODEX_ACP_SCRIPT"), "@agentclientprotocol/codex-acp")}
	switch {
	case install.node == "":
		return Availability{Detail: "后端未找到 Node.js，请检查后端进程的 Path 或 NVM_SYMLINK"}
	case install.adapter == "":
		return Availability{Detail: "未找到 Codex ACP 适配器，请安装 @agentclientprotocol/codex-acp"}
	}
	return Availability{Available: true, Detail: "使用本机 Codex 登录和配置"}
}

func prepareCodex(cwd string) (Launch, error) {
	roots := searchRoots()
	node := findNode(roots)
	roots = withNodeRoots(roots, node)
	install := installation{node: node, adapter: findAdapter(roots, envValue("LOOPRA_CODEX_ACP_SCRIPT"), "@agentclientprotocol/codex-acp")}
	if !install.available() {
		return Launch{}, fmt.Errorf("Codex ACP 不可用: %s", detectCodex().Detail)
	}
	return Launch{Command: []string{install.node, install.adapter}, Env: map[string]string{"PATH": prependPath(install.node)}}, nil
}

// findDevin 定位 Devin CLI：它是原生二进制，`devin acp` 即 ACP 服务，
// 不需要 Node 适配器。独立安装默认进 ~/.local/bin（已被 searchRoots
// 覆盖）；macOS 上 Devin.app 也带一份，作为兜底候选。
func findDevin(roots []string) string {
	if override := envValue("LOOPRA_DEVIN_EXECUTABLE"); override != "" {
		return executable(override)
	}
	names := []string{"devin"}
	if windows() {
		names = []string{"devin.exe", "devin.cmd", "devin.bat"}
	}
	for _, root := range roots {
		for _, name := range names {
			if found := executable(filepath.Join(root, name)); found != "" {
				return found
			}
		}
	}
	if windows() {
		// Windows 安装器把 devin.exe 复制到 %LOCALAPPDATA%\devin\cli\bin。
		if local := envValue("LOCALAPPDATA"); local != "" {
			if found := executable(filepath.Join(local, "devin", "cli", "bin", "devin.exe")); found != "" {
				return found
			}
		}
	}
	if runtime.GOOS == "darwin" {
		apps := []string{"/Applications/Devin.app"}
		if home, err := os.UserHomeDir(); err == nil {
			apps = append(apps, filepath.Join(home, "Applications", "Devin.app"))
		}
		for _, app := range apps {
			if found := executable(filepath.Join(app, "Contents/Resources/app/extensions/windsurf/devin/bin/devin")); found != "" {
				return found
			}
		}
	}
	return ""
}

func detectDevin() Availability {
	if findDevin(searchRoots()) == "" {
		return Availability{Detail: "后端未找到 Devin CLI，请安装 devin 或用 LOOPRA_DEVIN_EXECUTABLE 指定路径"}
	}
	return Availability{Available: true, Detail: "使用本机 Devin 登录和配置（devin auth login）"}
}

func prepareDevin(cwd string) (Launch, error) {
	binary := findDevin(searchRoots())
	if binary == "" {
		return Launch{}, fmt.Errorf("Devin ACP 不可用: %s", detectDevin().Detail)
	}
	return Launch{Command: []string{binary, "acp"}, Env: map[string]string{"PATH": prependPath(binary)}}, nil
}

// devinCredential 复用终端登录态：`devin auth login` 把
// windsurf_api_key 存在 credentials.toml；`devin acp` 要求宿主
// 显式 authenticate，把同一把 key 作为 _meta.api_key 传回即可，
// WINDSURF_API_KEY 环境变量优先。
func devinCredential() map[string]any {
	key := envValue("WINDSURF_API_KEY")
	if key == "" {
		key = devinAPIKey()
	}
	if key == "" {
		return nil
	}
	return map[string]any{"api_key": key}
}

func devinAPIKey() string {
	var dirs []string
	if data := envValue("XDG_DATA_HOME"); data != "" {
		dirs = append(dirs, filepath.Join(data, "devin"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".local", "share", "devin"))
	}
	// Windows 的 devin 数据目录同样可能是 Roaming 或 Local。
	for _, name := range []string{"APPDATA", "LOCALAPPDATA"} {
		if dir := envValue(name); dir != "" {
			dirs = append(dirs, filepath.Join(dir, "devin"))
		}
	}
	for _, dir := range dirs {
		var parsed struct {
			Key string `toml:"windsurf_api_key"`
		}
		if _, err := toml.DecodeFile(filepath.Join(dir, "credentials.toml"), &parsed); err == nil && parsed.Key != "" {
			return parsed.Key
		}
	}
	return ""
}

// prependPath 把给定可执行文件所在目录放到 PATH 前面。
func prependPath(executables ...string) string {
	path := envValue("PATH")
	var dirs []string
	seen := map[string]bool{}
	for _, executable := range executables {
		if executable == "" {
			continue
		}
		dir := filepath.Dir(executable)
		key := strings.ToLower(dir)
		if windows() {
			key = strings.ToLower(strings.ReplaceAll(dir, "/", "\\"))
		}
		if !seen[key] {
			seen[key] = true
			dirs = append(dirs, dir)
		}
	}
	if path != "" {
		dirs = append(dirs, path)
	}
	return strings.Join(dirs, string(os.PathListSeparator))
}
