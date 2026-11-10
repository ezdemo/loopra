package almarelay

import (
	"errors"
	"sync"
	"testing"
)

type memoryConfigStore struct {
	mu     sync.Mutex
	fields map[string]any
	fail   bool
}

func (s *memoryConfigStore) Load() (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := map[string]any{}
	for k, v := range s.fields {
		copy[k] = v
	}
	return copy, nil
}
func (s *memoryConfigStore) Save(patch map[string]any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("disk unavailable")
	}
	for k, v := range patch {
		s.fields[k] = v
	}
	return nil
}

func TestManagerPersistsSettingsSecretsAndPairingIdentity(t *testing.T) {
	store := &memoryConfigStore{fields: map[string]any{"future": "keep"}}
	m, err := NewManager(store, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if m.Status().Enabled || store.fields["connectCode"] != nil {
		t.Fatal("disabled service created identity")
	}
	yes, no := true, false
	address, key := "https://relay.example/", "saved-registration-key"
	first, err := m.Update(Update{Enabled: &yes, RelayURL: &address, RegistrationKey: &key})
	if err != nil {
		t.Fatal(err)
	}
	if first.PairingLink == "" || first.RelayURL != "https://relay.example" || !first.HasRegistrationKey {
		t.Fatal(first)
	}
	if _, err := m.Update(Update{Enabled: &no}); err != nil {
		t.Fatal(err)
	}
	if m.Status().PairingLink != "" || m.Status().RelayURL == "" {
		t.Fatal("disabled settings lost or pairing exposed")
	}
	restored, err := NewManager(store, Config{URL: "https://environment.example", Key: "environment-key"})
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	if restored.Status().Enabled || restored.Status().RelayURL != first.RelayURL {
		t.Fatal("saved configuration did not override environment")
	}
	second, err := restored.Update(Update{Enabled: &yes})
	if err != nil {
		t.Fatal(err)
	}
	if first.PairingLink != second.PairingLink || store.fields["registrationKey"] != key || store.fields["future"] != "keep" {
		t.Fatal("identity, secret or future fields lost")
	}
	empty := ""
	if _, err := restored.Update(Update{RegistrationKey: &empty}); err != nil {
		t.Fatal(err)
	}
	if restored.Status().HasRegistrationKey || store.fields["registrationKey"] != "" {
		t.Fatal("secret not cleared")
	}
	rotated, err := restored.ResetPairing()
	if err != nil {
		t.Fatal(err)
	}
	if rotated.PairingLink == second.PairingLink {
		t.Fatal("pairing rotation kept old secret")
	}
}

func TestManagerPreservesRunningConfigurationOnInvalidOrFailedSave(t *testing.T) {
	store := &memoryConfigStore{fields: map[string]any{}}
	m, err := NewManager(store, Config{})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	yes := true
	address := "https://relay.example"
	if _, err := m.Update(Update{Enabled: &yes, RelayURL: &address}); err != nil {
		t.Fatal(err)
	}
	before := m.Status()
	invalid := "https://relay.example/path"
	if _, err := m.Update(Update{RelayURL: &invalid}); err == nil {
		t.Fatal("invalid address accepted")
	}
	store.fail = true
	changed := "https://other.example"
	if _, err := m.Update(Update{RelayURL: &changed}); !errors.Is(err, ErrConfigStorage) {
		t.Fatal(err)
	}
	if _, err := m.ResetPairing(); !errors.Is(err, ErrConfigStorage) {
		t.Fatal(err)
	}
	after := m.Status()
	if before != after || store.fields["relayUrl"] != before.RelayURL {
		t.Fatal("failed save changed active configuration")
	}
}
