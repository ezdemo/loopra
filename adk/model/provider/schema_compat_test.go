package provider

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"google.golang.org/genai"
)

func TestToolSchemaNormalizationAcrossProtocolsAndModels(t *testing.T) {
	type nested struct {
		Files []string `json:"files"`
	}
	type input struct {
		Globs    []string          `json:"globs,omitempty"`
		Edits    []nested          `json:"edits"`
		Metadata map[string]string `json:"metadata,omitempty"`
		Reset    *string           `json:"reset,omitempty"`
	}
	generated, err := jsonschema.For[input](nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, protocol := range []string{ProtocolChatCompletions, ProtocolResponses, ProtocolAnthropic} {
		for _, modelName := range []string{"xiaomi/mimo-v2.6-flash", "another-provider/model-v1"} {
			for _, representation := range []string{"generated", "map"} {
				t.Run(protocol+"/"+modelName+"/"+representation, func(t *testing.T) {
					var schema any = generated
					if representation == "map" {
						schema, _ = jsonSchemaMap(generated)
					}
					before, _ := json.Marshal(schema)
					srv, body, _ := captureRequest(t, func(w http.ResponseWriter) {
						w.Header().Set("Content-Type", "application/json")
						_, _ = w.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"output":[],"content":[],"usage":{}}`))
					})
					llm, err := NewLLM(testChannel(protocol, srv.URL), &Options{})
					if err != nil {
						t.Fatal(err)
					}
					req := reqWith([]*genai.Content{userContent("search")}, &genai.FunctionDeclaration{Name: "rg", ParametersJsonSchema: schema})
					req.Model = modelName
					if _, err := collectLLM(llm, req, false); err != nil {
						t.Fatal(err)
					}
					fn := (*body)["tools"].([]any)[0].(map[string]any)
					parameterKey := "parameters"
					if protocol == ProtocolChatCompletions {
						fn = fn["function"].(map[string]any)
					} else if protocol == ProtocolAnthropic {
						parameterKey = "input_schema"
					}
					params := fn[parameterKey].(map[string]any)
					props := params["properties"].(map[string]any)
					globs := props["globs"].(map[string]any)
					edits := props["edits"].(map[string]any)
					files := edits["items"].(map[string]any)["properties"].(map[string]any)["files"].(map[string]any)
					for _, property := range []map[string]any{globs, edits, files} {
						if property["type"] != "array" {
							t.Fatalf("received nullable array: %v", property["type"])
						}
					}
					if props["metadata"].(map[string]any)["type"] != "object" {
						t.Fatal("received nullable map")
					}
					if !reflect.DeepEqual(props["reset"].(map[string]any)["type"], []any{"null", "string"}) {
						t.Fatal("nullable scalar lost its null alternative")
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
}

func TestToolSchemaPreservesLiteralValuesAndNullSemantics(t *testing.T) {
	literal := map[string]any{"type": []any{"null", "array"}}
	schema := map[string]any{
		"type":    "object",
		"default": literal,
		"enum":    []any{literal},
		"properties": map[string]any{
			"type":         map[string]any{"type": []any{"null", "array"}},
			"value":        map[string]any{"type": []any{"null", "string", "integer"}},
			"nothing":      map[string]any{"type": []any{"null"}},
			"null_default": map[string]any{"type": []any{"null", "array"}, "default": nil},
			"null_const":   map[string]any{"type": []any{"null", "object"}, "const": nil},
			"null_enum":    map[string]any{"type": []any{"null", "object"}, "enum": []any{nil, map[string]any{}}},
		},
		"$defs": map[string]any{"values": map[string]any{"type": []string{"array", "null"}}},
	}
	got := functionParameters(&genai.FunctionDeclaration{ParametersJsonSchema: schema})
	if !reflect.DeepEqual(got["default"], literal) || !reflect.DeepEqual(got["enum"], []any{literal}) {
		t.Fatal("literal schema-shaped values changed")
	}
	props := got["properties"].(map[string]any)
	if props["type"].(map[string]any)["type"] != "array" {
		t.Fatal("property named type was not normalized")
	}
	if !reflect.DeepEqual(props["value"].(map[string]any)["type"], []any{"null", "string", "integer"}) {
		t.Fatal("union alternatives were lost")
	}
	if !reflect.DeepEqual(props["nothing"].(map[string]any)["type"], []any{"null"}) {
		t.Fatal("null-only type was changed")
	}
	if got["$defs"].(map[string]any)["values"].(map[string]any)["type"] != "array" {
		t.Fatal("referenced definition was not normalized")
	}
	for _, key := range []string{"null_default", "null_const", "null_enum"} {
		if !reflect.DeepEqual(props[key], schema["properties"].(map[string]any)[key]) {
			t.Fatalf("explicit null constraint changed: %s", key)
		}
	}
}
