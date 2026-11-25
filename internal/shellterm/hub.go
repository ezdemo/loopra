package shellterm

import (
	"fmt"
	"sync"
)

const maxSessions = 8

// Hub keeps the interactive shells for one project.
type Hub struct {
	mu       sync.Mutex
	sessions map[string]*Session
	order    []string
	seq      int
}

func NewHub() *Hub {
	return &Hub{sessions: map[string]*Session{}}
}

// Open starts a shell in dir. The returned info is safe to send to the page.
func (h *Hub) Open(dir string) (Info, error) {
	return h.OpenWith(dir, Options{})
}

// OpenWith starts a session in dir. A non-empty opts.Key reuses the live
// session carrying that key instead of spawning another one.
func (h *Hub) OpenWith(dir string, opts Options) (Info, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if opts.Key != "" {
		for _, session := range h.sessions {
			if session.Key == opts.Key && !session.exitedState() {
				return session.Info(), nil
			}
		}
	}
	if len(h.sessions) >= maxSessions {
		return Info{}, fmt.Errorf("同时最多打开 %d 个终端", maxSessions)
	}
	h.seq++
	id := fmt.Sprintf("term-%d", h.seq)
	session, err := OpenWith(id, dir, opts)
	if err != nil {
		return Info{}, err
	}
	h.sessions[id] = session
	h.order = append(h.order, id)
	go func() {
		<-session.Done()
		// Keep an exited tab until the page closes it, so its last screen can be read.
	}()
	return session.Info(), nil
}

// List returns sessions in the order they were opened.
func (h *Hub) List() []Info {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]Info, 0, len(h.order))
	for _, id := range h.order {
		if session := h.sessions[id]; session != nil {
			out = append(out, session.Info())
		}
	}
	return out
}

// Get returns a live session.
func (h *Hub) Get(id string) (*Session, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	session, ok := h.sessions[id]
	return session, ok && session != nil
}

// CloseKey stops every session carrying key and reports whether any existed.
func (h *Hub) CloseKey(key string) bool {
	h.mu.Lock()
	var ids []string
	for _, session := range h.sessions {
		if session.Key == key {
			ids = append(ids, session.ID)
		}
	}
	h.mu.Unlock()
	closed := false
	for _, id := range ids {
		closed = h.Close(id) || closed
	}
	return closed
}

// Close stops one session. It reports whether the id existed.
func (h *Hub) Close(id string) bool {
	h.mu.Lock()
	session := h.sessions[id]
	if session == nil {
		h.mu.Unlock()
		return false
	}
	delete(h.sessions, id)
	order := h.order[:0]
	for _, item := range h.order {
		if item != id {
			order = append(order, item)
		}
	}
	h.order = order
	h.mu.Unlock()
	session.Close()
	return true
}

// CloseAll stops every shell. It is safe during process shutdown.
func (h *Hub) CloseAll() {
	h.mu.Lock()
	sessions := h.sessions
	h.sessions = map[string]*Session{}
	h.order = nil
	h.mu.Unlock()
	for _, session := range sessions {
		session.Close()
	}
}
