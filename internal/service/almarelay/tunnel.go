package almarelay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

type phone struct {
	ctx       context.Context
	cancel    context.CancelFunc
	code      string
	host      Host
	outerSend func(frame) error
	in        chan frame
	mu        sync.Mutex
	session   *secureSession
	requests  map[string]context.CancelFunc
	workers   sync.WaitGroup
}

func newPhone(ctx context.Context, code string, host Host, send func(frame) error) *phone {
	ctx, cancel := context.WithCancel(ctx)
	return &phone{ctx: ctx, cancel: cancel, code: code, host: host, outerSend: send, in: make(chan frame, 64), requests: map[string]context.CancelFunc{}}
}

func (p *phone) close() { p.cancel() }

func (p *phone) run() {
	defer func() {
		p.cancel()
		p.workers.Wait()
		// A dead relay is already closed; an individual failed phone must also
		// release its relay slot without interrupting any application turn.
		_ = p.outerSend(frame{Type: "wclose", Code: 1000})
	}()
	timer := time.NewTimer(15 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-p.ctx.Done():
			return
		case <-timer.C:
			return
		case f := <-p.in:
			if p.session == nil {
				var hello handshake
				if json.Unmarshal([]byte(f.Text), &hello) != nil {
					return
				}
				session, reply, err := respond(p.code, hello)
				if err != nil {
					return
				}
				p.session = session
				raw, err := json.Marshal(reply)
				if err != nil {
					return
				}
				if err := p.outerSend(frame{Type: "wmsg", Text: string(raw)}); err != nil {
					return
				}
			} else if !p.session.ready {
				var confirmation handshake
				if json.Unmarshal([]byte(f.Text), &confirmation) != nil || p.session.confirm(confirmation) != nil {
					return
				}
				timer.Stop()
			} else {
				wire, err := base64.StdEncoding.DecodeString(f.Body)
				if err != nil {
					return
				}
				inner, err := p.session.open(wire)
				if err != nil {
					return
				}
				if err := p.handle(inner); err != nil {
					return
				}
			}
		}
	}
}

func (p *phone) send(f frame) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.ctx.Err(); err != nil {
		return err
	}
	wire, err := p.session.seal(f)
	if err != nil {
		return err
	}
	if err := p.outerSend(frame{Type: "wmsg", Body: base64.StdEncoding.EncodeToString(wire)}); err != nil {
		p.cancel()
		return err
	}
	return nil
}

func (p *phone) handle(f frame) error {
	if f.ID == "" || len(f.ID) > 128 {
		return errors.New("invalid request id")
	}
	switch f.Type {
	case "hreq":
		body, err := base64.RawURLEncoding.DecodeString(f.Body)
		if err != nil || len(body) > 6<<20 {
			return p.send(frame{Type: "herr", ID: f.ID, Message: "invalid request body"})
		}
		p.mu.Lock()
		if len(p.requests) >= 64 || p.requests[f.ID] != nil {
			p.mu.Unlock()
			return p.send(frame{Type: "herr", ID: f.ID, Message: "request limit"})
		}
		ctx, cancel := context.WithCancel(p.ctx)
		p.requests[f.ID] = cancel
		p.mu.Unlock()
		p.workers.Go(func() {
			defer cancel()
			defer func() { p.mu.Lock(); delete(p.requests, f.ID); p.mu.Unlock() }()
			p.serveHTTP(ctx, p.host, f, body)
		})
	case "hcancel":
		p.mu.Lock()
		if cancel := p.requests[f.ID]; cancel != nil {
			cancel()
		}
		p.mu.Unlock()
	default:
		return errors.New("unsupported frame")
	}
	return nil
}
