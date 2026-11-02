package controller

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestVersionUpdateIdle(t *testing.T) {
	ts, key := newTestServer(t)
	_, env := call(t, ts, http.MethodGet, "/api/version/update", key, nil)
	data := env["data"].(map[string]any)
	if data["running"] != false || data["state"] != "idle" {
		t.Fatalf("update status = %v", data)
	}
	code, env := call(t, ts, http.MethodPost, "/api/version/update/stop", key, nil)
	if code != http.StatusBadRequest || env["success"] != false {
		t.Fatalf("stop = %d %v", code, env)
	}
}

func TestWindowsCoreUpdaterVerifiesWithoutFileHashCommand(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows PowerShell updater")
	}
	script, err := updateScripts.ReadFile("update_scripts/update.ps1")
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		name    string
		archive bool
		corrupt bool
	}{
		{name: "executable"},
		{name: "zip", archive: true},
		{name: "checksum mismatch", corrupt: true},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			binary := append([]byte("MZ"), bytes.Repeat([]byte{0, 1, 127, 128, 255}, 32)...)
			payload, assetName := binary, "loopra-windows-amd64.exe"
			if fixture.archive {
				var buffer bytes.Buffer
				archive := zip.NewWriter(&buffer)
				entry, err := archive.Create("bin/loopra.exe")
				if err != nil {
					t.Fatal(err)
				}
				if _, err := entry.Write(binary); err != nil {
					t.Fatal(err)
				}
				if err := archive.Close(); err != nil {
					t.Fatal(err)
				}
				payload, assetName = buffer.Bytes(), "loopra-windows-amd64.zip"
			}
			digest := sha256.Sum256(payload)
			if fixture.corrupt {
				payload = append([]byte(nil), payload...)
				payload[len(payload)-1]++
			}
			var server *httptest.Server
			server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/latest" {
					w.Header().Set("Content-Type", "application/json")
					json.NewEncoder(w).Encode(map[string]any{"assets": []map[string]any{{
						"name": assetName, "browser_download_url": server.URL + "/asset",
						"digest": "sha256:" + strings.ToUpper(hex.EncodeToString(digest[:])),
					}}})
					return
				}
				w.Write(payload)
			}))
			defer server.Close()
			home := filepath.Join(t.TempDir(), "更新 目录")
			directory := filepath.Join(home, "updates")
			if err := os.MkdirAll(directory, 0o700); err != nil {
				t.Fatal(err)
			}
			target, marker := filepath.Join(home, "loopra.exe"), filepath.Join(home, "helper-started")
			if err := os.WriteFile(target, []byte("previous executable"), 0o600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("LOOPRA_HOME", home)
			t.Setenv("LOOPRA_MIRROR", "")
			t.Setenv("LOOPRAX_RELEASE_API_URL", server.URL+"/latest")
			t.Setenv("LOOPRAX_UPDATE_TARGET", target)
			t.Setenv("LOOPRAX_UPDATE_ARCH", "amd64")
			t.Setenv("LOOPRA_UPDATE_TEST_MARKER", marker)
			// Simulate the missing command and a legacy output code page. Suppress
			// only the apply-helper launch so the actual updater can run safely.
			wrapper := `[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936)
function Get-FileHash { throw 'Get-FileHash is unavailable' }
function Start-Process { [System.IO.File]::WriteAllText($env:LOOPRA_UPDATE_TEST_MARKER, 'ready') }
trap { [Console]::Error.WriteLine('更新失败: ' + $_.Exception.Message); exit 1 }
` + string(script) + "\nWrite-Output '更新校验完成'\n"
			path := filepath.Join(home, "fixture.ps1")
			if err := os.WriteFile(path, append([]byte{0xef, 0xbb, 0xbf}, []byte(wrapper)...), 0o600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			output, err := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path).CombinedOutput()
			if !utf8.Valid(output) {
				t.Fatalf("updater output is not UTF-8: %q", output)
			}
			if current, readErr := os.ReadFile(target); readErr != nil || string(current) != "previous executable" {
				t.Fatal("updater replaced the running executable")
			}
			if fixture.corrupt {
				if err == nil || !strings.Contains(string(output), "更新失败: Release checksum mismatch") {
					t.Fatalf("checksum mismatch: %v\n%s", err, output)
				}
				if _, err := os.Stat(marker); !os.IsNotExist(err) {
					t.Fatal("corrupt package started the apply helper")
				}
				return
			}
			if err != nil || !strings.Contains(string(output), "更新校验完成") {
				t.Fatalf("update: %v\n%s", err, output)
			}
			if _, err := os.Stat(marker); err != nil {
				t.Fatal("verified package did not start the apply helper")
			}
			entries, err := os.ReadDir(directory)
			if err != nil {
				t.Fatal(err)
			}
			var staged int
			for _, entry := range entries {
				if strings.HasSuffix(entry.Name(), ".exe") {
					staged++
					if data, err := os.ReadFile(filepath.Join(directory, entry.Name())); err != nil || !bytes.Equal(data, binary) {
						t.Fatalf("staged executable differs: %v", err)
					}
				}
			}
			if staged != 1 || len(entries) != 2 {
				t.Fatalf("expected staged executable and apply helper, got %v", entries)
			}
		})
	}
}
