package provider

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/genai"
)

func TestChatCompletionsMiMoToolSchema(t *testing.T) {
	type nested struct {
		Files []string `json:"files"`
	}
	type input struct {
		Globs []string `json:"globs,omitempty"`
		Edits []nested `json:"edits"`
	}
	generated, err := jsonschema.For[input](nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, modelName := range []string{"xiaomi/mimo-v2.6-flash", "mimo-v2.6-flash", "test-model"} {
		for _, representation := range []string{"generated", "map"} {
			t.Run(modelName+"/"+representation, func(t *testing.T) {
				var schema any = generated
				if representation == "map" {
					schema, _ = jsonSchemaMap(generated)
				}
				before, _ := json.Marshal(schema)
				srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}`))
				})
				llm, err := NewLLM(testChannel(ProtocolChatCompletions, srv.URL), &Options{})
				if err != nil {
					t.Fatal(err)
				}
				req := reqWith([]*genai.Content{userContent("search")}, &genai.FunctionDeclaration{Name: "rg", ParametersJsonSchema: schema})
				req.Model = modelName
				if _, err := collectLLM(llm, req, false); err != nil {
					t.Fatal(err)
				}
				params := (*body)["tools"].([]any)[0].(map[string]any)["function"].(map[string]any)["parameters"].(map[string]any)
				props := params["properties"].(map[string]any)
				globs := props["globs"].(map[string]any)
				edits := props["edits"].(map[string]any)
				files := edits["items"].(map[string]any)["properties"].(map[string]any)["files"].(map[string]any)
				for _, property := range []map[string]any{globs, edits, files} {
					if modelName == "test-model" {
						if !reflect.DeepEqual(property["type"], []any{"null", "array"}) {
							t.Fatalf("unaffected model type changed: %v", property["type"])
						}
					} else if property["type"] != "array" {
						t.Fatalf("MiMo received nullable array: %v", property["type"])
					}
				}
				if !reflect.DeepEqual(params["required"], []any{"edits"}) {
					t.Fatalf("required fields changed: %v", params["required"])
				}
				after, _ := json.Marshal(schema)
				if string(before) != string(after) {
					t.Fatal("shared tool declaration was mutated")
				}
			})
		}
	}
}

func TestMiMoSchemaPreservesLiteralValuesAndOtherUnions(t *testing.T) {
	literal := map[string]any{"type": []any{"null", "array"}}
	schema := map[string]any{
		"type":    "object",
		"default": literal,
		"enum":    []any{literal},
		"properties": map[string]any{
			"type":    map[string]any{"type": []any{"null", "string"}},
			"value":   map[string]any{"type": []any{"null", "string", "integer"}},
			"nothing": map[string]any{"type": []any{"null"}},
		},
		"$defs": map[string]any{"values": map[string]any{"type": []string{"array", "null"}}},
	}
	got := compatibleChatToolSchema("xiaomi/mimo-v2.6-flash", schema)
	if !reflect.DeepEqual(got["default"], literal) || !reflect.DeepEqual(got["enum"], []any{literal}) {
		t.Fatal("literal schema-shaped values changed")
	}
	props := got["properties"].(map[string]any)
	if props["type"].(map[string]any)["type"] != "string" {
		t.Fatal("property named type was not normalized")
	}
	if !reflect.DeepEqual(props["value"].(map[string]any)["type"], []any{"string", "integer"}) {
		t.Fatal("non-null union alternatives were lost")
	}
	if !reflect.DeepEqual(props["nothing"].(map[string]any)["type"], []any{"null"}) {
		t.Fatal("null-only type was changed")
	}
	if got["$defs"].(map[string]any)["values"].(map[string]any)["type"] != "array" {
		t.Fatal("referenced definition was not normalized")
	}
}
