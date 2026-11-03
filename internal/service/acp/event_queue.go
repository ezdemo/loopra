package acp

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"

	acpsdk "github.com/coder/acp-go-sdk"

	"github.com/ezdemo/looprax/internal/infrastructure/logging"
)

const (
	maxTurnEvents     = 8192
	maxTurnEventBytes = 32 << 20
	maxMergedText     = 16 << 10
)

type queuedTurnEvent struct {
	event Event
	bytes int
	seq   uint64
}

// turnEvents keeps SDK callbacks independent of SSE and disk latency. A single
// worker preserves order; limits bound both tiny-event bursts and large payloads.
// Overflow cancels the turn explicitly rather than dropping output or blocking
// the SDK's own notification consumer.
type turnEvents struct {
	mu        sync.Mutex
	queue     []queuedTurnEvent
	head      int
	bytes     int
	next      uint64
	completed uint64
	closed    bool
	err       error
	wake      chan struct{}
	progress  chan struct{}
	done      chan struct{}
	cancel    context.CancelCauseFunc
	handle    func(Event)
}

func newTurnEvents(handle func(Event), cancel context.CancelCauseFunc) *turnEvents {
	q := &turnEvents{
		wake: make(chan struct{}, 1), progress: make(chan struct{}),
		done: make(chan struct{}), handle: handle, cancel: cancel,
	}
	go q.run()
	return q
}

func (q *turnEvents) push(event Event) {
	var size int
	if event.notification != nil {
		// Walk already decoded data rather than encoding large tool payloads a
		// second time on the SDK goroutine. Include container overhead so the
		// limit bounds retained memory rather than just output text.
		size = retainedBytes(reflect.ValueOf(event.notification), 0)
	} else {
		data, err := json.Marshal(event)
		if err != nil {
			q.fail(err)
			return
		}
		size = len(data)
	}
	q.mu.Lock()
	if q.closed || q.err != nil {
		q.mu.Unlock()
		return
	}
	if q.bytes+size > maxTurnEventBytes {
		q.mu.Unlock()
		q.fail(ErrEventBacklog)
		return
	}
	if len(q.queue) > q.head {
		last := &q.queue[len(q.queue)-1]
		if mergeTurnText(&last.event, event) {
			q.next++
			last.bytes += size
			last.seq = q.next
			q.bytes += size
			q.mu.Unlock()
			return
		}
	}
	if len(q.queue)-q.head >= maxTurnEvents {
		q.mu.Unlock()
		q.fail(ErrEventBacklog)
		return
	}
	q.next++
	q.queue = append(q.queue, queuedTurnEvent{event: event, bytes: size, seq: q.next})
	q.bytes += size
	q.mu.Unlock()
	q.signal()
}

func mergeTurnText(last *Event, event Event) bool {
	if last.notification != nil || event.notification != nil {
		if last.notification == nil || event.notification == nil || last.source != event.source ||
			last.notification.SessionId != event.notification.SessionId {
			return false
		}
		leftKind, left, leftID := notificationText(last.notification)
		rightKind, right, rightID := notificationText(event.notification)
		if left == nil || right == nil || leftKind != rightKind || leftID != rightID || len(left.Text)+len(right.Text) > maxMergedText {
			return false
		}
		// Do not mutate the SDK-owned content pointers retained by the caller.
		text := *left
		text.Text += right.Text
		if leftKind == EventContent {
			chunk := *last.notification.Update.AgentMessageChunk
			chunk.Content.Text = &text
			last.notification.Update.AgentMessageChunk = &chunk
		} else {
			chunk := *last.notification.Update.AgentThoughtChunk
			chunk.Content.Text = &text
			last.notification.Update.AgentThoughtChunk = &chunk
		}
		return true
	}
	if (event.Kind == EventContent || event.Kind == EventReason) && last.Kind == event.Kind &&
		last.Meta == nil && event.Meta == nil && last.SubSession == event.SubSession &&
		len(last.Text)+len(event.Text) <= maxMergedText {
		last.Text += event.Text
		return true
	}
	return false
}

func notificationText(n *acpsdk.SessionNotification) (EventKind, *acpsdk.ContentBlockText, string) {
	if n.Meta != nil {
		return "", nil, ""
	}
	var kind EventKind
	var content acpsdk.ContentBlock
	var meta map[string]any
	var messageID *string
	switch {
	case n.Update.AgentMessageChunk != nil:
		chunk := n.Update.AgentMessageChunk
		kind, content, meta, messageID = EventContent, chunk.Content, chunk.Meta, chunk.MessageId
	case n.Update.AgentThoughtChunk != nil:
		chunk := n.Update.AgentThoughtChunk
		kind, content, meta, messageID = EventReason, chunk.Content, chunk.Meta, chunk.MessageId
	default:
		return "", nil, ""
	}
	if meta != nil || content.Text == nil || content.Text.Meta != nil || content.Text.Annotations != nil {
		return "", nil, ""
	}
	id := ""
	if messageID != nil {
		id = *messageID
	}
	return kind, content.Text, id
}

func retainedBytes(value reflect.Value, depth int) int {
	if !value.IsValid() {
		return 0
	}
	if depth > 64 {
		return maxTurnEventBytes + 1
	}
	switch value.Kind() {
	case reflect.Interface, reflect.Pointer:
		if value.IsNil() {
			return 8
		}
		return 8 + retainedBytes(value.Elem(), depth+1)
	case reflect.String:
		return 16 + value.Len()
	case reflect.Slice, reflect.Array:
		size := 24
		if value.Type().Elem().Kind() == reflect.Uint8 {
			return size + value.Len()
		}
		for i := 0; i < value.Len(); i++ {
			size += retainedBytes(value.Index(i), depth+1)
			if size > maxTurnEventBytes {
				break
			}
		}
		return size
	case reflect.Map:
		size := 48
		iter := value.MapRange()
		for iter.Next() {
			size += 32 + retainedBytes(iter.Key(), depth+1) + retainedBytes(iter.Value(), depth+1)
			if size > maxTurnEventBytes {
				break
			}
		}
		return size
	case reflect.Struct:
		size := 0
		for i := 0; i < value.NumField(); i++ {
			size += retainedBytes(value.Field(i), depth+1)
			if size > maxTurnEventBytes {
				break
			}
		}
		return size
	default:
		return int(value.Type().Size())
	}
}

func (q *turnEvents) fail(err error) {
	q.mu.Lock()
	if q.err == nil {
		q.err = err
		count, bytes := len(q.queue)-q.head, q.bytes
		q.cancel(err)
		q.mu.Unlock()
		logging.Warnf("acp", "turn notification backlog stopped queued=%d bytes=%d err=%v", count, bytes, err)
		return
	}
	q.mu.Unlock()
}

func (q *turnEvents) signal() {
	select {
	case q.wake <- struct{}{}:
	default:
	}
}

func (q *turnEvents) run() {
	defer close(q.done)
	for {
		q.mu.Lock()
		if q.head == len(q.queue) {
			q.queue, q.head = nil, 0
			closed := q.closed
			q.mu.Unlock()
			if closed {
				return
			}
			<-q.wake
			continue
		}
		item := q.queue[q.head]
		q.queue[q.head] = queuedTurnEvent{}
		q.head++
		q.bytes -= item.bytes
		// Reclaim consumed slots even if the producer never becomes idle.
		if q.head >= 1024 && q.head*2 >= len(q.queue) {
			q.queue = append([]queuedTurnEvent(nil), q.queue[q.head:]...)
			q.head = 0
		}
		q.mu.Unlock()
		q.handle(item.event)
		q.mu.Lock()
		q.completed = item.seq
		close(q.progress)
		q.progress = make(chan struct{})
		q.mu.Unlock()
	}
}

// wait observes a watermark, not an empty queue: later updates cannot starve an
// approval waiting for the tool/subagent information received before it.
func (q *turnEvents) wait(ctx context.Context) error {
	q.mu.Lock()
	target := q.next
	for q.completed < target {
		progress := q.progress
		q.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-progress:
		}
		q.mu.Lock()
	}
	err := q.err
	q.mu.Unlock()
	return err
}

func (q *turnEvents) finish() error {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.signal()
	<-q.done
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.err
}
