package controller

import (
	"sync"

	"github.com/ezdemo/looprax/internal/shellterm"
)

// shellTerminals keeps interactive shells per project. The HTTP controller
// for a project is copied per request, so the registry lives on the process
// root and is keyed by the project hash.
type shellTerminals struct {
	mu   sync.Mutex
	hubs map[string]*shellterm.Hub
}

func (s *Controller) shellHub() *shellterm.Hub {
	root := s
	if s.state != nil && s.state.root != nil {
		root = s.state.root
	}
	if root.shellTerms == nil {
		root.shellTerms = &shellTerminals{hubs: map[string]*shellterm.Hub{}}
	}
	key := s.shellProjectKey()
	root.shellTerms.mu.Lock()
	defer root.shellTerms.mu.Unlock()
	hub := root.shellTerms.hubs[key]
	if hub == nil {
		hub = shellterm.NewHub()
		root.shellTerms.hubs[key] = hub
	}
	return hub
}

func (s *Controller) closeShellTerminals() {
	if s.shellTerms == nil {
		return
	}
	s.shellTerms.mu.Lock()
	hubs := s.shellTerms.hubs
	s.shellTerms.hubs = map[string]*shellterm.Hub{}
	s.shellTerms.mu.Unlock()
	for _, hub := range hubs {
		hub.CloseAll()
	}
}
