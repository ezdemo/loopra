package provider

import "google.golang.org/genai"

// functionParameters is the shared model-facing schema boundary for every
// protocol. Go's schema generator allows null for nil slices and maps, but tool
// parsers may require a concrete array/object type. Optional arguments can be
// omitted; required collections should be supplied as collections. Keep the
// execution schema intact, and preserve nullable scalars, real unions and
// explicit null defaults/constraints instead of globally discarding null.
func functionParameters(d *genai.FunctionDeclaration) map[string]any {
	var schema map[string]any
	switch {
	case d.Parameters != nil:
		schema = schemaMap(d.Parameters)
	case d.ParametersJsonSchema != nil:
		schema, _ = jsonSchemaMap(d.ParametersJsonSchema)
	}
	if schema == nil {
		schema = emptyObjectSchema()
	}
	return normalizeToolSchema(schema)
}

func normalizeToolSchema(schema map[string]any) map[string]any {
	out := make(map[string]any, len(schema))
	for key, value := range schema {
		switch key {
		case "type":
			var types []any
			switch v := value.(type) {
			case []any:
				types = v
			case []string:
				for _, t := range v {
					types = append(types, t)
				}
			}
			var concrete []any
			for _, t := range types {
				if t != "null" {
					concrete = append(concrete, t)
				}
			}
			if len(concrete) == 1 && len(types) > 1 && !explicitNull(schema) {
				if concrete[0] == "array" || concrete[0] == "object" {
					value = concrete[0]
				}
			}
		case "properties", "patternProperties", "$defs", "definitions", "dependentSchemas":
			if schemas, ok := value.(map[string]any); ok {
				copy := make(map[string]any, len(schemas))
				for name, child := range schemas {
					copy[name] = child
					if s, ok := child.(map[string]any); ok {
						copy[name] = normalizeToolSchema(s)
					}
				}
				value = copy
			}
		case "items", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems":
			if child, ok := value.(map[string]any); ok {
				value = normalizeToolSchema(child)
			}
		case "anyOf", "oneOf", "allOf", "prefixItems":
			if children, ok := value.([]any); ok {
				copy := append([]any(nil), children...)
				for i, child := range children {
					if s, ok := child.(map[string]any); ok {
						copy[i] = normalizeToolSchema(s)
					}
				}
				value = copy
			}
		}
		out[key] = value
	}
	return out
}

func explicitNull(schema map[string]any) bool {
	for _, key := range []string{"default", "const"} {
		if value, ok := schema[key]; ok && value == nil {
			return true
		}
	}
	if values, ok := schema["enum"].([]any); ok {
		for _, value := range values {
			if value == nil {
				return true
			}
		}
	}
	return false
}
