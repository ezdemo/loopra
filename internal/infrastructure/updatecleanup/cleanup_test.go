package updatecleanup

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func fixtureBinary(t *testing.T, module string) []byte {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "cmd", "looprax-desktop")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(root, "go.mod"), []byte("module "+module+"\n\ngo 1.27\n"), 0o600)
	os.WriteFile(filepath.Join(dir, "main.go"), []byte("package main\nfunc main() {}\n"), 0o600)
	compiler := filepath.Join(runtime.GOROOT(), "bin", "go")
	if runtime.GOOS == "windows" {
		compiler += ".exe"
	}
	binary := filepath.Join(root, "fixture.bin")
	cmd := exec.Command(compiler, "build", "-o", binary, "./cmd/looprax-desktop")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GOWORK=off", "GOTOOLCHAIN=local", "CGO_ENABLED=0")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build fixture: %v\n%s", err, output)
	}
	data, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestLegacyBackupRemovesOnlyVerifiedLoopraBackups(t *testing.T) {
	loopra := fixtureBinary(t, "github.com/ezdemo/looprax")
	unrelated := fixtureBinary(t, "example.com/unrelated")
	for _, bundle := range []bool{false, true} {
		for _, candidate := range []struct {
			name    string
			data    []byte
			removed bool
		}{
			{"loopra", loopra, true}, {"other-app", unrelated, false}, {"user-file", []byte("keep user data"), false},
		} {
			t.Run(candidate.name+map[bool]string{false: "-binary", true: "-bundle"}[bundle], func(t *testing.T) {
				root := t.TempDir()
				executable := filepath.Join(root, "Loopra.exe")
				backup, backupExecutable := executable+".old", executable+".old"
				if bundle {
					app := filepath.Join(root, "Loopra.app")
					executable = filepath.Join(app, "Contents", "MacOS", "Loopra")
					backup = app + ".old"
					backupExecutable = filepath.Join(backup, "Contents", "MacOS", "Loopra")
					os.MkdirAll(filepath.Dir(executable), 0o755)
					os.MkdirAll(filepath.Dir(backupExecutable), 0o755)
				}
				os.WriteFile(executable, loopra, 0o755)
				os.WriteFile(backupExecutable, candidate.data, 0o755)
				unrelatedBackup := filepath.Join(root, "Other.app.old")
				os.WriteFile(unrelatedBackup, []byte("untouched"), 0o600)
				if err := LegacyBackup(executable); err != nil {
					t.Fatal(err)
				}
				_, err := os.Stat(backup)
				if os.IsNotExist(err) != candidate.removed {
					t.Fatalf("backup removed=%v, want %v", os.IsNotExist(err), candidate.removed)
				}
				if _, err := os.Stat(executable); err != nil {
					t.Fatal("active application was removed")
				}
				if data, _ := os.ReadFile(unrelatedBackup); string(data) != "untouched" {
					t.Fatal("unrelated sibling was changed")
				}
				if err := LegacyBackup(executable); err != nil {
					t.Fatal("repeated startup cleanup must be harmless:", err)
				}
			})
		}
	}
}
