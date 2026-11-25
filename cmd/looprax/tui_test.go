package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"testing"
)

func TestResolveTUIClientWithoutPATH(t *testing.T) {
	t.Setenv("PATH", "")
	executable, cleanup, err := resolveTUIClient()
	supported := (runtime.GOOS == "windows" || runtime.GOOS == "darwin" || runtime.GOOS == "linux") &&
		(runtime.GOARCH == "amd64" || runtime.GOARCH == "arm64")
	if !supported {
		if !errors.Is(err, exec.ErrNotFound) {
			t.Fatalf("resolveTUIClient() error = %v, want exec.ErrNotFound", err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	if cleanup == nil {
		t.Fatal("bundled client did not provide cleanup")
	}
	t.Cleanup(func() {
		if err := cleanup(); err != nil {
			t.Error(err)
		}
	})
	name := "micro-acp"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if filepath.Base(executable) != name {
		t.Fatalf("executable = %q, want basename %q", executable, name)
	}
	for _, path := range []string{executable, filepath.Join(filepath.Dir(executable), "LICENSE")} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !info.Mode().IsRegular() || info.Size() == 0 {
			t.Errorf("%q is not a nonempty regular file", path)
		}
	}
}

func TestMicroACPArgsUsesNamedAgent(t *testing.T) {
	want := []string{"--offline", "--config", "launch.json", "--agent", "Loopra"}
	if got := microACPArgs("launch.json"); !slices.Equal(got, want) {
		t.Fatalf("microACPArgs() = %v, want %v", got, want)
	}
}

func TestMicroACPConfigJSONWithoutBaseConfig(t *testing.T) {
	home := t.TempDir()
	command := filepath.Join(home, "looprax.exe")
	agentArgs := []string{"acp", "--home", home, "--config", "custom.yaml"}
	data, err := microACPConfigJSON(filepath.Join(home, "micro-acp", "config.json"), command, agentArgs)
	if err != nil {
		t.Fatal(err)
	}
	doc := decodeObject(t, data)
	entry := objectField(t, objectField(t, doc, "agents"), "Loopra")
	if entry["command"] != command {
		t.Fatalf("command = %v, want %q", entry["command"], command)
	}
	if got := stringList(t, entry["args"]); !slices.Equal(got, agentArgs) {
		t.Fatalf("args = %v, want %v", got, agentArgs)
	}
}

func TestMicroACPConfigJSONMergesExistingConfig(t *testing.T) {
	home := t.TempDir()
	base := filepath.Join(home, "micro-acp", "config.json")
	if err := os.MkdirAll(filepath.Dir(base), 0o755); err != nil {
		t.Fatal(err)
	}
	original := []byte(`{
  "default_agent": "other",
  "registry_url": "https://example.test/registry.json",
  "agents": {
    "other": {"command": "/other/agent", "args": ["--acp"]},
    "Loopra": {
      "command": "/old/loopra",
      "args": ["old"],
      "env": {"KEEP": "1"},
      "protocol": "v2"
    }
  },
  "session": {
    "additional_directories": ["/shared"],
    "mcp_servers": [{"name": "local-tools", "command": "/tools"}]
  },
  "future_extension": {"enabled": true}
}
`)
	if err := os.WriteFile(base, original, 0o600); err != nil {
		t.Fatal(err)
	}
	command := filepath.Join(home, "looprax.exe")
	agentArgs := []string{"acp", "--home", home}
	data, err := microACPConfigJSON(base, command, agentArgs)
	if err != nil {
		t.Fatal(err)
	}
	doc := decodeObject(t, data)
	if doc["default_agent"] != "other" || doc["registry_url"] != "https://example.test/registry.json" {
		t.Fatalf("top-level settings were not preserved: %v", doc)
	}
	if _, ok := doc["future_extension"].(map[string]any); !ok {
		t.Fatalf("unknown extension was not preserved: %v", doc["future_extension"])
	}
	session := objectField(t, doc, "session")
	if got := stringList(t, session["additional_directories"]); !slices.Equal(got, []string{"/shared"}) {
		t.Fatalf("additional directories = %v", got)
	}
	agents := objectField(t, doc, "agents")
	other := objectField(t, agents, "other")
	if other["command"] != "/other/agent" {
		t.Fatalf("other agent was not preserved: %v", other)
	}
	entry := objectField(t, agents, "Loopra")
	if entry["command"] != command {
		t.Fatalf("command = %v, want %q", entry["command"], command)
	}
	if got := stringList(t, entry["args"]); !slices.Equal(got, agentArgs) {
		t.Fatalf("args = %v, want %v", got, agentArgs)
	}
	if entry["protocol"] != "v2" {
		t.Fatalf("protocol was not preserved: %v", entry)
	}
	env := objectField(t, entry, "env")
	if env["KEEP"] != "1" {
		t.Fatalf("env was not preserved: %v", env)
	}
}

func TestMicroACPConfigJSONRejectsInvalidBaseConfig(t *testing.T) {
	for name, contents := range map[string]string{
		"invalid json":   `{`,
		"invalid agents": `{"agents":"bad"}`,
	} {
		t.Run(name, func(t *testing.T) {
			base := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(base, []byte(contents), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := microACPConfigJSON(base, "/loopra", []string{"acp"}); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestWriteMicroACPLaunchConfigLifecycle(t *testing.T) {
	home := t.TempDir()
	path, cleanup, err := writeMicroACPLaunchConfig(home, "/loopra", []string{"acp", "--home", home})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	doc := decodeObject(t, data)
	entry := objectField(t, objectField(t, doc, "agents"), "Loopra")
	if entry["command"] != "/loopra" {
		t.Fatalf("command = %v", entry["command"])
	}
	if err := cleanup(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("launch config still exists after cleanup: %v", err)
	}
}

func decodeObject(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func objectField(t *testing.T, obj map[string]any, key string) map[string]any {
	t.Helper()
	value, ok := obj[key].(map[string]any)
	if !ok {
		t.Fatalf("%q is not an object: %v", key, obj[key])
	}
	return value
}

func stringList(t *testing.T, value any) []string {
	t.Helper()
	items, ok := value.([]any)
	if !ok {
		t.Fatalf("value is not a list: %v", value)
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			t.Fatalf("list item is not a string: %v", item)
		}
		out = append(out, text)
	}
	return out
}
