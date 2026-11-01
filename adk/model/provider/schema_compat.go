package provider

import "strings"

// MiMo's Chat Completions endpoint can leak its tool markup into content and
// truncate arguments when a parameter has type ["null", "array"]. Go's schema
// generator uses such unions for slices. Offer the concrete types to MiMo;
// optional parameters can still be omitted. Keep other models and the original
// declaration unchanged, including schema-shaped literal defaults and examples.
func compatibleChatToolSchema(modelName string, schema map[string]any) map[string]any {
	name := strings.ToLower(modelName)
	if i := strings.LastIndexByte(name, '/'); i >= 0 {
		name = name[i+1:]
	}
	if !strings.HasPrefix(name, "mimo-") {
		return schema
	}
	return concreteToolSchema(schema)
}

func concreteToolSchema(schema map[string]any) map[string]any {
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
			concrete := make([]any, 0, len(types))
			for _, t := range types {
				if t != "null" {
					concrete = append(concrete, t)
				}
			}
			if len(concrete) == 1 {
				value = concrete[0]
			} else if len(concrete) > 1 {
				value = concrete
			}
		case "properties", "patternProperties", "$defs", "definitions", "dependentSchemas":
			if schemas, ok := value.(map[string]any); ok {
				copy := make(map[string]any, len(schemas))
				for name, child := range schemas {
					copy[name] = child
					if s, ok := child.(map[string]any); ok {
						copy[name] = concreteToolSchema(s)
					}
				}
				value = copy
			}
		case "items", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems":
			if child, ok := value.(map[string]any); ok {
				value = concreteToolSchema(child)
			}
		case "anyOf", "oneOf", "allOf", "prefixItems":
			if children, ok := value.([]any); ok {
				copy := append([]any(nil), children...)
				for i, child := range children {
					if s, ok := child.(map[string]any); ok {
						copy[i] = concreteToolSchema(s)
					}
				}
				value = copy
			}
		}
		out[key] = value
	}
	return out
}
