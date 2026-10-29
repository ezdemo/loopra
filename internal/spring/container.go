// Package spring 是 Spring Boot 风格的轻量 IoC 容器。
//
// Go 没有注解，因此这里用构造函数注册（等价于 @Bean）与按类型解析
// （等价于构造器注入）表达同样的依赖关系：
//
//	app := spring.NewApplication("looprax")
//	app.Instance(ctx)              // 预先构造的单例（如 context.Context）
//	app.Bean(config.Load)          // 等价于 @Bean 方法
//	app.Bean(newConfigService)     // 参数类型即注入点
//	app.Run(ctx)                   // 等价于 SpringApplication.run
//
// 容器只管理单例 Bean，支持构造器注入、生命周期回调
// （InitializingBean / DisposableBean）与逆序销毁。
package spring

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
)

// InitializingBean 等价于 Spring 的 InitializingBean#afterPropertiesSet。
type InitializingBean interface {
	AfterPropertiesSet(ctx context.Context) error
}

// DisposableBean 等价于 Spring 的 DisposableBean#destroy。
type DisposableBean interface {
	Destroy(ctx context.Context) error
}

var (
	contextType = reflect.TypeOf((*context.Context)(nil)).Elem()
	errorType   = reflect.TypeOf((*error)(nil)).Elem()
	cleanupType = reflect.TypeOf((func() error)(nil))
)

// BeanFactory 负责定义收集、依赖解析与单例缓存。
type BeanFactory struct {
	mu         sync.Mutex
	defs       []*definition
	singletons map[reflect.Type]reflect.Value
	order      []reflect.Type
	creating   map[reflect.Type]bool
	teardowns  []func(context.Context) error
	ctx        context.Context
	closed     bool
}

type definition struct {
	constructor reflect.Value
	beanType    reflect.Type
	hasError    bool
	hasCleanup  bool
}

// NewBeanFactory 创建一个空的 Bean 工厂。
func NewBeanFactory() *BeanFactory {
	return &BeanFactory{
		singletons: make(map[reflect.Type]reflect.Value),
		creating:   make(map[reflect.Type]bool),
		ctx:        context.Background(),
	}
}

// Register 注册一个构造函数。支持的签名：
//
//	func(deps...) T
//	func(deps...) (T, error)
//	func(deps...) (T, func() error, error)
//
// 依赖按参数类型解析；context.Context 自动注入应用上下文。
func (f *BeanFactory) Register(constructor any) error {
	value := reflect.ValueOf(constructor)
	if value.Kind() != reflect.Func {
		return fmt.Errorf("spring: bean constructor must be a function, got %T", constructor)
	}
	typ := value.Type()
	if typ.IsVariadic() {
		return fmt.Errorf("spring: bean constructor %s must not be variadic", typ)
	}
	definition := &definition{constructor: value}
	switch typ.NumOut() {
	case 1:
		definition.beanType = typ.Out(0)
	case 2:
		if typ.Out(1) != errorType {
			return fmt.Errorf("spring: bean constructor %s must return (T, error)", typ)
		}
		definition.beanType = typ.Out(0)
		definition.hasError = true
	case 3:
		if typ.Out(1) != cleanupType || typ.Out(2) != errorType {
			return fmt.Errorf("spring: bean constructor %s must return (T, func() error, error)", typ)
		}
		definition.beanType = typ.Out(0)
		definition.hasError = true
		definition.hasCleanup = true
	default:
		return fmt.Errorf("spring: bean constructor %s must return one to three values", typ)
	}
	if definition.beanType == errorType {
		return fmt.Errorf("spring: bean constructor %s cannot return only an error", typ)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return errors.New("spring: bean factory is closed")
	}
	for _, existing := range f.defs {
		if existing.beanType == definition.beanType {
			return fmt.Errorf("spring: duplicate bean definition for %s", definition.beanType)
		}
	}
	f.defs = append(f.defs, definition)
	return nil
}

// RegisterInstance 注册一个已构造的单例，等价于 Spring 中提前创建好的 Bean。
func (f *BeanFactory) RegisterInstance(instance any) error {
	if instance == nil {
		return errors.New("spring: cannot register a nil instance")
	}
	value := reflect.ValueOf(instance)
	typ := value.Type()
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return errors.New("spring: bean factory is closed")
	}
	if _, exists := f.singletons[typ]; exists {
		return fmt.Errorf("spring: duplicate bean instance for %s", typ)
	}
	f.singletons[typ] = value
	f.order = append(f.order, typ)
	f.teardowns = append(f.teardowns, newTeardown(value, nil))
	return nil
}

// SetContext 设置注入到构造函数中的 context.Context。
func (f *BeanFactory) SetContext(ctx context.Context) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ctx = ctx
}

// InstantiateAll 按注册顺序提前实例化所有构造函数，等价于 Spring 的非懒加载单例。
func (f *BeanFactory) InstantiateAll() error {
	for {
		f.mu.Lock()
		pending := make([]*definition, 0, len(f.defs))
		for _, def := range f.defs {
			if _, created := f.singletons[def.beanType]; !created {
				pending = append(pending, def)
			}
		}
		f.mu.Unlock()
		if len(pending) == 0 {
			return nil
		}
		progress := false
		for _, def := range pending {
			f.mu.Lock()
			_, created := f.singletons[def.beanType]
			f.mu.Unlock()
			if created {
				continue
			}
			if _, err := f.Resolve(def.beanType); err != nil {
				return err
			}
			progress = true
		}
		if !progress {
			return errors.New("spring: unable to instantiate all beans")
		}
	}
}

// Get 按类型把单例写入 target（必须是指针）。
func (f *BeanFactory) Get(target any) error {
	value := reflect.ValueOf(target)
	if value.Kind() != reflect.Pointer || value.IsNil() {
		return fmt.Errorf("spring: target must be a non-nil pointer, got %T", target)
	}
	bean, err := f.Resolve(value.Elem().Type())
	if err != nil {
		return err
	}
	value.Elem().Set(bean)
	return nil
}

// Resolve 解析指定类型的单例，必要时创建它及其依赖。
func (f *BeanFactory) Resolve(typ reflect.Type) (reflect.Value, error) {
	f.mu.Lock()
	if bean, ok := f.singletons[typ]; ok {
		f.mu.Unlock()
		return bean, nil
	}
	// Pre-built instances can satisfy context.Context and other interfaces
	// without registering every implemented interface separately.
	if typ.Kind() == reflect.Interface {
		var matches []reflect.Value
		for _, bean := range f.singletons {
			if bean.IsValid() && bean.Type().Implements(typ) {
				matches = append(matches, bean)
			}
		}
		switch len(matches) {
		case 1:
			f.mu.Unlock()
			return matches[0], nil
		case 0:
			// Continue with constructor-based resolution below.
		default:
			f.mu.Unlock()
			return reflect.Value{}, fmt.Errorf("spring: %d registered instances implement %s", len(matches), typ)
		}
	}
	if f.creating[typ] {
		f.mu.Unlock()
		return reflect.Value{}, fmt.Errorf("spring: circular dependency on %s", typ)
	}
	def, err := f.findDefinitionLocked(typ)
	if err != nil {
		f.mu.Unlock()
		return reflect.Value{}, err
	}
	// 接口类型可能在具体类型创建后才被请求：复用已创建的单例。
	if bean, ok := f.singletons[def.beanType]; ok {
		f.singletons[typ] = bean
		f.mu.Unlock()
		return bean, nil
	}
	f.creating[typ] = true
	ctx := f.ctx
	f.mu.Unlock()

	bean, cleanup, err := f.instantiate(ctx, def)

	f.mu.Lock()
	delete(f.creating, typ)
	f.mu.Unlock()
	if err != nil {
		if cleanup != nil {
			_ = cleanup()
		}
		return reflect.Value{}, err
	}

	// 初始化回调必须在锁外执行：Bean 可以在 AfterPropertiesSet 中
	// 继续 Resolve/Get 其它单例（Go 的 mutex 不可重入）。
	if initializer, ok := bean.Interface().(InitializingBean); ok {
		if err := initializer.AfterPropertiesSet(ctx); err != nil {
			if cleanup != nil {
				_ = cleanup()
			}
			return reflect.Value{}, fmt.Errorf("spring: initialize %s: %w", def.beanType, err)
		}
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if existing, ok := f.singletons[typ]; ok {
		if cleanup != nil {
			_ = cleanup()
		}
		return existing, nil
	}
	f.singletons[def.beanType] = bean
	if typ != def.beanType {
		f.singletons[typ] = bean
	}
	f.order = append(f.order, def.beanType)
	f.teardowns = append(f.teardowns, newTeardown(bean, cleanup))
	return bean, nil
}

// newTeardown 把 DisposableBean 与构造器清理函数合并为同一销毁步骤，
// 保证两类资源严格按创建顺序的逆序释放。
func newTeardown(bean reflect.Value, cleanup func() error) func(context.Context) error {
	return func(ctx context.Context) error {
		var errs []error
		if disposable, ok := bean.Interface().(DisposableBean); ok {
			if err := disposable.Destroy(ctx); err != nil {
				errs = append(errs, err)
			}
		}
		if cleanup != nil {
			if err := cleanup(); err != nil {
				errs = append(errs, err)
			}
		}
		return errors.Join(errs...)
	}
}

// Close 按创建顺序的逆序销毁 Bean，并执行构造器返回的清理函数。
func (f *BeanFactory) Close(ctx context.Context) error {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return nil
	}
	f.closed = true
	teardowns := append([]func(context.Context) error(nil), f.teardowns...)
	f.mu.Unlock()

	var errs []error
	for i := len(teardowns) - 1; i >= 0; i-- {
		if err := teardowns[i](ctx); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (f *BeanFactory) instantiate(ctx context.Context, def *definition) (reflect.Value, func() error, error) {
	typ := def.constructor.Type()
	args := make([]reflect.Value, typ.NumIn())
	for i := 0; i < typ.NumIn(); i++ {
		param := typ.In(i)
		if param == contextType {
			// 显式注册的 context.Context 实例优先于容器根上下文。
			if provided, ok := f.registeredContext(); ok {
				args[i] = provided
			} else {
				args[i] = reflect.ValueOf(ctx)
			}
			continue
		}
		bean, err := f.Resolve(param)
		if err != nil {
			return reflect.Value{}, nil, fmt.Errorf("spring: resolve %s for %s: %w", param, def.beanType, err)
		}
		args[i] = bean
	}
	results := def.constructor.Call(args)
	if def.hasError {
		if errValue := results[len(results)-1]; !errValue.IsNil() {
			if def.hasCleanup {
				if cleanup := results[1].Interface().(func() error); cleanup != nil {
					_ = cleanup()
				}
			}
			return reflect.Value{}, nil, fmt.Errorf("spring: construct %s: %w", def.beanType, errValue.Interface().(error))
		}
	}
	bean := results[0]
	if !bean.Type().AssignableTo(def.beanType) {
		return reflect.Value{}, nil, fmt.Errorf("spring: constructor returned %s, want %s", bean.Type(), def.beanType)
	}
	if def.hasCleanup {
		cleanup := results[1].Interface().(func() error)
		return bean, cleanup, nil
	}
	return bean, nil, nil
}

// registeredContext 返回显式注册的 context.Context 单例。
func (f *BeanFactory) registeredContext() (reflect.Value, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if value, ok := f.singletons[contextType]; ok {
		return value, true
	}
	for typ, value := range f.singletons {
		if typ.Kind() != reflect.Interface && typ.Implements(contextType) {
			return value, true
		}
	}
	return reflect.Value{}, false
}

func (f *BeanFactory) beanTypes() []reflect.Type {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]reflect.Type(nil), f.order...)
}

func (f *BeanFactory) findDefinitionLocked(typ reflect.Type) (*definition, error) {
	var matches []*definition
	for _, def := range f.defs {
		if def.beanType == typ || def.beanType.AssignableTo(typ) ||
			(typ.Kind() == reflect.Interface && def.beanType.Implements(typ)) {
			matches = append(matches, def)
		}
	}
	switch len(matches) {
	case 0:
		return nil, fmt.Errorf("spring: no bean of type %s", typ)
	case 1:
		return matches[0], nil
	default:
		return nil, fmt.Errorf("spring: %d beans implement %s; register the concrete type instead", len(matches), typ)
	}
}
