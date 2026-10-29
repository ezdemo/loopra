package spring

import (
	"context"
	"errors"
	"fmt"
)

// ApplicationRunner 等价于 Spring Boot 的 ApplicationRunner：
// 上下文刷新完成后按 Bean 创建顺序执行，通常用于启动 HTTP 服务等阻塞式组件。
type ApplicationRunner interface {
	Run(ctx context.Context) error
}

// Application 是 Spring Boot 风格的启动入口。
type Application struct {
	name    string
	factory *BeanFactory
	runners []ApplicationRunner
}

// NewApplication 创建一个应用上下文，等价于 @SpringBootApplication。
func NewApplication(name string) *Application {
	return &Application{name: name, factory: NewBeanFactory()}
}

// Name 返回应用名。
func (a *Application) Name() string { return a.name }

// Bean 注册一个或多个 @Bean 构造函数；依赖按参数类型注入。
func (a *Application) Bean(constructors ...any) *Application {
	for _, constructor := range constructors {
		if err := a.factory.Register(constructor); err != nil {
			panic(err)
		}
	}
	return a
}

// Instance 注册预先构造的单例（例如 context.Context、命令行参数）。
func (a *Application) Instance(instances ...any) *Application {
	for _, instance := range instances {
		if err := a.factory.RegisterInstance(instance); err != nil {
			panic(err)
		}
	}
	return a
}

// Context 返回应用上下文，便于在启动前解析 Bean。
func (a *Application) Context() *BeanFactory { return a.factory }

// Run 刷新上下文、运行 ApplicationRunner，并在返回时逆序销毁 Bean。
// 它的语义与 SpringApplication.run 一致：启动失败返回错误，正常停机返回 nil。
func (a *Application) Run(ctx context.Context) (err error) {
	a.factory.SetContext(ctx)
	if err := a.factory.InstantiateAll(); err != nil {
		return errors.Join(err, a.factory.Close(context.Background()))
	}
	if err := a.collectRunners(); err != nil {
		return errors.Join(err, a.factory.Close(context.Background()))
	}
	for _, runner := range a.runners {
		if err := runner.Run(ctx); err != nil {
			return errors.Join(err, a.factory.Close(context.Background()))
		}
	}
	return a.factory.Close(context.Background())
}

func (a *Application) collectRunners() error {
	runners := make([]ApplicationRunner, 0, 1)
	for _, typ := range a.factory.beanTypes() {
		bean, err := a.factory.Resolve(typ)
		if err != nil {
			return fmt.Errorf("spring: resolve runner %s: %w", typ, err)
		}
		if runner, ok := bean.Interface().(ApplicationRunner); ok {
			runners = append(runners, runner)
		}
	}
	a.runners = runners
	return nil
}
