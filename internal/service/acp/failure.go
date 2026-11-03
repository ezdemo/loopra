package acp

import (
	"encoding/json"
	"errors"

	acpsdk "github.com/coder/acp-go-sdk"
)

const ReasonThreadActiveWriter = "thread_active_writer"

// FailureReason preserves the adapter's structured failure reason. A generic
// invalid-request error or an error message mentioning a lock is not enough.
func FailureReason(err error) string {
	var data any
	var request *acpsdk.RequestError
	var legacy *rpcError
	switch {
	case errors.As(err, &request) && request != nil:
		data = request.Data
	case errors.As(err, &legacy) && legacy != nil:
		data = legacy.Data
	default:
		return ""
	}
	raw, marshalErr := json.Marshal(data)
	if marshalErr != nil {
		return ""
	}
	var details struct {
		Reason string `json:"reason"`
	}
	if json.Unmarshal(raw, &details) != nil || details.Reason != ReasonThreadActiveWriter {
		return ""
	}
	return details.Reason
}

type occupiedFailure struct{ cause error }

func (e *occupiedFailure) Error() string {
	return "当前 Codex 会话已被其他客户端占用，请关闭那边的会话后重试，或复刻为新会话继续"
}

func (e *occupiedFailure) Unwrap() error { return e.cause }

func sendFailure(sink EventSink, err error) {
	failure := TranslateFailure(err)
	if reason := FailureReason(failure); reason != "" {
		sink.Send("error", map[string]any{"error": failure.Error(), "reason": reason})
		sink.Done()
		return
	}
	sink.SendError(failure.Error())
}
