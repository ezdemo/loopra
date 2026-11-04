package tools

import (
	"context"
	"path/filepath"
	"strings"
	"sync"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/session"

	"github.com/ezdemo/looprax/internal/infrastructure/filediff"
)

type fileChangesKey struct{}

type fileChangesRuntime struct {
	mu      sync.Mutex
	pending map[string][]filediff.FileChange
	sink    func([]filediff.FileChange)
}

// WithFileChanges tracks successful native writes separately from model-facing
// tool results. The optional sink reports changes as soon as a write completes.
func WithFileChanges(ctx context.Context, sink func([]filediff.FileChange)) context.Context {
	if ctx.Value(fileChangesKey{}) != nil {
		return ctx
	}
	return context.WithValue(ctx, fileChangesKey{}, &fileChangesRuntime{
		pending: map[string][]filediff.FileChange{}, sink: sink,
	})
}

// WithChildFileChanges gives a child runner its own tool-event metadata while
// collecting the same changes on the parent's sub_agent call for durable replay.
func WithChildFileChanges(ctx agent.Context) context.Context {
	parent, _ := ctx.Value(fileChangesKey{}).(*fileChangesRuntime)
	if parent == nil {
		return WithFileChanges(ctx, nil)
	}
	key := ctx.InvocationID() + "/" + ctx.FunctionCallID()
	child := &fileChangesRuntime{
		pending: map[string][]filediff.FileChange{},
		sink: func(changes []filediff.FileChange) {
			parent.mu.Lock()
			parent.pending[key] = append(parent.pending[key], changes...)
			parent.mu.Unlock()
			if parent.sink != nil {
				parent.sink(changes)
			}
		},
	}
	return context.WithValue(ctx, fileChangesKey{}, child)
}

func reportFileChange(ctx agent.Context, root, abs string, before *string, after string) {
	r, _ := ctx.Value(fileChangesKey{}).(*fileChangesRuntime)
	if r == nil || (before != nil && *before == after) {
		return
	}
	path, err := filepath.Rel(root, abs)
	if err != nil || path == ".." || strings.HasPrefix(path, ".."+string(filepath.Separator)) {
		path = abs
	}
	change := filediff.CompareFile(filepath.ToSlash(path), before, after)
	key := ctx.InvocationID() + "/" + ctx.FunctionCallID()
	r.mu.Lock()
	r.pending[key] = append(r.pending[key], change)
	r.mu.Unlock()
	if r.sink != nil {
		r.sink([]filediff.FileChange{change})
	}
}

// AttachFileChanges adds UI metadata to the durable tool event, without adding
// the full diff to the tool response sent back to the model.
func AttachFileChanges(ctx context.Context, event *session.Event) {
	if ctx == nil || event == nil || event.Partial || event.Content == nil {
		return
	}
	r, _ := ctx.Value(fileChangesKey{}).(*fileChangesRuntime)
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var changes []filediff.FileChange
	for _, part := range event.Content.Parts {
		if part == nil || part.FunctionResponse == nil {
			continue
		}
		key := event.InvocationID + "/" + part.FunctionResponse.ID
		changes = append(changes, r.pending[key]...)
		delete(r.pending, key)
	}
	if len(changes) > 0 {
		if event.CustomMetadata == nil {
			event.CustomMetadata = map[string]any{}
		}
		event.CustomMetadata["fileChanges"] = changes
	}
}
