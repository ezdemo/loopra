package openapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestSourceLifecycleAndInvocation(t *testing.T) {
	var upstream *httptest.Server
	var calls atomic.Int32
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("missing source authentication")
		}
		if r.URL.Path == "/spec" {
			fmt.Fprintf(w, `openapi: 3.0.3
servers:
  - url: %s/api
paths:
  /orders/{id}:
    parameters:
      - $ref: '#/components/parameters/id'
    post:
      operationId: updateOrder
      summary: 订单更新
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Order'
      responses:
        '200':
          description: updated
components:
  parameters:
    id:
      name: id
      in: path
      required: true
      schema:
        type: string
  schemas:
    Order:
      type: object
      properties:
        title:
          type: string
`, upstream.URL)
			return
		}
		calls.Add(1)
		if r.URL.EscapedPath() != "/api/orders/a%%2Fb" && r.URL.EscapedPath() != "/api/orders/a%2Fb" {
			t.Errorf("path=%s", r.URL.EscapedPath())
		}
		if r.Method != "POST" || r.URL.Query().Get("tag") != "new" {
			t.Errorf("request=%s %s", r.Method, r.URL)
		}
		raw, _ := io.ReadAll(r.Body)
		if string(raw) != `{"title":"hello"}` {
			t.Errorf("body=%s", raw)
		}
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"updated":true}`)
	}))
	defer upstream.Close()
	home := t.TempDir()
	s := New(home)
	ctx := context.Background()
	docURL := upstream.URL + "/spec"
	source := map[string]any{"docUrl": docURL, "authType": "bearer", "authConfig": map[string]any{"token": "test-token"}}
	if _, err := s.Request(ctx, "save", source); err != nil {
		t.Fatal(err)
	}
	// A fresh service must load the same persisted sources and cached YAML.
	s = New(home)
	out, err := s.Request(ctx, "search", map[string]any{"keyword": "订单 更新"})
	if err != nil {
		t.Fatal(err)
	}
	results := out.([]map[string]any)
	if len(results) != 1 {
		t.Fatalf("search=%v", out)
	}
	args := map[string]any{"docUrl": docURL, "path": "/orders/{id}", "method": "POST"}
	out, err = s.Request(ctx, "detail", args)
	if err != nil {
		t.Fatal(err)
	}
	detail := out.(map[string]any)
	encoded, _ := json.Marshal(detail)
	if strings.Contains(string(encoded), "$ref") || !strings.Contains(string(encoded), "title") || len(array(detail["parameters"])) != 1 {
		t.Fatalf("detail=%s", encoded)
	}
	if _, err = s.Request(ctx, "call", args); err == nil {
		t.Fatal("missing required params accepted")
	}
	if calls.Load() != 0 {
		t.Fatal("invalid invocation reached upstream")
	}
	args["pathParams"] = map[string]any{"id": "a/b"}
	args["query"] = map[string]any{"tag": "new"}
	args["body"] = map[string]any{"title": "hello"}
	out, err = s.Request(ctx, "call", args)
	if err != nil {
		t.Fatal(err)
	}
	if out.(map[string]any)["status"] != 200 || calls.Load() != 1 {
		t.Fatalf("call=%v", out)
	}
	args["path"] = "/undeclared"
	if _, err = s.Request(ctx, "call", args); err == nil {
		t.Fatal("undeclared operation accepted")
	}
	if _, err = s.Request(ctx, "remove", map[string]any{"docUrl": docURL}); err != nil {
		t.Fatal(err)
	}
	out, err = s.Request(ctx, "sources", nil)
	if err != nil || len(out.([]Source)) != 0 {
		t.Fatalf("remove=%v %v", out, err)
	}
}

func TestLegacyApiKeyAndCrossOriginRedirect(t *testing.T) {
	var stolen atomic.Int32
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { stolen.Add(1) }))
	defer receiver.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") != "secret" {
			t.Error("legacy apiKey auth was not applied")
		}
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, receiver.URL, 302)
			return
		}
		io.WriteString(w, `{"swagger":"2.0","paths":{}}`)
	}))
	defer origin.Close()
	s := New(t.TempDir())
	input := map[string]any{"docUrl": origin.URL, "authType": "apiKey", "authConfig": map[string]any{"name": "X-API-Key", "value": "secret"}}
	if _, err := s.Request(context.Background(), "save", input); err != nil {
		t.Fatal(err)
	}
	input["docUrl"] = origin.URL + "/redirect"
	if _, err := s.Request(context.Background(), "save", input); err == nil {
		t.Fatal("cross-origin redirect accepted")
	}
	if stolen.Load() != 0 {
		t.Fatal("credentials sent to another host")
	}
}
