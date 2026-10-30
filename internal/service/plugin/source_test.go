package plugin

import (
	"path/filepath"
	"testing"
)

func TestParseSource(t *testing.T) {
	cases := []struct {
		in, kind, name, version, owner, repo, ref, sub, path string
		fail                                                 bool
	}{
		{in: "left-pad", kind: "npm", name: "left-pad", version: "latest"},
		{in: "left-pad@1.2.3", kind: "npm", name: "left-pad", version: "1.2.3"},
		{in: "npm:@scope/pkg@1.2.3", kind: "npm", name: "@scope/pkg", version: "1.2.3"},
		{in: "@scope/pkg", kind: "npm", name: "@scope/pkg", version: "latest"},
		{in: "github:acme/demo", kind: "github", owner: "acme", repo: "demo"},
		{in: "acme/demo#v1.2.3", kind: "github", owner: "acme", repo: "demo", ref: "v1.2.3"},
		{in: "https://github.com/acme/demo.git", kind: "github", owner: "acme", repo: "demo"},
		{in: "https://github.com/acme/demo/tree/main/packages/demo", kind: "github", owner: "acme", repo: "demo", ref: "main", sub: "packages/demo"},
		{in: "https://example.com/plugin.jar", fail: true},
		{in: "https://example.com/a.jar", fail: true},
		{in: "https://example.com/plugin.tgz", fail: true},
		{in: "../local/plugin.js", kind: "local", path: "../local/plugin.js"},
		{in: `C:\plugins\demo`, kind: "local", path: `C:\plugins\demo`},
		{in: "file:///C:/plugins/demo", kind: "local", path: filepath.FromSlash("C:/plugins/demo")},
		{in: "plugin.js", kind: "local", path: "plugin.js"},
		{in: "file://evil.example/plugin.js", fail: true},
		{in: "", fail: true},
	}
	for _, tc := range cases {
		got, err := parseSource(tc.in)
		if tc.fail {
			if err == nil {
				t.Errorf("%s accepted", tc.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", tc.in, err)
			continue
		}
		if got.Kind != tc.kind || got.Name != tc.name || got.Version != tc.version || got.Owner != tc.owner || got.Repo != tc.repo || got.Ref != tc.ref || got.Subdir != tc.sub || got.Path != tc.path {
			t.Errorf("%s => %+v", tc.in, got)
		}
	}
}

func TestBestVersion(t *testing.T) {
	versions := []string{"1.0.0", "1.2.3", "1.3.0-beta.1", "2.0.0", "0.2.1", "0.2.4", "0.0.3", "0.0.4"}
	cases := map[string]string{
		"^1.0.0":  "1.2.3",
		"~1.2.0":  "1.2.3",
		">=1.2.3": "2.0.0",
		"^0.2.1":  "0.2.4",
		"^0.0.3":  "0.0.3",
		"*":       "2.0.0",
	}
	for spec, want := range cases {
		got, err := bestVersion(versions, spec)
		if err != nil || got != want {
			t.Errorf("%s => %s, %v; want %s", spec, got, err, want)
		}
	}
}

func TestPluginID(t *testing.T) {
	if got := pluginID("@scope/pkg"); got != "scope_pkg" {
		t.Fatalf("scoped id = %s", got)
	}
	if got := pluginID("demo-plugin"); got != "demo_plugin" {
		t.Fatalf("id = %s", got)
	}
}
