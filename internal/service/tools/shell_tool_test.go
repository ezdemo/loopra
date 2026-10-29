package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"google.golang.org/genai"

	"github.com/ezdemo/looprax/internal/infrastructure/shellenv"
)

func TestShellCommandSchemaIncludesExecutionControls(t *testing.T) {
	declarer, ok := bashTool(t.TempDir()).(interface {
		Declaration() *genai.FunctionDeclaration
	})
	if !ok {
		t.Fatal("shell tool does not expose a function declaration")
	}
	raw, err := json.Marshal(declarer.Declaration())
	if err != nil {
		t.Fatal(err)
	}
	schema := string(raw)
	for _, field := range []string{"command", "cwd", "max_char", "timeout", "timeout_ms"} {
		if !strings.Contains(schema, `"`+field+`"`) {
			t.Fatalf("schema is missing %q: %s", field, schema)
		}
	}
}

func TestShellCommandUsesCwdAndReportsTruncation(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "child")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatal(err)
	}

	for _, cwd := range []string{"child", child} {
		output, err := runShellCommand(context.Background(), root, shellCommandInput{
			Command: shellTestCommand("(Get-Location).Path", "cd", "pwd"),
			Cwd:     cwd,
		})
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := output["cwd"].(string); !sameDirectory(got, child) {
			t.Fatalf("cwd = %v, want %s", got, child)
		}
		if text, _ := output["result"].(string); !sameDirectory(text, child) {
			t.Fatalf("result = %q, want child cwd %s", text, child)
		}
	}

	output, err := runShellCommand(context.Background(), root, shellCommandInput{
		Command: shellTestCommand(
			"Write-Output 'abcdefghijklmnopqrst'",
			"echo abcdefghijklmnopqrst",
			"printf 'abcdefghijklmnopqrst\\n'",
		),
		MaxChar: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if output["truncated"] != true {
		t.Fatalf("truncated = %v, result = %q", output["truncated"], output["result"])
	}
	text, _ := output["result"].(string)
	if !strings.Contains(text, "输出已截断") || !strings.HasPrefix(text, "abcde") {
		t.Fatalf("truncated result = %q", text)
	}
	if total, _ := output["total_chars"].(int); total <= 5 {
		t.Fatalf("total_chars = %v", output["total_chars"])
	}
}

func TestShellCommandTimeoutIsExplicit(t *testing.T) {
	started := time.Now()
	output, err := runShellCommand(context.Background(), t.TempDir(), shellCommandInput{
		Command: shellTestCommand(
			"Start-Sleep -Seconds 10",
			"ping -n 11 127.0.0.1 >NUL",
			"sleep 10",
		),
		Timeout: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if output["status"] != "timed_out" || output["timed_out"] != true {
		t.Fatalf("timeout result = %#v", output)
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("timeout did not stop the process tree promptly: %s", elapsed)
	}
}

func TestCharLimitedWriterCountsUTF8Characters(t *testing.T) {
	writer := newCharLimitedWriter(2)
	data := []byte("中a文")
	for _, part := range [][]byte{data[:1], data[1:2], data[2:]} {
		if _, err := writer.Write(part); err != nil {
			t.Fatal(err)
		}
	}
	text, total := writer.Finish()
	if text != "中a" || total != 3 {
		t.Fatalf("text = %q total = %d", text, total)
	}
}

func TestInteractiveOutputReportsTruncation(t *testing.T) {
	result := shellOutputResult("abcdef", 3)
	if result["truncated"] != true || result["total_chars"] != 6 || result["omitted_chars"] != 3 {
		t.Fatalf("result = %#v", result)
	}
	text, _ := result["result"].(string)
	if !strings.HasPrefix(text, "abc") || !strings.Contains(text, "输出已截断") {
		t.Fatalf("result text = %q", text)
	}
}

// sameDirectory 把同一目录的不同写法视为相等。
// macOS 临时目录是 /var 到 /private/var 的符号链接，Windows CI 的临时目录可能是 8.3 短路径。
func sameDirectory(a, b string) bool {
	a = strings.TrimSpace(a)
	b = strings.TrimSpace(b)
	if a == "" || b == "" {
		return false
	}
	if strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) {
		return true
	}
	left, errA := os.Stat(a)
	right, errB := os.Stat(b)
	return errA == nil && errB == nil && os.SameFile(left, right)
}

func shellTestCommand(powershell, cmd, unix string) string {
	switch shellenv.Current.Name {
	case "powershell":
		return powershell
	case "CMD":
		return cmd
	default:
		return unix
	}
}
