package tools

import (
	"testing"
)

func testEntries() []Tool {
	return []Tool{
		{Tool: nil, Meta: Metadata{Name: "read", ReadOnly: true}},
		{Tool: nil, Meta: Metadata{Name: "write"}},
		{Tool: nil, Meta: Metadata{Name: "bash"}},
	}
}

func enabledNames(reg *Registry) map[string]bool {
	out := map[string]bool{}
	for _, entry := range reg.List() {
		out[entry["name"].(string)] = entry["enabled"].(bool)
	}
	return out
}

func TestSetAllowedFiltersToolsAndList(t *testing.T) {
	reg := NewRegistry(testEntries()...)
	reg.SetAllowed([]string{"read", "grep"}) // grep 归一为 rg，清单内不存在即不放行
	list := enabledNames(reg)
	if !list["read"] || list["write"] || list["bash"] {
		t.Fatalf("enabled = %v", list)
	}
	tools, err := reg.Tools(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 1 {
		t.Fatalf("tools = %v", tools)
	}
	// Configure 只重置启停与只读覆盖，不动允许清单。
	reg.Configure([]string{"read"}, nil, nil)
	if tools, _ := reg.Tools(nil); len(tools) != 0 {
		t.Fatalf("disabled+allowed 交集应为空: %v", tools)
	}
	if list := enabledNames(reg); list["write"] || list["read"] {
		t.Fatalf("enabled = %v", list)
	}
	reg.SetAllowed(nil)
	if tools, _ := reg.Tools(nil); len(tools) != 2 {
		t.Fatalf("解除限制后 = %v", tools)
	}
	reg.SetAllowed([]string{})
	if tools, _ := reg.Tools(nil); len(tools) != 0 {
		t.Fatalf("空清单应全部禁用: %v", tools)
	}
}

func TestSetAllowedAppliesToLaterAddedTools(t *testing.T) {
	reg := NewRegistry(testEntries()...)
	reg.SetAllowed([]string{"read", "sub_agent"})
	reg.Add(Tool{Tool: nil, Meta: Metadata{Name: "sub_agent"}})
	reg.Add(Tool{Tool: nil, Meta: Metadata{Name: "extra"}})
	list := enabledNames(reg)
	if !list["sub_agent"] || list["extra"] {
		t.Fatalf("enabled = %v", list)
	}
}
