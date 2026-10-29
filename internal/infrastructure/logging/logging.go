// Package logging 提供 Spring Boot 风格的控制台日志。
//
// 一行里按字段上色：时间（暗）、级别（绿/黄/红）、进程号（品红）、
// 分隔符和线程（暗）、标签（青），后面跟源码行号和正文。
// 默认只输出 Info 及以上；LOOPRA_DEBUG=1（或 true/debug）额外输出调试细节。
// 颜色默认打开，IDE 的运行窗口不是终端也会上色。
// NO_COLOR、TERM=dumb、FORCE_COLOR=0 或 CLICOLOR=0 关闭颜色。
package logging

import (
	"context"
	"io"
	"log"
	"log/slog"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gogf/gf/v2/os/glog"
)

const (
	ansiReset   = "\x1b[0m"
	ansiFaint   = "\x1b[2m"
	ansiRed     = "\x1b[91m"
	ansiGreen   = "\x1b[92m"
	ansiYellow  = "\x1b[93m"
	ansiMagenta = "\x1b[95m"
	ansiCyan    = "\x1b[96m"

	// 级别保持 5 列，和 Java 的 INFO/WARN/ERROR 对齐。
	// 标签只补到 6 列：现有标签都不超过这个长度，多出来的空格会把正文推得很远。
	levelWidth  = 5
	loggerWidth = 6
	lineWidth   = 4
)

type callSiteKey struct{}

var (
	once       sync.Once
	verbose    bool
	colors     bool
	instance   *glog.Logger
	processPID = os.Getpid()
	// tagFilter 非空时只输出这些标签。nil 表示全部输出。
	tagFilter  map[string]struct{}
	silenced   bool
	suppressed bool
	lineOut    io.Writer = os.Stdout
)

func initialize() {
	colors = detectColor()
	if colors {
		enableVirtualTerminal()
	}
	verbose = debugFromEnv()
	// 包级 glog 只留给 GoFrame 自己的失败信息，避免「openapi 已关闭」
	// 「pid: all servers shutdown」这类说明刷进控制台。
	// SetLevel 会保留 Fatal；SetLevelStr("ERRO") 不会，启动失败会变成无声退出。
	glog.SetLevel(glog.LEVEL_ERRO)
	glog.SetStack(false)

	instance = glog.New()
	instance.SetStdoutPrint(true)
	instance.SetHeaderPrint(false)
	instance.SetFlags(0)
	instance.SetStack(false)
	instance.SetHandlers(render)
	level := "INFO"
	if verbose {
		level = "DEBUG"
	}
	_ = instance.SetLevelStr(level)
}

func logger() *glog.Logger {
	once.Do(initialize)
	return instance
}

// UseWriter 把本包和 GoFrame 默认日志改写到 w，并关闭 stdout。
// `looprax acp` 必须这样，避免日志混进协议输出。
func UseWriter(w io.Writer) {
	logger()
	instance.SetStdoutPrint(false)
	instance.SetWriter(w)
	glog.SetStdoutPrint(false)
	glog.SetWriter(w)
}

// Silence 丢掉后续控制台日志。桌面端没有终端，启动地址和对话记录都不往控制台写。
func Silence() {
	logger()
	silenced = true
	instance.SetStdoutPrint(false)
	instance.SetWriter(io.Discard)
	glog.SetStdoutPrint(false)
	glog.SetWriter(io.Discard)
	suppressed = true
	DiscardLibraries()
}

// Suppress 丢掉结构化日志，但保留 PrintLine。
// `looprax` 默认只打访问地址；LOOPRA_DEBUG=1 时不要调用。
func Suppress() {
	logger()
	tagFilter = map[string]struct{}{}
	instance.SetStdoutPrint(false)
	instance.SetWriter(io.Discard)
	glog.SetStdoutPrint(false)
	glog.SetWriter(io.Discard)
	suppressed = true
	DiscardLibraries()
}

// DiscardLibraries 丢掉标准库 log 和 slog 的默认输出。
// ACP SDK 未设置 logger 时会走 slog.Default()，连接断开会打出
// "connection closed"。
func DiscardLibraries() {
	log.SetOutput(io.Discard)
	slog.SetDefault(slog.New(slog.DiscardHandler))
}

// LibraryLogger 给会自己打 slog 的库用。调试关闭时丢掉连接关闭这类诊断。
func LibraryLogger() *slog.Logger {
	once.Do(initialize)
	if verbose {
		return slog.Default()
	}
	return slog.New(slog.DiscardHandler)
}

// PrintLine 写一行原文，不套启动日志的时间、级别和标签。Silence 之后不再输出。
func PrintLine(text string) {
	logger()
	if silenced {
		return
	}
	_, _ = io.WriteString(lineOut, text+"\n")
}

// OnlyTags 只保留列出的标签。looprax acp 用它把对话、HTTP 和配置日志留在进程里，
// 标准错误只看见 ACP 本身。
func OnlyTags(tags ...string) {
	logger()
	filter := make(map[string]struct{}, len(tags))
	for _, tag := range tags {
		filter[tag] = struct{}{}
	}
	tagFilter = filter
}

func allows(tag string) bool {
	if tagFilter == nil {
		return true
	}
	_, ok := tagFilter[tag]
	return ok
}

// QuietLogger 把 GoFrame 服务器自带的说明压到错误级别。
// 启动时那句 openapi specification is disabled 不再出现；真正的 Fatal 仍会打出。
func QuietLogger(logger *glog.Logger) {
	if logger == nil {
		return
	}
	logger.SetLevel(glog.LEVEL_ERRO)
	logger.SetStack(false)
	if suppressed {
		logger.SetStdoutPrint(false)
		logger.SetWriter(io.Discard)
	}
}

// DebugEnabled 报告调试日志是否开启。
func DebugEnabled() bool {
	once.Do(initialize)
	return verbose
}

// Infof 输出一条信息日志。
func Infof(tag, format string, args ...any) {
	if !allows(tag) {
		return
	}
	logger().Infof(callContext(), "["+tag+"] "+format, args...)
}

// Warnf 输出一条警告日志。
func Warnf(tag, format string, args ...any) {
	if !allows(tag) {
		return
	}
	logger().Warningf(callContext(), "["+tag+"] "+format, args...)
}

// Debugf 仅在 LOOPRA_DEBUG 开启时输出。
func Debugf(tag, format string, args ...any) {
	if !DebugEnabled() || !allows(tag) {
		return
	}
	logger().Debugf(callContext(), "["+tag+"] "+format, args...)
}

// Errorf 输出一条错误日志。
func Errorf(tag, format string, args ...any) {
	if !allows(tag) {
		return
	}
	logger().Errorf(callContext(), "["+tag+"] "+format, args...)
}

// user -> Infof/Warnf/Debugf/Errorf -> callContext -> callLine。
const callSiteSkip = 3

func callContext() context.Context {
	return context.WithValue(context.Background(), callSiteKey{}, callLine(callSiteSkip))
}

// callLine 返回向上第 skip 层调用方的源码行号。skip 为 1 时是直接调用者。
func callLine(skip int) int {
	_, _, line, ok := runtime.Caller(skip)
	if !ok {
		return 0
	}
	return line
}

func render(ctx context.Context, in *glog.HandlerInput) {
	tag, text := splitTag(strings.TrimRight(in.ValuesContent(), "\r\n"))
	line, _ := ctx.Value(callSiteKey{}).(int)
	in.Buffer.WriteString(formatLine(in.Time, in.Level, processPID, line, threadName(), tag, text, colors))
	in.Buffer.WriteByte('\n')
	in.Next(ctx)
}

func debugFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("LOOPRA_DEBUG"))) {
	case "", "0", "false", "off", "no":
		return false
	default:
		return true
	}
}

func detectColor() bool {
	if os.Getenv("NO_COLOR") != "" || strings.EqualFold(os.Getenv("TERM"), "dumb") {
		return false
	}
	if os.Getenv("FORCE_COLOR") == "0" || os.Getenv("CLICOLOR") == "0" {
		return false
	}
	return true
}

// formatLine 排成 Spring Boot 控制台那一行：
// 时间 级别 进程号 --- [线程] 标签 行号 : 正文
func formatLine(now time.Time, level, pid, line int, thread, loggerName, text string, colored bool) string {
	var b strings.Builder
	b.Grow(128 + len(text))
	writePaint(&b, ansiFaint, now.Format("2006-01-02 15:04:05.000"), colored)
	b.WriteByte(' ')
	writePaint(&b, levelANSI(level), fitWidth(levelLabel(level), levelWidth, true), colored)
	b.WriteByte(' ')
	writePaint(&b, ansiMagenta, strconv.Itoa(pid), colored)
	b.WriteByte(' ')
	writePaint(&b, ansiFaint, "---", colored)
	b.WriteByte(' ')
	writePaint(&b, ansiFaint, "["+thread+"]", colored)
	b.WriteByte(' ')
	writePaint(&b, ansiCyan, padRight(loggerName, loggerWidth), colored)
	b.WriteByte(' ')
	b.WriteString(padLeft(lineText(line), lineWidth))
	b.WriteByte(' ')
	writePaint(&b, ansiFaint, ":", colored)
	b.WriteByte(' ')
	b.WriteString(text)
	return b.String()
}

func lineText(line int) string {
	if line <= 0 {
		return ""
	}
	return strconv.Itoa(line)
}

func splitTag(content string) (tag, text string) {
	if !strings.HasPrefix(content, "[") {
		return "", content
	}
	end := strings.IndexByte(content, ']')
	if end <= 1 || end+1 >= len(content) || content[end+1] != ' ' {
		return "", content
	}
	return content[1:end], content[end+2:]
}

func levelLabel(level int) string {
	switch level {
	case glog.LEVEL_DEBU:
		return "DEBUG"
	case glog.LEVEL_WARN, glog.LEVEL_NOTI:
		return "WARN"
	case glog.LEVEL_ERRO:
		return "ERROR"
	case glog.LEVEL_CRIT, glog.LEVEL_PANI, glog.LEVEL_FATA:
		return "FATAL"
	default:
		return "INFO"
	}
}

func levelANSI(level int) string {
	switch level {
	case glog.LEVEL_WARN, glog.LEVEL_NOTI:
		return ansiYellow
	case glog.LEVEL_ERRO, glog.LEVEL_CRIT, glog.LEVEL_PANI, glog.LEVEL_FATA:
		return ansiRed
	default:
		return ansiGreen
	}
}

func writePaint(b *strings.Builder, code, text string, colored bool) {
	if !colored || text == "" || code == "" {
		b.WriteString(text)
		return
	}
	b.WriteString(code)
	b.WriteString(text)
	b.WriteString(ansiReset)
}

func padRight(s string, width int) string {
	n := utf8.RuneCountInString(s)
	if n >= width {
		return s
	}
	return s + strings.Repeat(" ", width-n)
}

func padLeft(s string, width int) string {
	n := utf8.RuneCountInString(s)
	if n >= width {
		return s
	}
	return strings.Repeat(" ", width-n) + s
}

func fitWidth(s string, width int, alignRight bool) string {
	n := utf8.RuneCountInString(s)
	if n > width {
		s = string([]rune(s)[:width])
		n = width
	}
	if n == width {
		return s
	}
	pad := strings.Repeat(" ", width-n)
	if alignRight {
		return pad + s
	}
	return s + pad
}

func threadName() string {
	id := currentGID()
	if id <= 1 {
		return "main"
	}
	return "g" + strconv.FormatUint(id, 10)
}

func currentGID() uint64 {
	var buf [64]byte
	n := runtime.Stack(buf[:], false)
	const prefix = "goroutine "
	if n <= len(prefix) || string(buf[:len(prefix)]) != prefix {
		return 0
	}
	var id uint64
	for i := len(prefix); i < n; i++ {
		c := buf[i]
		if c < '0' || c > '9' {
			break
		}
		id = id*10 + uint64(c-'0')
	}
	return id
}
