package acp

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestFailureReasonPreservesStructuredWriterConflict(t *testing.T) {
	cause := acpsdk.NewInvalidRequest(map[string]any{
		"reason": "thread_active_writer", "threadId": "remote-source",
		"details": "thread remote-source already has an active writer",
	})
	for _, err := range []error{
		cause,
		fmt.Errorf("resume: %w", cause),
		&rpcError{Code: -32600, Message: "busy", Data: json.RawMessage(`{"reason":"thread_active_writer"}`)},
	} {
		failure := TranslateFailure(err)
		if FailureReason(failure) != ReasonThreadActiveWriter {
			t.Fatalf("lost reason: %v", failure)
		}
		if !strings.Contains(failure.Error(), "占用") || !strings.Contains(failure.Error(), "复刻") {
			t.Fatalf("unhelpful message: %v", failure)
		}
		if !errors.Is(failure, err) {
			t.Fatalf("lost underlying error: %v", err)
		}
	}
	for _, err := range []error{
		nil,
		errors.New("thread_active_writer"),
		errors.New("thread remote-source already has an active writer"),
		acpsdk.NewInvalidRequest(nil),
		acpsdk.NewInvalidRequest(map[string]any{"reason": "archived"}),
		acpsdk.NewInternalError(map[string]any{"details": "thread_active_writer"}),
	} {
		if got := FailureReason(err); got != "" {
			t.Fatalf("ordinary error %v classified as %q", err, got)
		}
	}
}

type failureSink struct {
	discardSink
	events   []string
	payload  map[string]any
	fallback string
}

func (s *failureSink) Send(event string, payload any) {
	s.events = append(s.events, event)
	s.payload, _ = payload.(map[string]any)
}
func (s *failureSink) SendError(message string) { s.fallback = message }
func (s *failureSink) Done()                    { s.events = append(s.events, "done") }

func TestSendFailureDeliversWriterReasonBeforeDone(t *testing.T) {
	sink := &failureSink{}
	sendFailure(sink, acpsdk.NewInvalidRequest(map[string]any{"reason": "thread_active_writer"}))
	if strings.Join(sink.events, ",") != "error,done" || sink.payload["reason"] != ReasonThreadActiveWriter {
		t.Fatalf("events = %v, payload = %v", sink.events, sink.payload)
	}
	if sink.fallback != "" {
		t.Fatalf("sent a second error: %s", sink.fallback)
	}
	ordinary := &failureSink{}
	sendFailure(ordinary, errors.New("offline"))
	if ordinary.fallback != "offline" || len(ordinary.events) != 0 {
		t.Fatalf("ordinary failure = %+v", ordinary)
	}
}
