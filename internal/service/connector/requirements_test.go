package connector

import (
	"errors"
	"reflect"
	"testing"
)

func fakeLookPath(found ...string) func(string) (string, error) {
	set := map[string]bool{}
	for _, name := range found {
		set[name] = true
	}
	return func(name string) (string, error) {
		if set[name] {
			return "/bin/" + name, nil
		}
		return "", errors.New("not found")
	}
}

func TestMissingRequirements(t *testing.T) {
	cases := []struct {
		name     string
		requires []string
		found    []string
		want     []string
	}{
		{"node ok", []string{"node"}, []string{"npx"}, nil},
		{"node missing", []string{"node"}, nil, []string{"npx"}},
		{"uv ok", []string{"uv"}, []string{"uvx"}, nil},
		{"uv missing", []string{"uv"}, nil, []string{"uvx"}},
		{"python via python3", []string{"python"}, []string{"python3"}, nil},
		{"python via python", []string{"python"}, []string{"python"}, nil},
		{"python missing", []string{"python"}, nil, []string{"python3 / python"}},
		{"docker ok", []string{"docker"}, []string{"docker"}, nil},
		{"docker missing", []string{"docker"}, nil, []string{"docker"}},
		{"mixed", []string{"node", "uv"}, []string{"npx"}, []string{"uvx"}},
		{"unknown", []string{"rust"}, []string{"npx", "uvx", "docker", "python3"}, []string{"rust"}},
	}
	for _, tc := range cases {
		svc := New(Catalog{}, t.TempDir(), WithLookPath(fakeLookPath(tc.found...)))
		got := svc.MissingRequirements(Connector{ID: "x", Requires: tc.requires})
		if len(got) == 0 && len(tc.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

func TestRequirementErrorMessage(t *testing.T) {
	err := requirementError([]string{"npx", "uvx"})
	if err == nil || err.Error() != "运行环境不满足连接器要求（缺少 npx、uvx）" {
		t.Fatalf("err = %v", err)
	}
}

func TestRedactorMasksSubmittedSecrets(t *testing.T) {
	catalog := Catalog{Categories: []Category{{ID: "dev", Name: "开发"}}}
	svc := New(catalog, t.TempDir())
	defer svc.Close()
	redact := svc.redactorWith("x", []string{"tok a&b"})
	out := redact("probe failed: tok a&b / tok+a%26b")
	if out != "probe failed: *** / ***" {
		t.Fatalf("redact = %q", out)
	}
}
