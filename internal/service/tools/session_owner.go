package tools

import (
	"context"

	"google.golang.org/adk/v2/agent"
)

// SessionOwner identifies a conversation across the process-wide shell registry.
// The zero value is reserved for administrative queries over all conversations.
type SessionOwner struct {
	Workspace string
	Session   string
}

type sessionOwnerKey struct{}

// WithSessionOwner lets child agents keep their parent conversation's ownership.
func WithSessionOwner(ctx context.Context, owner SessionOwner) context.Context {
	if ctx == nil || owner.Session == "" {
		return ctx
	}
	return context.WithValue(ctx, sessionOwnerKey{}, owner)
}

func sessionOwner(ctx agent.Context) SessionOwner {
	if ctx == nil {
		return SessionOwner{}
	}
	if owner, ok := ctx.Value(sessionOwnerKey{}).(SessionOwner); ok {
		return owner
	}
	return SessionOwner{Workspace: ctx.AppName(), Session: ctx.SessionID()}
}
