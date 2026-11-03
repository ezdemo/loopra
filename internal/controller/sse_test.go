package controller

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type deadlineResponse struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (w *deadlineResponse) SetWriteDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return nil
}

func TestSSEBoundsWritesThroughProductionResponseWrapper(t *testing.T) {
	raw := &deadlineResponse{ResponseRecorder: httptest.NewRecorder()}
	writer := newSSEWriter(&responseRecorder{ResponseWriter: raw})
	started := time.Now()
	writer.sendText("content", "你好")
	if len(raw.deadlines) != 2 || raw.deadlines[0].Before(started) ||
		raw.deadlines[0].After(started.Add(11*time.Second)) || !raw.deadlines[1].IsZero() {
		t.Fatalf("write deadlines = %v", raw.deadlines)
	}
	if !raw.Flushed || !strings.Contains(raw.Body.String(), `data: "你好"`) {
		t.Fatalf("SSE body = %q", raw.Body.String())
	}
}
