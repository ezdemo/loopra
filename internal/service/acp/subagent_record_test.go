package acp

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestACPTurn(t *testing.T) (*acpTurn, string) {
	t.Helper()
	dir := t.TempDir()
	return &acpTurn{
		sink:   discardSink{},
		subRec: newACPSubAgentRecorder(dir),
		state:  newACPSharedState(),
		tools:  map[string]*acpTool{},
	}, dir
}

type discardSink struct{}

func (discardSink) Send(string, any)        {}
func (discardSink) SendText(string, string) {}
func (discardSink) SendRaw(string, []byte)  {}
func (discardSink) SendError(string)        {}
func (discardSink) Done()                   {}

func readSubEvents(path string) ([]map[string]any, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []map[string]any
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, scanner.Err()
}

func TestACPSubAgentEventsPersisted(t *testing.T) {
	turn, dir := newTestACPTurn(t)
	parent := "task-1"
	turn.tools[parent] = &acpTool{name: "Agent", rawInput: map[string]any{
		"description":   "梳理项目模块结构",
		"subagent_type": "Explore",
		"prompt":        "看看项目结构",
	}}
	turn.handleSub(parent, Event{Kind: EventContent, Text: "hello"})
	turn.handleSub(parent, Event{Kind: EventContent, Text: " world"})
	turn.finish()

	events, err := readSubEvents(filepath.Join(dir, subSessionID(parent)+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) < 2 {
		t.Fatalf("events = %+v", events)
	}
	if events[0]["type"] != "sub_start" {
		t.Fatalf("first = %+v", events[0])
	}
	if events[0]["task"] != "梳理项目模块结构" || events[0]["name"] != "Explore" ||
		events[0]["title"] != "梳理项目模块结构" {
		t.Fatalf("start = %+v", events[0])
	}
	if events[1]["type"] != "sub_content" || events[1]["token"] != "hello world" {
		t.Fatalf("content = %+v", events[1])
	}
	if events[1]["subSessionId"] != subSessionID(parent) {
		t.Fatalf("subSessionId = %v", events[1])
	}
}

func TestACPSubAgentEndStatusAndError(t *testing.T) {
	turn, dir := newTestACPTurn(t)
	parent := "task-2"
	turn.handleSub(parent, Event{Kind: EventContent, Text: "work"})
	turn.finishSubAgent(parent, true, "boom")
	turn.finish()

	events, err := readSubEvents(filepath.Join(dir, subSessionID(parent)+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	last := events[len(events)-1]
	if last["type"] != "sub_end" || last["status"] != "error" || last["error"] != "boom" {
		t.Fatalf("end = %+v", last)
	}
	turn.finishSubAgent(parent, false, nil)
	turn.finish()
	events, err = readSubEvents(filepath.Join(dir, subSessionID(parent)+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	endCount := 0
	for _, event := range events {
		if event["type"] == "sub_end" {
			endCount++
		}
	}
	if endCount != 1 {
		t.Fatalf("sub_end count = %d", endCount)
	}
}

func TestACPCancelEndsActiveSubAgents(t *testing.T) {
	turn, dir := newTestACPTurn(t)
	parent := "task-3"
	turn.handleSub(parent, Event{Kind: EventContent, Text: "work"})
	turn.endActiveSubAgents("aborted")
	turn.finish()

	events, err := readSubEvents(filepath.Join(dir, subSessionID(parent)+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	last := events[len(events)-1]
	if last["type"] != "sub_end" || last["status"] != "aborted" {
		t.Fatalf("end = %+v", last)
	}
}
