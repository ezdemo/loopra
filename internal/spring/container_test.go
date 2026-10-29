package spring

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

type greeter interface{ Greet() string }

type englishGreeter struct{}

func (englishGreeter) Greet() string { return "hello" }

type consumer struct {
	Greeter greeter
	Ready   bool
}

func (c *consumer) AfterPropertiesSet(context.Context) error {
	c.Ready = true
	return nil
}

func newGreeter() greeter { return englishGreeter{} }

func newConsumer(g greeter) *consumer { return &consumer{Greeter: g} }

func TestConstructorInjectionAndLifecycle(t *testing.T) {
	app := NewApplication("test").Bean(newGreeter, newConsumer)
	if err := app.Context().InstantiateAll(); err != nil {
		t.Fatal(err)
	}
	var got *consumer
	if err := app.Context().Get(&got); err != nil {
		t.Fatal(err)
	}
	if !got.Ready {
		t.Fatal("InitializingBean callback was not invoked")
	}
	if got.Greeter.Greet() != "hello" {
		t.Fatalf("greeter = %q", got.Greeter.Greet())
	}
	if err := app.Context().Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestInterfaceResolutionSelectsImplementation(t *testing.T) {
	factory := NewBeanFactory()
	if err := factory.Register(newGreeter); err != nil {
		t.Fatal(err)
	}
	value, err := factory.Resolve(reflect.TypeOf((*greeter)(nil)).Elem())
	if err != nil {
		t.Fatal(err)
	}
	if value.Interface().(greeter).Greet() != "hello" {
		t.Fatal("wrong implementation")
	}
}

func TestCycleAndMissingDependencyAreReported(t *testing.T) {
	type a struct{}
	type b struct{}
	factory := NewBeanFactory()
	if err := factory.Register(func(b *b) *a { return &a{} }); err != nil {
		t.Fatal(err)
	}
	if err := factory.Register(func(a *a) *b { return &b{} }); err != nil {
		t.Fatal(err)
	}
	if _, err := factory.Resolve(reflect.TypeOf((*a)(nil))); err == nil {
		t.Fatal("cycle was not detected")
	}
	missing := NewBeanFactory()
	if err := missing.Register(func(*struct{ Nope int }) *a { return &a{} }); err != nil {
		t.Fatal(err)
	}
	if _, err := missing.Resolve(reflect.TypeOf((*a)(nil))); err == nil {
		t.Fatal("missing dependency was not reported")
	}
}

func TestConstructorErrorPropagatesAndCleanupRunsInReverseOrder(t *testing.T) {
	var mu sync.Mutex
	var order []string
	factory := NewBeanFactory()
	first := func() (*consumer, func() error, error) {
		return &consumer{}, func() error {
			mu.Lock()
			order = append(order, "first")
			mu.Unlock()
			return nil
		}, nil
	}
	second := func(*consumer) (*englishGreeter, func() error, error) {
		return &englishGreeter{}, func() error {
			mu.Lock()
			order = append(order, "second")
			mu.Unlock()
			return nil
		}, nil
	}
	if err := factory.Register(first); err != nil {
		t.Fatal(err)
	}
	if err := factory.Register(second); err != nil {
		t.Fatal(err)
	}
	if err := factory.InstantiateAll(); err != nil {
		t.Fatal(err)
	}
	if err := factory.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(order, []string{"second", "first"}) {
		t.Fatalf("cleanup order = %v", order)
	}

	failing := NewBeanFactory()
	if err := failing.Register(func() (*consumer, error) {
		return nil, errors.New("boom")
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := failing.Resolve(reflect.TypeOf((*consumer)(nil))); err == nil {
		t.Fatal("constructor error was swallowed")
	}
}

type blockingRunner struct{ started chan struct{} }

func (r *blockingRunner) Run(ctx context.Context) error {
	close(r.started)
	<-ctx.Done()
	return nil
}

func TestApplicationRunnerBlocksUntilContextIsCancelled(t *testing.T) {
	runner := &blockingRunner{started: make(chan struct{})}
	app := NewApplication("runner").Instance(runner)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- app.Run(ctx) }()
	select {
	case <-runner.started:
	case <-time.After(2 * time.Second):
		t.Fatal("runner did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("application did not stop")
	}
}

func TestRegisteredContextInstanceSatisfiesContextParameter(t *testing.T) {
	type bean struct{ HasContext bool }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wantCtx := ctx
	app := NewApplication("context").Instance(ctx).Bean(func(ctx context.Context) *bean {
		return &bean{HasContext: ctx == wantCtx}
	})
	if err := app.Context().InstantiateAll(); err != nil {
		t.Fatal(err)
	}
	var got *bean
	if err := app.Context().Get(&got); err != nil {
		t.Fatal(err)
	}
	if !got.HasContext {
		t.Fatal("context.Context constructor parameter was not injected")
	}
}

type reentrantBean struct{ factory *BeanFactory }

func (b *reentrantBean) AfterPropertiesSet(context.Context) error {
	var dependency *consumer
	return b.factory.Get(&dependency)
}

type failingInitializer struct{}

func (*failingInitializer) AfterPropertiesSet(context.Context) error {
	return errors.New("init failed")
}

func TestInitializerMayResolveOtherBeansWithoutDeadlock(t *testing.T) {
	factory := NewBeanFactory()
	done := make(chan error, 1)
	go func() {
		if err := factory.Register(newGreeter); err != nil {
			done <- err
			return
		}
		if err := factory.Register(newConsumer); err != nil {
			done <- err
			return
		}
		if err := factory.Register(func(f *BeanFactory) *reentrantBean { return &reentrantBean{factory: f} }); err != nil {
			done <- err
			return
		}
		if err := factory.RegisterInstance(factory); err != nil {
			done <- err
			return
		}
		done <- factory.InstantiateAll()
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("AfterPropertiesSet deadlocked while resolving another bean")
	}
}

func TestInitializerFailureRunsCleanupExactlyOnce(t *testing.T) {
	calls := 0
	factory := NewBeanFactory()
	if err := factory.Register(func() (*failingInitializer, func() error, error) {
		return &failingInitializer{}, func() error {
			calls++
			return nil
		}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := factory.Resolve(reflect.TypeOf((*failingInitializer)(nil))); err == nil {
		t.Fatal("initializer failure was not reported")
	}
	if err := factory.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("cleanup ran %d times, want exactly 1", calls)
	}
}

type destroyableBean struct{ order *[]string }

func (b *destroyableBean) Destroy(context.Context) error {
	*b.order = append(*b.order, "destroy")
	return nil
}

func TestDestroyAndCleanupShareOneReverseStack(t *testing.T) {
	var order []string
	factory := NewBeanFactory()
	if err := factory.Register(func() *destroyableBean { return &destroyableBean{order: &order} }); err != nil {
		t.Fatal(err)
	}
	if err := factory.Register(func(*destroyableBean) (*consumer, func() error, error) {
		return &consumer{}, func() error {
			order = append(order, "cleanup")
			return nil
		}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := factory.InstantiateAll(); err != nil {
		t.Fatal(err)
	}
	if err := factory.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(order, []string{"cleanup", "destroy"}) {
		t.Fatalf("teardown order = %v", order)
	}
}
