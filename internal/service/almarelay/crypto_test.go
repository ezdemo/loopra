package almarelay

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
)

func testSession(t *testing.T, code string) (*secureSession, *secureSession) {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	nonce := bytes.Repeat([]byte{1}, 16)
	desktop, response, err := respond(code, handshake{Type: "hi", Public: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), Nonce: base64.RawURLEncoding.EncodeToString(nonce), Binary: 1})
	if err != nil {
		t.Fatal(err)
	}
	public, err := base64.RawURLEncoding.DecodeString(response.Public)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := ecdh.P256().NewPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := key.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	n, err := base64.RawURLEncoding.DecodeString(response.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	transcript := append([]byte(e2eLabel), key.PublicKey().Bytes()...)
	transcript = append(transcript, public...)
	transcript = append(transcript, nonce...)
	transcript = append(transcript, n...)
	hash := sha256.Sum256(transcript)
	get := func(label string) []byte {
		raw, err := derive(shared, []byte(code), append([]byte(label), hash[:]...), 32)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	cr, err := base64.RawURLEncoding.DecodeString(response.ConfirmResponder)
	if err != nil || !bytes.Equal(cr, get("confirm-r|")) {
		t.Fatal("responder authentication failed")
	}
	aead := func(key []byte) cipher.AEAD {
		block, err := aes.NewCipher(key)
		if err != nil {
			t.Fatal(err)
		}
		aead, err := cipher.NewGCM(block)
		if err != nil {
			t.Fatal(err)
		}
		return aead
	}
	phone := &secureSession{send: aead(get("c2s|")), receive: aead(get("s2c|")), ready: true}
	if err := desktop.confirm(handshake{Type: "ok", ConfirmInitiator: base64.RawURLEncoding.EncodeToString(get("confirm-i|"))}); err != nil {
		t.Fatal(err)
	}
	return desktop, phone
}

func TestAuthenticatedFramesRejectReplayAndTampering(t *testing.T) {
	desktop, phone := testSession(t, base64.RawURLEncoding.EncodeToString(make([]byte, 32)))
	request := frame{Type: "hreq", ID: "request", Method: "GET", Path: "/api/threads"}
	wire, err := phone.seal(request)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := desktop.open(wire)
	if err != nil || decoded.Path != request.Path {
		t.Fatalf("round trip: %v %v", decoded, err)
	}
	if _, err := desktop.open(wire); err == nil {
		t.Fatal("replay accepted")
	}
	wire, err = phone.seal(request)
	if err != nil {
		t.Fatal(err)
	}
	bad := bytes.Clone(wire)
	bad[len(bad)-1] ^= 1
	if _, err := desktop.open(bad); err == nil {
		t.Fatal("tampered frame accepted")
	}
	if _, err := desktop.open(wire); err != nil {
		t.Fatal("failed authentication advanced the counter", err)
	}
	response, err := desktop.seal(frame{Type: "hres", ID: "request", Status: 200})
	if err != nil {
		t.Fatal(err)
	}
	if decoded, err := phone.open(response); err != nil || decoded.Status != 200 {
		t.Fatalf("response: %v %v", decoded, err)
	}
}

func TestHandshakeRejectsInvalidPeersAndConfirmation(t *testing.T) {
	for _, hello := range []handshake{{Type: "hi"}, {Type: "other"}, {Type: "hi", Public: "bad", Nonce: "bad"}} {
		if _, _, err := respond("code", hello); err == nil {
			t.Fatal("invalid peer accepted")
		}
	}
	desktop, _ := testSession(t, "shared-secret")
	desktop.ready = false
	desktop.confirmation = make([]byte, 32)
	if err := desktop.confirm(handshake{Type: "ok", ConfirmInitiator: "wrong"}); err == nil {
		t.Fatal("invalid confirmation accepted")
	}
	if _, err := desktop.seal(frame{Type: "hres"}); err == nil {
		t.Fatal("unauthenticated send accepted")
	}
}

func TestRelayConfigAndStatus(t *testing.T) {
	code := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	for _, address := range []string{"file:///tmp", "https://user@example.com", "https://example.com/path", "https://example.com?key=secret"} {
		if _, err := New(Config{URL: address, ConnectCode: code}); err == nil {
			t.Fatal("invalid relay accepted", address)
		}
	}
	s, err := New(Config{URL: "https://relay.example", Key: "registration-secret", ConnectCode: code})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(s.Status())
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("registration-secret")) {
		t.Fatal("registration key exposed")
	}
	if !bytes.Contains(raw, []byte("loopra://connect")) {
		t.Fatal("missing pairing link")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}
