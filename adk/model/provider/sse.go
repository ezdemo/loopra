// Package provider 以 google.golang.org/adk/v2 的 model.LLM 实现
// 提供 Loopra 的模型通道协议（OpenAI Chat Completions、
// OpenAI Responses、Anthropic Messages）。
package provider

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
)

// maxSSEEventBytes 按 Java 传输层的方式限制单个 SSE 事件大小。
const maxSSEEventBytes = 4 << 20

// errStopRead 终止 SSE 读取循环且不报错；用于消费者
// 停止接收事件或已收到终止帧的场景。
var errStopRead = errors.New("stop SSE read")

// sseEvent 是一个已解码的 Server-Sent Event 帧。
type sseEvent struct {
	Type string
	ID   string
	Data string
}

// readSSE 解码 SSE 响应体，单次模型调用内不重连。
// 多行 data 字段会被拼接；超过 maxSSEEventBytes 的
// 事件会被拒绝。callback 返回错误会中止流，
// 并成为读取错误。
func readSSE(ctx context.Context, src io.Reader, callback func(sseEvent) error) error {
	if callback == nil {
		return errors.New("SSE callback is required")
	}
	scan := bufio.NewScanner(src)
	scan.Buffer(make([]byte, 4096), maxSSEEventBytes+1)
	var event sseEvent
	var data strings.Builder
	size := 0
	dispatch := func() error {
		if data.Len() == 0 {
			event = sseEvent{}
			data.Reset()
			size = 0
			return nil
		}
		event.Data = strings.TrimSuffix(data.String(), "\n")
		err := callback(event)
		event = sseEvent{}
		data.Reset()
		size = 0
		return err
	}
	for scan.Scan() {
		if err := ctx.Err(); err != nil {
			return err
		}
		line := scan.Text()
		size += len(line) + 1
		if size > maxSSEEventBytes {
			return fmt.Errorf("SSE event exceeded %d bytes", maxSSEEventBytes)
		}
		if line == "" {
			if err := dispatch(); err != nil {
				return err
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		} else {
			value = strings.TrimPrefix(value, " ")
		}
		switch field {
		case "event":
			event.Type = value
		case "id":
			if !strings.ContainsRune(value, '\x00') {
				event.ID = value
			}
		case "data":
			data.WriteString(value)
			data.WriteByte('\n')
		}
	}
	if err := scan.Err(); err != nil {
		return fmt.Errorf("read SSE: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return dispatch()
}
