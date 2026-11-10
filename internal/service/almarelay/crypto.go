// Package almarelay implements Loopra's encrypted transport over alma-relay.
package almarelay

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

const e2eLabel = "loopra-relay-e2e/v1"

type frame struct {
	Type    string            `json:"t"`
	ID      string            `json:"id,omitempty"`
	Path    string            `json:"path,omitempty"`
	Method  string            `json:"method,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"b,omitempty"`
	Text    string            `json:"s,omitempty"`
	Status  int               `json:"status,omitempty"`
	Message string            `json:"message,omitempty"`
	Code    int               `json:"code,omitempty"`
}

type handshake struct {
	Type             string `json:"t"`
	Public           string `json:"epk,omitempty"`
	Nonce            string `json:"n,omitempty"`
	ConfirmResponder string `json:"cr,omitempty"`
	ConfirmInitiator string `json:"ci,omitempty"`
	Binary           int    `json:"bin,omitempty"`
}

type secureSession struct {
	receive, send                   cipher.AEAD
	confirmation                    []byte
	sendCounter, receiveCounter     uint64
	exhaustedSend, exhaustedReceive bool
	ready                           bool
}

func derive(ikm, salt, info []byte, length int) ([]byte, error) {
	return hkdf.Key(sha256.New, ikm, salt, string(info), length)
}

func routingID(code string) (string, error) {
	raw, err := derive([]byte(code), []byte(e2eLabel+"/routing"), nil, 16)
	return base64.RawURLEncoding.EncodeToString(raw), err
}

func respond(code string, hello handshake) (*secureSession, handshake, error) {
	if hello.Type != "hi" {
		return nil, handshake{}, errors.New("expected handshake")
	}
	public, err := base64.RawURLEncoding.DecodeString(hello.Public)
	if err != nil {
		return nil, handshake{}, errors.New("invalid public key")
	}
	nonce, err := base64.RawURLEncoding.DecodeString(hello.Nonce)
	if err != nil || len(nonce) != 16 {
		return nil, handshake{}, errors.New("invalid nonce")
	}
	peer, err := ecdh.P256().NewPublicKey(public)
	if err != nil {
		return nil, handshake{}, errors.New("invalid public key")
	}
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, handshake{}, err
	}
	shared, err := key.ECDH(peer)
	if err != nil {
		return nil, handshake{}, err
	}
	responderNonce := make([]byte, 16)
	if _, err := rand.Read(responderNonce); err != nil {
		return nil, handshake{}, err
	}
	transcript := append([]byte(e2eLabel), public...)
	transcript = append(transcript, key.PublicKey().Bytes()...)
	transcript = append(transcript, nonce...)
	transcript = append(transcript, responderNonce...)
	hash := sha256.Sum256(transcript)
	get := func(label string) ([]byte, error) {
		return derive(shared, []byte(code), append([]byte(label), hash[:]...), 32)
	}
	c2s, err := get("c2s|")
	if err != nil {
		return nil, handshake{}, err
	}
	s2c, err := get("s2c|")
	if err != nil {
		return nil, handshake{}, err
	}
	cr, err := get("confirm-r|")
	if err != nil {
		return nil, handshake{}, err
	}
	ci, err := get("confirm-i|")
	if err != nil {
		return nil, handshake{}, err
	}
	receiveBlock, err := aes.NewCipher(c2s)
	if err != nil {
		return nil, handshake{}, err
	}
	sendBlock, err := aes.NewCipher(s2c)
	if err != nil {
		return nil, handshake{}, err
	}
	receive, err := cipher.NewGCM(receiveBlock)
	if err != nil {
		return nil, handshake{}, err
	}
	send, err := cipher.NewGCM(sendBlock)
	if err != nil {
		return nil, handshake{}, err
	}
	// Omitting bin deliberately negotiates the documented JSON inner format.
	return &secureSession{receive: receive, send: send, confirmation: ci}, handshake{
		Type: "hi", Public: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		Nonce: base64.RawURLEncoding.EncodeToString(responderNonce), ConfirmResponder: base64.RawURLEncoding.EncodeToString(cr),
	}, nil
}

func (s *secureSession) confirm(h handshake) error {
	ci, err := base64.RawURLEncoding.DecodeString(h.ConfirmInitiator)
	if err != nil || h.Type != "ok" || subtle.ConstantTimeCompare(ci, s.confirmation) != 1 {
		return errors.New("auth-failed")
	}
	s.ready = true
	s.confirmation = nil
	return nil
}

func (s *secureSession) seal(f frame) ([]byte, error) {
	if !s.ready || s.exhaustedSend {
		return nil, errors.New("session unavailable")
	}
	raw, err := json.Marshal(f)
	if err != nil {
		return nil, err
	}
	iv := make([]byte, 12)
	binary.BigEndian.PutUint64(iv[4:], s.sendCounter)
	s.exhaustedSend = s.sendCounter == math.MaxUint64
	s.sendCounter++
	return s.send.Seal(iv, iv, raw, nil), nil
}

func (s *secureSession) open(wire []byte) (frame, error) {
	var f frame
	if !s.ready || s.exhaustedReceive || len(wire) < 12+s.receive.Overhead() {
		return f, errors.New("invalid encrypted frame")
	}
	if binary.BigEndian.Uint32(wire[:4]) != 0 || binary.BigEndian.Uint64(wire[4:12]) != s.receiveCounter {
		return f, errors.New("invalid frame counter")
	}
	raw, err := s.receive.Open(nil, wire[:12], wire[12:], nil)
	if err != nil {
		return f, errors.New("invalid encrypted frame")
	}
	s.exhaustedReceive = s.receiveCounter == math.MaxUint64
	s.receiveCounter++
	if len(raw) > 0 && raw[0] == 0 {
		if len(raw) < 5 {
			return f, errors.New("truncated inner frame")
		}
		n := uint64(binary.BigEndian.Uint32(raw[1:5]))
		if n > uint64(len(raw)-5) {
			return f, errors.New("truncated inner frame")
		}
		var header struct {
			frame
			Payload string `json:"$"`
		}
		if err := json.Unmarshal(raw[5:5+n], &header); err != nil {
			return f, err
		}
		f = header.frame
		switch header.Payload {
		case "b":
			f.Body = base64.RawURLEncoding.EncodeToString(raw[5+n:])
		case "s":
			f.Text = string(raw[5+n:])
		default:
			return f, fmt.Errorf("invalid inner payload")
		}
		return f, nil
	}
	err = json.Unmarshal(raw, &f)
	return f, err
}
