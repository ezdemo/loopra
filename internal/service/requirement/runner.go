package requirement

import (
	"context"
	"sync"
)

// Runner 把同时执行的需求限制为 2（与 Java 固定线程池一致），
// 并跟踪运行中的上下文以便中止。
type Runner struct {
	mu        sync.Mutex
	running   map[string]bool
	cancels   map[string]context.CancelFunc
	sem       chan struct{}
	cancelled map[string]bool
}

func NewRunner() *Runner {
	return &Runner{
		running:   map[string]bool{},
		cancels:   map[string]context.CancelFunc{},
		sem:       make(chan struct{}, 2),
		cancelled: map[string]bool{},
	}
}

func (r *Runner) Begin(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.running[id] {
		return false
	}
	if len(r.running) >= cap(r.sem) {
		return false
	}
	delete(r.cancelled, id)
	r.running[id] = true
	return true
}

func (r *Runner) End(id string) {
	r.mu.Lock()
	delete(r.running, id)
	delete(r.cancels, id)
	delete(r.cancelled, id)
	r.mu.Unlock()
}

func (r *Runner) Running(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.running[id]
}

func (r *Runner) Register(id string, cancel context.CancelFunc) {
	r.mu.Lock()
	r.cancels[id] = cancel
	if r.cancelled[id] {
		cancel()
	}
	r.mu.Unlock()
}

func (r *Runner) Cancel(id string) {
	r.mu.Lock()
	cancel := r.cancels[id]
	r.cancelled[id] = true
	r.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (r *Runner) Acquire(ctx context.Context) bool {
	select {
	case r.sem <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

func (r *Runner) AcquireBlocking() {
	r.sem <- struct{}{}
}

func (r *Runner) Release() {
	<-r.sem
}
