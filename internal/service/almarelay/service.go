package almarelay

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type Config struct {
	URL         string
	Key         string
	ConnectCode string
}

type Status struct {
	Enabled            bool   `json:"enabled"`
	State              string `json:"state"`
	RelayURL           string `json:"relayUrl,omitempty"`
	PairingLink        string `json:"pairingLink,omitempty"`
	HasRegistrationKey bool   `json:"hasRegistrationKey"`
}

// Host receives only authenticated, decrypted Loopra API requests.
type Host = http.Handler

const MobileTunnelPath = "/__loopra_e2e__/v1"

type Service struct {
	config          Config
	mu              sync.Mutex
	state           string
	cancel          context.CancelFunc
	done            chan struct{}
	started, closed bool
}

func New(config Config) (*Service, error) {
	if config.URL == "" {
		return &Service{state: "disabled"}, nil
	}
	u, err := url.Parse(config.URL)
	if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("Alma relay URL must be an HTTP(S) origin")
	}
	code, err := base64.RawURLEncoding.DecodeString(config.ConnectCode)
	if err != nil || len(code) != 32 {
		return nil, errors.New("Alma connect code must contain 32 base64url bytes")
	}
	config.URL = strings.TrimRight(config.URL, "/")
	return &Service{config: config, state: "stopped"}, nil
}

func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	status := Status{Enabled: s.config.URL != "", State: s.state, RelayURL: s.config.URL}
	if status.Enabled {
		query := url.Values{"u": {s.config.URL}, "k": {s.config.ConnectCode}, "e2e": {"1"}}
		query.Set("v", "1")
		status.PairingLink = "loopra://connect?" + query.Encode()
	}
	return status
}

func (s *Service) Start(ctx context.Context, host Host) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started || s.closed || s.config.URL == "" {
		return
	}
	s.started = true
	s.state = "connecting"
	ctx, s.cancel = context.WithCancel(ctx)
	s.done = make(chan struct{})
	go s.run(ctx, host)
}

func (s *Service) Close() error {
	s.mu.Lock()
	s.closed = true
	if s.cancel != nil {
		s.cancel()
	}
	done := s.done
	s.mu.Unlock()
	if done != nil {
		<-done
	}
	return nil
}

func (s *Service) setState(state string) { s.mu.Lock(); s.state = state; s.mu.Unlock() }

func (s *Service) run(ctx context.Context, host Host) {
	defer close(s.done)
	defer s.setState("stopped")
	delay := time.Second
	for ctx.Err() == nil {
		s.setState("connecting")
		err := s.connect(ctx, host)
		if ctx.Err() != nil {
			return
		}
		var closeError *websocket.CloseError
		if errors.As(err, &closeError) && (closeError.Code == 4000 || closeError.Code == 4003 || closeError.Code == 4401) {
			s.setState("rejected")
			<-ctx.Done()
			return
		}
		s.setState("reconnecting")
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if delay < 30*time.Second {
			delay *= 2
		}
	}
}

func (s *Service) connect(ctx context.Context, host Host) error {
	id, err := routingID(s.config.ConnectCode)
	if err != nil {
		return err
	}
	hash := sha256.Sum256([]byte(id))
	tokenHash := hex.EncodeToString(hash[:])
	u, _ := url.Parse(s.config.URL)
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	u.Path, u.RawQuery = "/agent", "th="+tokenHash
	dialer := websocket.Dialer{Proxy: http.ProxyFromEnvironment, HandshakeTimeout: 10 * time.Second}
	conn, response, err := dialer.DialContext(ctx, u.String(), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.SetReadLimit(32 << 20)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() { <-ctx.Done(); _ = conn.Close() }()
	var writeMu sync.Mutex
	send := func(value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := conn.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return err
		}
		return conn.WriteJSON(value)
	}
	if err := send(map[string]any{"t": "register", "tokenHash": tokenHash, "name": "Loopra", "key": s.config.Key, "proto": 1}); err != nil {
		return err
	}
	if err := conn.SetReadDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return err
	}
	var registered struct {
		Type  string `json:"t"`
		Proto int    `json:"proto"`
	}
	if err := conn.ReadJSON(&registered); err != nil {
		return err
	}
	if registered.Type != "registered" || registered.Proto > 1 {
		return &websocket.CloseError{Code: 4003, Text: "relay rejected registration"}
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return err
	}
	if err := conn.SetReadDeadline(time.Now().Add(90 * time.Second)); err != nil {
		return err
	}
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	s.setState("connected")
	phones := map[string]*phone{}
	var workers sync.WaitGroup
	defer func() {
		cancel()
		for _, p := range phones {
			p.close()
		}
		workers.Wait()
	}()
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var f frame
		if err := json.Unmarshal(raw, &f); err != nil {
			return errors.New("invalid relay frame")
		}
		switch f.Type {
		case "hreq":
			if err := send(frame{Type: "hres", ID: f.ID, Status: 403}); err != nil {
				return err
			}
			if err := send(frame{Type: "hend", ID: f.ID}); err != nil {
				return err
			}
		case "wopen":
			for id, phone := range phones {
				if phone.ctx.Err() != nil {
					delete(phones, id)
				}
			}
			if f.ID == "" || f.Path != MobileTunnelPath || host == nil || phones[f.ID] != nil || len(phones) >= 32 {
				if err := send(frame{Type: "werr", ID: f.ID, Message: "unsupported socket"}); err != nil {
					return err
				}
				continue
			}
			phoneID := f.ID
			p := newPhone(ctx, s.config.ConnectCode, host, func(inner frame) error { inner.ID = phoneID; return send(inner) })
			phones[f.ID] = p
			if err := send(frame{Type: "wopened", ID: f.ID}); err != nil {
				return err
			}
			workers.Go(p.run)
		case "wmsg":
			if p := phones[f.ID]; p != nil {
				select {
				case p.in <- f:
				case <-p.ctx.Done():
				case <-ctx.Done():
					return ctx.Err()
				default:
					p.close()
				}
			}
		case "wclose":
			if p := phones[f.ID]; p != nil {
				p.close()
				delete(phones, f.ID)
			}
		case "error":
			return fmt.Errorf("relay connection failed")
		}
	}
}
