package repository

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

var almaRelayConfigMu sync.Mutex

type AlmaRelayRepository struct{ path string }

func NewAlmaRelayRepository(home string) *AlmaRelayRepository {
	return &AlmaRelayRepository{path: filepath.Join(home, "alma-relay.json")}
}

func readAlmaRelay(path string) (map[string]any, error) {
	fields := map[string]any{}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return fields, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read Alma relay config: %w", err)
	}
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, fmt.Errorf("invalid Alma relay config")
	}
	return fields, nil
}

func (r *AlmaRelayRepository) Load() (map[string]any, error) {
	almaRelayConfigMu.Lock()
	defer almaRelayConfigMu.Unlock()
	return readAlmaRelay(r.path)
}

// Save merges only the owned fields, under the same lock as the read and
// atomic replacement, so identity and future extension fields survive edits.
func (r *AlmaRelayRepository) Save(patch map[string]any) error {
	almaRelayConfigMu.Lock()
	defer almaRelayConfigMu.Unlock()
	fields, err := readAlmaRelay(r.path)
	if err != nil {
		return err
	}
	for key, value := range patch {
		fields[key] = value
	}
	return WriteJSON(r.path, fields)
}

// AlmaRelayConfig keeps the pairing identity independent of rotating Web keys.
// Unknown fields survive identity creation and future config extensions.
func AlmaRelayConfig(home string) (map[string]any, error) {
	almaRelayConfigMu.Lock()
	defer almaRelayConfigMu.Unlock()
	path := filepath.Join(home, "alma-relay.json")
	fields := map[string]any{}
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("read Alma relay config: %w", err)
	}
	if err == nil {
		if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
			return nil, fmt.Errorf("invalid Alma relay config")
		}
	}
	if _, exists := fields["connectCode"]; !exists {
		code := make([]byte, 32)
		if _, err := rand.Read(code); err != nil {
			return nil, err
		}
		fields["connectCode"] = base64.RawURLEncoding.EncodeToString(code)
		if err := WriteJSON(path, fields); err != nil {
			return nil, fmt.Errorf("save Alma pairing identity: %w", err)
		}
	}
	return fields, nil
}
