package provider

import (
	"errors"
	"testing"

	"google.golang.org/adk/v2/model"
)

func TestOutgoingBodyReplacement(t *testing.T) {
	req := &model.LLMRequest{Model: "demo"}
	SetWireBody(req, map[string]any{"model": "custom"})
	body, err := outgoingBody(req, map[string]any{"model": "built"}, nil)
	if err != nil || body["model"] != "custom" {
		t.Fatalf("body = %#v %v", body, err)
	}
	body, err = outgoingBody(req, map[string]any{"model": "built"}, nil)
	if err != nil || body["model"] != "built" {
		t.Fatalf("second body = %#v %v", body, err)
	}

	SetWireBody(req, map[string]any{"keep": true})
	if _, err := outgoingBody(req, nil, errors.New("encode")); err == nil || err.Error() != "encode" {
		t.Fatalf("err = %v", err)
	}
	if _, ok := TakeWireBody(req); ok {
		t.Fatal("wire body leaked after a failed encode")
	}
	SetWireBody(nil, map[string]any{"x": 1})
	if _, ok := TakeWireBody(nil); ok {
		t.Fatal("nil request stored a body")
	}
}
