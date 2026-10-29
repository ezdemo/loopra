// Package config 解析进程级配置；持久化的业务配置仍位于 model/config。
//
// 配置来源与 Spring Boot 一致，按优先级从高到低合并：
//
//	命令行/Options > 环境变量 > manifest/config/config.yaml > 内置默认值
//
// config.yaml 使用 GoFrame 的 gcfg 读取，因此也支持 .yml/.yaml/.toml/.json
// 等 GoFrame 原生格式。示例见仓库根目录的 manifest/config/config.yaml。
package config

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gogf/gf/v2/errors/gcode"
	"github.com/gogf/gf/v2/errors/gerror"
	"github.com/gogf/gf/v2/os/gcfg"
	"github.com/gogf/gf/v2/os/gfile"
	"github.com/gogf/gf/v2/util/gconv"
)

// DefaultConfigPath 是 Spring Boot application.yml 的等价位置。
const DefaultConfigPath = "manifest/config/config.yaml"

type Options struct {
	Home            string
	Port            string
	AccessKey       string
	StaticDir       string
	PetsDir         string
	ConfigFile      string
	ShutdownTimeout time.Duration
	// OnListen 在 HTTP 监听成功后调用，供桌面窗口打开工作台。
	OnListen func(baseURL, accessKey string)
}

type Server struct {
	Home              string
	Address           string
	Port              int
	AccessKey         string
	StaticDir         string
	StaticLabel       string // 日志用的前端来源；embedded 表示二进制内嵌页面
	PetsDir           string
	OnListen          func(baseURL, accessKey string)
	ShutdownTimeout   time.Duration
	ReadHeaderTimeout time.Duration
	IdleTimeout       time.Duration
	ClientMaxBodySize int
}

// Load 读取配置文件并合并显式参数与环境变量。
func Load(ctx context.Context, options Options) (*Server, error) {
	settings := &Server{
		ShutdownTimeout:   10 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ClientMaxBodySize: 0,
	}

	explicitConfig := firstNonEmpty(options.ConfigFile, os.Getenv("LOOPRA_CONFIG"))
	configPath := explicitConfig
	if configPath == "" {
		configPath = DefaultConfigPath
	}
	if !filepath.IsAbs(configPath) {
		if abs, err := filepath.Abs(configPath); err == nil {
			configPath = abs
		}
	}
	var cfg *gcfg.Config
	switch {
	case gfile.Exists(configPath) && !gfile.IsDir(configPath):
		adapter, err := gcfg.NewAdapterFile(configPath)
		if err != nil {
			return nil, fmt.Errorf("load configuration %s: %w", configPath, err)
		}
		cfg = gcfg.NewWithAdapter(adapter)
	case explicitConfig != "":
		// 显式指定的配置来源缺失必须报错，避免静默使用默认值启动。
		return nil, fmt.Errorf("configuration file %s does not exist", configPath)
	}

	var configErr error
	get := func(key string) string {
		if cfg == nil || configErr != nil {
			return ""
		}
		value, err := cfg.Get(ctx, key)
		if err != nil && gerror.Code(err) != gcode.CodeNotFound {
			configErr = fmt.Errorf("read %s: %w", key, err)
			return ""
		}
		if value == nil || value.IsEmpty() {
			return ""
		}
		return strings.TrimSpace(value.String())
	}
	getDuration := func(key string, fallback time.Duration) time.Duration {
		raw := get(key)
		if raw == "" {
			return fallback
		}
		return gconv.Duration(raw)
	}
	getInt := func(key string, fallback int) int {
		raw := get(key)
		if raw == "" {
			return fallback
		}
		return gconv.Int(raw)
	}

	settings.Address = firstNonEmpty(get("server.address"), "127.0.0.1")
	settings.ShutdownTimeout = pickDuration(options.ShutdownTimeout,
		getDuration("server.shutdownTimeout", settings.ShutdownTimeout))
	settings.ReadHeaderTimeout = getDuration("server.readHeaderTimeout", settings.ReadHeaderTimeout)
	settings.IdleTimeout = getDuration("server.idleTimeout", settings.IdleTimeout)
	settings.ClientMaxBodySize = getInt("server.clientMaxBodySize", settings.ClientMaxBodySize)

	home := firstNonEmpty(options.Home, os.Getenv("LOOPRA_HOME"), get("loopra.home"))
	if home == "" {
		user, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("resolve home directory: %w", err)
		}
		home = filepath.Join(user, ".loopra")
	}
	absoluteHome, err := filepath.Abs(home)
	if err != nil {
		return nil, fmt.Errorf("resolve application home: %w", err)
	}
	settings.Home = absoluteHome

	// 0 表示不指定端口：net.Listen 会向系统申请一个空闲端口。
	// 实际端口以监听成功后的 listener.Addr() 为准。
	port := firstNonEmpty(options.Port, os.Getenv("LOOPRA_PORT"), get("server.port"))
	if port == "" {
		port = "0"
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 0 || number > 65535 {
		return nil, fmt.Errorf("invalid HTTP port %q", port)
	}
	settings.Port = number
	settings.Address = net.JoinHostPort(settings.Address, strconv.Itoa(number))

	settings.AccessKey = firstNonEmpty(options.AccessKey, os.Getenv("LOOPRA_ACCESS_KEY"), get("loopra.accessKey"))
	settings.StaticDir = firstNonEmpty(options.StaticDir, os.Getenv("LOOPRA_STATIC_DIR"), get("loopra.staticDir"))
	settings.OnListen = options.OnListen
	settings.PetsDir = firstNonEmpty(options.PetsDir, os.Getenv("LOOPRA_PETS_DIR"), get("loopra.petsDir"))
	if configErr != nil {
		return nil, configErr
	}
	return settings, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func pickDuration(explicit, configured time.Duration) time.Duration {
	if explicit > 0 {
		return explicit
	}
	return configured
}
