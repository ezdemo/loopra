package controller

import (
	"slices"
	"testing"

	"github.com/ezdemo/looprax/internal/service/tools"
)

func TestRequirementToolset(t *testing.T) {
	registry := tools.NewRegistry()
	s := &Controller{registry: registry}
	s.installRequirementTools()

	available, err := registry.Tools(nil)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(available))
	for _, entry := range available {
		names = append(names, entry.Name())
	}
	slices.Sort(names)
	want := []string{"finish_requirement", "reply_requirement_comment"}
	if !slices.Equal(names, want) {
		t.Fatalf("requirement tools = %v, want %v", names, want)
	}
}
