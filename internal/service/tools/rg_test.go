package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
)

func rgFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("LOOPRA_RG_CACHE", t.TempDir())
	fixtures := map[string]string{
		".git/HEAD":         "ref: refs/heads/main\n",
		".gitignore":        "ignored/\n",
		".ignore":           "ignore.txt\n",
		".rgignore":         "rgignore.txt\n",
		"main.go":           "before\nfunc NewDemo() { // needle\n    // a.b( 中文 needle\nafter\n",
		"main_test.go":      "needle test\n",
		"nested/worker.go":  "needle nested\n",
		"note.txt":          "needle text\n",
		".hidden.txt":       "needle hidden\n",
		"ignored/secret.go": "needle ignored\n",
		"ignore.txt":        "needle ignore-rule\n",
		"rgignore.txt":      "needle rgignore-rule\n",
		"binary.dat":        "\x00needle binary\n",
		"empty.txt":         "",
		"-":                 "literal --help needle\n",
	}
	for name, content := range fixtures {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestRGSearchFiltersAndContext(t *testing.T) {
	root := rgFixture(t)
	out, err := runRG(context.Background(), root, rgInput{Pattern: "func\\s+New", Globs: []string{"*.go", "!**/*_test.go"}, ContextLines: 1})
	if err != nil {
		t.Fatal(err)
	}
	text := out["result"].(string)
	for _, want := range []string{"main.go:2:func NewDemo", "main.go-1-before", "main.go-3-    // a.b( 中文 needle"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in %q", want, text)
		}
	}
	if out["matched"] != true || out["truncated"] != false || out["exit_code"] != 0 {
		t.Fatalf("result = %v", out)
	}
}

func TestRGModesAndIgnoreRules(t *testing.T) {
	root := rgFixture(t)
	for _, test := range []struct {
		name    string
		in      rgInput
		present []string
		absent  []string
	}{
		{"default", rgInput{Pattern: "needle"}, []string{"main.go", "nested"}, []string{"hidden", "secret.go", "ignore.txt", "rgignore.txt", "binary.dat"}},
		{"hidden", rgInput{Pattern: "needle", Hidden: true}, []string{".hidden.txt"}, []string{"secret.go", "ignore.txt", "rgignore.txt"}},
		{"no ignore", rgInput{Pattern: "needle", NoIgnore: true}, []string{"secret.go", "ignore.txt", "rgignore.txt"}, []string{".hidden.txt"}},
		{"file paths", rgInput{Mode: "files", Globs: []string{"*.go", "!**/*_test.go"}}, []string{"main.go", "worker.go"}, []string{"main_test.go", "secret.go", "note.txt"}},
		{"empty and binary paths", rgInput{Mode: "files"}, []string{"empty.txt", "binary.dat"}, []string{".hidden.txt", "secret.go"}},
		{"matching files", rgInput{Mode: "files_with_matches", Pattern: "needle", Globs: []string{"*.go"}}, []string{"main.go", "worker.go"}, []string{"needle", "note.txt"}},
		{"depth", rgInput{Mode: "files", MaxDepth: 1, Globs: []string{"*.go"}}, []string{"main.go"}, []string{"worker.go"}},
		{"fixed", rgInput{Pattern: "a.b(", FixedStrings: true}, []string{"a.b("}, nil},
		{"pcre2", rgInput{Pattern: "(?<=func )NewDemo", PerlRegexp: true}, []string{"func NewDemo"}, nil},
		{"dash path and pattern", rgInput{Pattern: "--help", Path: "-", FixedStrings: true}, []string{"literal --help needle"}, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, err := runRG(context.Background(), root, test.in)
			if err != nil {
				t.Fatal(err)
			}
			text := out["result"].(string)
			for _, want := range test.present {
				if !strings.Contains(text, want) {
					t.Errorf("missing %q in %q", want, text)
				}
			}
			for _, unwanted := range test.absent {
				if strings.Contains(text, unwanted) {
					t.Errorf("unexpected %q in %q", unwanted, text)
				}
			}
		})
	}
}

func TestRGNoMatchesErrorsAndLimits(t *testing.T) {
	root := rgFixture(t)
	out, err := runRG(context.Background(), root, rgInput{Pattern: "unfindable-token"})
	if err != nil || out["matched"] != false || out["exit_code"] != 1 {
		t.Fatalf("no matches = %v %v", out, err)
	}
	for _, in := range []rgInput{
		{}, {Mode: "list"}, {Pattern: "["}, {Mode: "files", Pattern: "needle"},
		{Pattern: "x", FixedStrings: true, PerlRegexp: true},
		{Pattern: "x", ContextLines: 21}, {Pattern: "x", MaxResults: 1001},
		{Pattern: "x", Path: ".."}, {Pattern: "x", Globs: []string{""}},
	} {
		if _, err := runRG(context.Background(), root, in); err == nil {
			t.Errorf("invalid arguments accepted: %+v", in)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "many.txt"), []byte(strings.Repeat("needle\n", 100)), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err = runRG(context.Background(), root, rgInput{Pattern: "needle", Path: "many.txt", MaxResults: 2})
	if err != nil || out["truncated"] != true || strings.Count(out["result"].(string), "many.txt:") != 2 {
		t.Fatalf("limit = %v %v", out, err)
	}
	if err := os.WriteFile(filepath.Join(root, "long.txt"), []byte("needle "+strings.Repeat("x", 100000)), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err = runRG(context.Background(), root, rgInput{Pattern: "needle", Path: "long.txt"})
	if err != nil || out["truncated"] != true || len(out["result"].(string)) > 66000 {
		t.Fatalf("byte limit = %v %v", out["truncated"], err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runRG(ctx, root, rgInput{Pattern: "needle"}); err == nil {
		t.Fatal("canceled search succeeded")
	}
}

func TestRGDoesNotFollowExternalLinks(t *testing.T) {
	root := rgFixture(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("private-outside-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "external")
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS != "windows" {
			t.Fatal(err)
		}
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `New-Item -ItemType Junction -Path $env:LOOPRA_TEST_LINK -Target $env:LOOPRA_TEST_TARGET -ErrorAction Stop | Out-Null`)
		cmd.Env = append(os.Environ(), "LOOPRA_TEST_LINK="+link, "LOOPRA_TEST_TARGET="+outside)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("junction fixture failed: %v: %s", err, output)
		}
	}
	out, err := runRG(context.Background(), root, rgInput{Pattern: "private-outside-token", Hidden: true, NoIgnore: true})
	if err != nil || out["matched"] != false {
		t.Fatalf("search followed an external link: %v %v", out, err)
	}
	if _, err := runRG(context.Background(), root, rgInput{Pattern: "private-outside-token", Path: "external"}); err == nil {
		t.Fatal("explicit external link accepted")
	}
}

func TestRGReplacesOldTools(t *testing.T) {
	registry := NewRegistry(FileTools(t.TempDir())...)
	names := map[string]bool{}
	for _, entry := range registry.Entries() {
		if entry.Tool.Name() != entry.Meta.Name {
			t.Fatalf("tool name differs from metadata: %+v", entry.Meta)
		}
		names[entry.Meta.Name] = true
	}
	for _, old := range []string{"grep", "glob", "ls", "ugrep", "ripgrep"} {
		if names[old] {
			t.Errorf("obsolete tool still registered: %s", old)
		}
	}
	if !names["rg"] || !names["read"] || !names[shellenv.Current.Name] {
		t.Fatalf("missing core tools: %v", names)
	}
	registry.Configure([]string{"grep"}, nil, nil)
	if !registry.Disabled("rg") {
		t.Fatal("saved grep disabled setting was lost")
	}
}
