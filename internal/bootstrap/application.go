// Package bootstrap 是应用的组合根。
//
// 它等价于 Spring Boot 的 @SpringBootApplication：只声明“有哪些 Bean、
// 谁依赖谁”，不承载业务逻辑。Bean 的构造、注入与逆序销毁全部交给
// internal/spring（Go 版的 IoC 容器）。
package bootstrap

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"

	"github.com/gogf/gf/v2/net/ghttp"
	"google.golang.org/adk/v2/tool"

	"github.com/ezdemo/looprax/internal/config"
	"github.com/ezdemo/looprax/internal/controller"
	"github.com/ezdemo/looprax/internal/frontend"
	"github.com/ezdemo/looprax/internal/infrastructure/logging"
	"github.com/ezdemo/looprax/internal/repository"
	"github.com/ezdemo/looprax/internal/service"
	"github.com/ezdemo/looprax/internal/service/agent"
	"github.com/ezdemo/looprax/internal/service/tools"
	"github.com/ezdemo/looprax/internal/spring"
	"github.com/ezdemo/looprax/web"
)

// Run 等价于 SpringApplication.run：刷新上下文、按注册顺序实例化单例、
// 执行 ApplicationRunner（HTTP 服务会阻塞到进程退出），最后按创建顺序的
// 逆序销毁 Bean；任一步失败都会回滚已创建的资源。
func Run(ctx context.Context, options config.Options) error {
	return spring.NewApplication("looprax").
		Instance(options).
		Bean(
			config.Load,         // @ConfigurationProperties：命令行 > 环境变量 > config.yaml > 默认值
			newConfigRepository, // @Repository
			newConfigService,    // @Service
			service.NewFileService,
			newToolRegistry,
			newAgent,
			newBackend,    // @RestController 的运行时宿主
			newRouter,     // Spring MVC 的 DispatcherServlet 装配
			newHTTPServer, // ApplicationRunner：阻塞到进程退出
		).
		Run(ctx)
}

func newConfigRepository(settings *config.Server) *repository.ConfigRepository {
	return repository.NewConfigRepository(settings.Home)
}

func newConfigService(settings *config.Server, repository *repository.ConfigRepository) (*service.ConfigService, error) {
	cfg, err := repository.Load()
	if err != nil {
		return nil, fmt.Errorf("load configuration: %w", err)
	}
	cfg.WorkspaceDir, err = service.PrepareWorkspace(settings.Home, cfg.WorkspaceDir)
	if err != nil {
		return nil, fmt.Errorf("prepare workspace: %w", err)
	}
	logging.Debugf("config", "workspace=%s model=%s channel=%s effort=%s channels=%d hitl=%s",
		cfg.WorkspaceDir, cfg.Model, cfg.ModelChannelID, cfg.ReasoningEffort, len(cfg.ModelChannels), cfg.Hitl)
	return service.NewConfigService(repository, cfg), nil
}

func newToolRegistry(configuration *service.ConfigService) *tools.Registry {
	workspace := configuration.Snapshot().WorkspaceDir
	return tools.NewRegistry(append(tools.FileTools(workspace), tools.BashTools(workspace)...)...)
}

func newAgent(settings *config.Server, configuration *service.ConfigService, registry *tools.Registry) (*agent.Agent, error) {
	cfg := configuration.Snapshot()
	a, err := agent.New(settings.Home, service.WorkspaceHash(cfg.WorkspaceDir), cfg, agent.Options{
		Toolsets: []tool.Toolset{registry}, Config: cfg,
	})
	if err != nil {
		return nil, fmt.Errorf("assemble agent: %w", err)
	}
	return a, nil
}

// backend 持有 API 运行时，并在容器关闭时释放它（DisposableBean 语义）。
type backend struct {
	controller *controller.Controller
	accessKey  string

	closeOnce sync.Once
	closeErr  error
}

func newBackend(settings *config.Server, a *agent.Agent, registry *tools.Registry, configuration *service.ConfigService, files *service.FileService) (*backend, error) {
	dir, bundle, label := frontend.Resolve(settings.StaticDir, settings.Home, frontend.DistCandidates(), web.Bundle())
	settings.StaticDir = dir
	settings.StaticLabel = label
	if label != "embedded" && !frontend.HasIndex(dir) {
		logging.Warnf("server", "frontend not found; run pnpm build in web/ or pass --static-dir")
	}
	api, key, err := controller.New(a, controller.Options{
		Home: settings.Home, AccessKey: settings.AccessKey,
		StaticDir: dir, StaticFS: bundle, PetsDir: settings.PetsDir,
		Registry: registry, Configuration: configuration, Files: files,
	})
	if err != nil {
		return nil, err
	}
	return &backend{controller: api, accessKey: key}, nil
}

// Close 释放 API 运行时；重复调用是安全的，HTTP 服务器与容器都会触发它。
func (b *backend) Close() error {
	b.closeOnce.Do(func() { b.closeErr = b.controller.Close() })
	return b.closeErr
}

// Destroy 实现 spring.DisposableBean。
func (b *backend) Destroy(context.Context) error { return b.Close() }

var serverSequence atomic.Uint64

// newServerName 生成进程内唯一的 GoFrame 服务器名，避免测试之间复用全局实例。
func newServerName() string {
	return fmt.Sprintf("looprax-app-%d-%d", os.Getpid(), serverSequence.Add(1))
}

func newRouter(backend *backend) *ghttp.Server {
	return controller.NewServer(backend.controller, newServerName())
}
