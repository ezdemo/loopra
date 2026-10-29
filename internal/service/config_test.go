package service

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/ezdemo/looprax/internal/model/config"
)

type configStoreStub struct {
	err error
}

func (r *configStoreStub) Save(*config.Loopra) error { return r.err }

func TestConfigUpdateRollsBackOnPersistenceFailure(t *testing.T) {
	initial := config.Default()
	failure := errors.New("disk unavailable")
	store := &configStoreStub{err: failure}
	service := NewConfigService(store, &initial)
	if _, err := service.Update(map[string]any{"model": "replacement"}); !errors.Is(err, failure) {
		t.Fatalf("update error = %v", err)
	}
	if service.Snapshot().Model != initial.Model {
		t.Fatal("failed update was published")
	}
	store.err = nil
	updated, err := service.Update(map[string]any{"model": "replacement"})
	if err != nil {
		t.Fatal(err)
	}
	updated.ModelChannels[0].Name = "modified by caller"
	initial.ModelChannels[0].Name = "modified input"
	if current := service.Snapshot(); current.Model != "replacement" || current.ModelChannels[0].Name != "Default" {
		t.Fatal("configuration shares mutable state with its caller")
	}
}

func TestConcurrentConfigPatchesPreserveEveryUpdate(t *testing.T) {
	initial := config.Default()
	service := NewConfigService(&configStoreStub{}, &initial)
	var workers sync.WaitGroup
	for i := range 24 {
		workers.Go(func() {
			if _, err := service.Update(map[string]any{fmt.Sprintf("extension%d", i): i}); err != nil {
				t.Error(err)
			}
		})
	}
	workers.Wait()
	current := service.Snapshot()
	for i := range 24 {
		if _, ok := current.Extra[fmt.Sprintf("extension%d", i)]; !ok {
			t.Fatalf("concurrent update %d was lost", i)
		}
	}
}
