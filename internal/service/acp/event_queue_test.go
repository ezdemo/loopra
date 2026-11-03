package acp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	acpsdk "github.com/coder/acp-go-sdk"
)

func TestTurnEventsBurstDrainsInOrderBeforeFinish(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	entered, release := make(chan struct{}), make(chan struct{})
	var got []string
	q := newTurnEvents(func(event Event) {
		if len(got) == 0 {
			close(entered)
			<-release
		}
		got = append(got, event.Text)
	}, cancel)
	q.push(Event{Kind: EventContent, Text: "first", Meta: map[string]any{"keep": true}})
	<-entered
	for i := 0; i < 4096; i++ {
		q.push(Event{Kind: EventContent, Text: fmt.Sprint(i), Meta: map[string]any{"keep": true}})
	}
	if ctx.Err() != nil {
		t.Fatal(context.Cause(ctx))
	}
	finished := make(chan error, 1)
	go func() { finished <- q.finish() }()
	select {
	case <-finished:
		t.Fatal("finish returned while an accepted event was blocked")
	default:
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if len(got) != 4097 {
		t.Fatalf("processed %d events", len(got))
	}
	for i := 0; i < 4096; i++ {
		if got[i+1] != fmt.Sprint(i) {
			t.Fatalf("out of order at %d: %q", i, got[i+1])
		}
	}
	q.push(Event{Kind: EventContent, Text: "late"})
	if len(got) != 4097 {
		t.Fatal("closed turn accepted a late event")
	}
}

func TestTurnEventsMergeOnlyAdjacentTextWithSameRoute(t *testing.T) {
	_, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	entered, release := make(chan struct{}), make(chan struct{})
	var got []Event
	q := newTurnEvents(func(event Event) {
		if len(got) == 0 {
			close(entered)
			<-release
		}
		got = append(got, event)
	}, cancel)
	q.push(Event{Kind: EventPlan})
	<-entered
	q.push(Event{Kind: EventContent, Text: "你"})
	q.push(Event{Kind: EventContent, Text: "好"})
	q.push(Event{Kind: EventContent, Text: "child", SubSession: "child"})
	q.push(Event{Kind: EventReason, Text: "reason"})
	q.push(Event{Kind: EventToolCall})
	q.push(Event{Kind: EventContent, Text: "after"})
	close(release)
	if err := q.finish(); err != nil {
		t.Fatal(err)
	}
	if len(got) != 6 || got[1].Text != "你好" || got[2].SubSession != "child" || got[5].Text != "after" {
		t.Fatalf("merged events = %+v", got)
	}
}

func TestTurnEventsOverflowCancelsWithoutBlockingAndDrainsAcceptedEvents(t *testing.T) {
	for _, byteLimit := range []bool{false, true} {
		t.Run(fmt.Sprint("bytes=", byteLimit), func(t *testing.T) {
			ctx, cancel := context.WithCancelCause(context.Background())
			defer cancel(nil)
			entered, release := make(chan struct{}), make(chan struct{})
			count := 0
			q := newTurnEvents(func(Event) {
				if count == 0 {
					close(entered)
					<-release
				}
				count++
			}, cancel)
			q.push(Event{Kind: EventPlan})
			<-entered
			want := 1
			if byteLimit {
				q.push(Event{Kind: EventNative, NativeData: []byte(`"` + strings.Repeat("x", maxTurnEventBytes) + `"`)})
			} else {
				for i := 0; i <= maxTurnEvents; i++ {
					q.push(Event{Kind: EventPlan})
				}
				want += maxTurnEvents
			}
			if !errors.Is(context.Cause(ctx), ErrEventBacklog) {
				t.Fatalf("cause = %v", context.Cause(ctx))
			}
			close(release)
			if !errors.Is(q.finish(), ErrEventBacklog) || count != want {
				t.Fatalf("accepted events processed = %d, want %d", count, want)
			}
		})
	}
}

func TestTurnEventsApprovalWaitCanBeCancelled(t *testing.T) {
	_, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	release := make(chan struct{})
	q := newTurnEvents(func(Event) { <-release }, cancel)
	q.push(Event{Kind: EventToolCall})
	ctx, stop := context.WithCancel(context.Background())
	stop()
	if !errors.Is(q.wait(ctx), context.Canceled) {
		t.Fatal("approval barrier ignored cancellation")
	}
	close(release)
	if err := q.finish(); err != nil {
		t.Fatal(err)
	}
	ctx, stop = context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := q.wait(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestTurnEventsSDKTextMergingPreservesMetadataAndCallerData(t *testing.T) {
	makeEvent := func(text, session string) Event {
		return Event{notification: &acpsdk.SessionNotification{
			SessionId: acpsdk.SessionId(session), Update: acpsdk.UpdateAgentMessageText(text),
		}}
	}
	first, second := makeEvent("你", "s"), makeEvent("好", "s")
	original := first.notification.Update.AgentMessageChunk
	if !mergeTurnText(&first, second) || first.notification.Update.AgentMessageChunk.Content.Text.Text != "你好" {
		t.Fatal("adjacent SDK text was not merged")
	}
	if original.Content.Text.Text != "你" {
		t.Fatal("merging mutated SDK-owned content")
	}
	if mergeTurnText(&first, makeEvent("child", "other")) {
		t.Fatal("merged different sessions")
	}
	second.notification.Update.AgentMessageChunk.Meta = map[string]any{"parentToolUseId": "parent"}
	if mergeTurnText(&first, second) {
		t.Fatal("merged a subagent/native update with plain text")
	}
}

func TestTurnCancellationReleasesApprovalBarrier(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	release := make(chan struct{})
	q := newTurnEvents(func(Event) { <-release }, cancel)
	q.push(Event{Kind: EventToolCall})
	turn := &acpTurn{runCtx: ctx, events: q}
	conn := &Conn{turn: turn}
	cancel(ErrEventBacklog)
	done := make(chan bool, 1)
	go func() {
		_, ok := conn.requestPermission(context.Background(), PermissionRequest{})
		done <- ok
	}()
	select {
	case ok := <-done:
		if ok {
			t.Fatal("cancelled turn accepted an approval")
		}
	case <-time.After(time.Second):
		t.Fatal("approval barrier outlived its turn")
	}
	close(release)
	_ = q.finish()
}
