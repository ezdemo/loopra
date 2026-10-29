package schedule

import (
	"strings"
	"sync"
)

// Ticker 跟踪正在执行的任务，并用 4 个槽位限制并发。
// 进程内所有工作区共享同一个实例。
type Ticker struct {
	mu      sync.Mutex
	running map[string]bool
	sem     chan struct{}
	stop    chan struct{}
	once    sync.Once
}

func NewTicker() *Ticker {
	return &Ticker{
		running: map[string]bool{},
		sem:     make(chan struct{}, 4),
		stop:    make(chan struct{}),
	}
}

func (t *Ticker) Stop() {
	t.once.Do(func() { close(t.stop) })
}

// Done 在 Stop 之后关闭，供调度循环退出。
func (t *Ticker) Done() <-chan struct{} { return t.stop }

func (t *Ticker) TryStart(key string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.running[key] {
		return false
	}
	t.running[key] = true
	return true
}

func (t *Ticker) Finish(key string) {
	t.mu.Lock()
	delete(t.running, key)
	t.mu.Unlock()
}

func (t *Ticker) Acquire() bool {
	select {
	case t.sem <- struct{}{}:
		return true
	case <-t.stop:
		return false
	}
}

func (t *Ticker) Release() { <-t.sem }

func (t *Ticker) SetRunning(key string, on bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if on {
		t.running[key] = true
	} else {
		delete(t.running, key)
	}
}

func (t *Ticker) HasPrefix(prefix string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for key := range t.running {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	return false
}
