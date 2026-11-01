package controller

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type desktopTransport func(*http.Request) (*http.Response, error)

func (f desktopTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func desktopResponse(data []byte) *http.Response {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header)}
}
func desktopJSON(value any) *http.Response {
	data, _ := json.Marshal(value)
	return desktopResponse(data)
}
func desktopTestUpdater(t *testing.T) *desktopUpdater {
	t.Helper()
	u := newDesktopUpdater(t.TempDir(), func() {})
	u.state.CurrentVersion = "26.11.101"
	u.platform, u.arch = "windows", "amd64"
	t.Cleanup(u.cancel)
	return u
}
func waitDesktopStatus(t *testing.T, u *desktopUpdater, status string) desktopUpdateState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		state := u.snapshot()
		if state.Status == status {
			return state
		}
		if state.Status == "error" && status != "error" {
			t.Fatalf("unexpected update error: %s", state.Error)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("update did not reach %s: %+v", status, u.snapshot())
	return desktopUpdateState{}
}
func desktopTestAsset(data []byte) desktopAsset {
	hash := sha256.Sum256(data)
	return desktopAsset{Name: "loopra-desktop-windows-amd64.exe", URL: "https://github.com/ezdemo/loopra-release/releases/download/v26.11.102/loopra-desktop-windows-amd64.exe",
		Size: int64(len(data)), Digest: "sha256:" + hex.EncodeToString(hash[:])}
}

func TestDesktopCheckDownloadsOnlyMatchingNativeAsset(t *testing.T) {
	u := desktopTestUpdater(t)
	data := append([]byte("MZ\x00\x00"), bytes.Repeat([]byte{42}, 1024)...)
	asset := desktopTestAsset(data)
	var downloads atomic.Int32
	u.client.Transport = desktopTransport(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/latest") {
			return desktopJSON(desktopRelease{Tag: "v26.11.102", Assets: []desktopAsset{{Name: "loopra-windows-amd64.exe"}, {Name: "loopra-desktop-windows-arm64.exe"}, asset}}), nil
		}
		if r.URL.String() != asset.URL {
			t.Errorf("download URL = %s", r.URL)
		}
		downloads.Add(1)
		return desktopResponse(data), nil
	})
	u.startCheck()
	state := waitDesktopStatus(t, u, "downloaded")
	if state.CurrentVersion != "26.11.101" || state.LatestVersion != "26.11.102" || state.Percent != 100 || state.Transferred != int64(len(data)) || downloads.Load() != 1 {
		t.Fatalf("state = %+v", state)
	}
	staged, err := os.ReadFile(filepath.Join(u.staged, "package"))
	if err != nil || !bytes.Equal(data, staged) {
		t.Fatalf("staged package = %v", err)
	}
	u.startCheck()
	if downloads.Load() != 1 {
		t.Fatal("ready update was downloaded twice")
	}
}

func TestDesktopInstalledWindowsSelectsSetupInsteadOfPortable(t *testing.T) {
	u := desktopTestUpdater(t)
	u.state.PackageType = "nsis"
	data := []byte("MZ\x00\x00installer payload")
	asset := desktopTestAsset(data)
	portable := asset
	asset.Name = "loopra-desktop-windows-amd64-setup.exe"
	asset.URL = strings.TrimSuffix(asset.URL, ".exe") + "-setup.exe"
	u.client.Transport = desktopTransport(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/latest") {
			return desktopJSON(desktopRelease{Tag: "v26.11.102", Assets: []desktopAsset{portable, asset}}), nil
		}
		if r.URL.String() != asset.URL {
			t.Errorf("installer update downloaded %s", r.URL)
		}
		return desktopResponse(data), nil
	})
	u.startCheck()
	waitDesktopStatus(t, u, "downloaded")
	if payload, err := os.ReadFile(filepath.Join(u.staged, "Loopra-Update.exe")); err != nil || !bytes.Equal(payload, data) {
		t.Fatalf("setup = %v", err)
	}
}

func TestWindowsDesktopInstallationMarkerNeedsMatchingArchitectureAndUninstaller(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "Loopra.exe")
	if got := windowsDesktopPackageType(executable, "amd64"); got != "portable" {
		t.Fatal(got)
	}
	os.WriteFile(filepath.Join(dir, "loopra-install.json"), []byte(`{"packageType":"nsis","scope":"user","arch":"amd64"}`), 0o600)
	if got := windowsDesktopPackageType(executable, "amd64"); got != "portable" {
		t.Fatal("marker without uninstaller was accepted")
	}
	os.WriteFile(filepath.Join(dir, "Uninstall.exe"), []byte("fixture"), 0o600)
	if got := windowsDesktopPackageType(executable, "amd64"); got != "nsis" {
		t.Fatal(got)
	}
	if got := windowsDesktopPackageType(executable, "arm64"); got != "portable" {
		t.Fatal("wrong architecture marker accepted")
	}
	if got := windowsDesktopPackageType(filepath.Join(dir, "portable.exe"), "amd64"); got != "portable" {
		t.Fatal("renamed portable executable accepted as installed")
	}
}

func TestDesktopVerificationFailureCanRetryWithoutReplacingApp(t *testing.T) {
	u := desktopTestUpdater(t)
	data := []byte("MZ\x00\x00verified native package")
	asset := desktopTestAsset(data)
	var corrupt atomic.Bool
	corrupt.Store(true)
	u.executable = filepath.Join(t.TempDir(), "Loopra.exe")
	os.WriteFile(u.executable, []byte("previous version"), 0o755)
	u.client.Transport = desktopTransport(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "/latest") {
			return desktopJSON(desktopRelease{Tag: "v26.11.102", Assets: []desktopAsset{asset}}), nil
		}
		payload := append([]byte(nil), data...)
		if corrupt.Load() {
			payload[len(payload)-1]++
		}
		return desktopResponse(payload), nil
	})
	u.startCheck()
	if state := waitDesktopStatus(t, u, "error"); !strings.Contains(state.Error, "校验失败") {
		t.Fatal(state)
	}
	if err := u.install(); err == nil {
		t.Fatal("corrupt package could be installed")
	}
	if old, _ := os.ReadFile(u.executable); string(old) != "previous version" {
		t.Fatal("app changed before install")
	}
	corrupt.Store(false)
	u.startCheck()
	waitDesktopStatus(t, u, "downloaded")
}

func TestDesktopSourceSwitchCancelsOldCheckAndPersists(t *testing.T) {
	u := desktopTestUpdater(t)
	started := make(chan struct{})
	var checks atomic.Int32
	u.client.Transport = desktopTransport(func(r *http.Request) (*http.Response, error) {
		if checks.Add(1) == 1 {
			close(started)
			<-r.Context().Done()
			return nil, r.Context().Err()
		}
		return desktopJSON(desktopRelease{Tag: "v26.11.101"}), nil
	})
	u.startCheck()
	<-started
	if err := u.setSource("https://ghproxy.net/"); err != nil {
		t.Fatal(err)
	}
	state := waitDesktopStatus(t, u, "idle")
	if state.Source != "https://ghproxy.net/" || state.LatestVersion != "26.11.101" || state.Error != "" {
		t.Fatal(state)
	}
	if err := u.setSource("https://untrusted.example/"); err == nil {
		t.Fatal("untrusted mirror accepted")
	}
	reloaded := newDesktopUpdater(u.home, func() {})
	defer reloaded.cancel()
	if reloaded.snapshot().Source != state.Source {
		t.Fatal("download source was not saved")
	}
}

func TestDesktopNotesUseVersionRangeAndCleanBothReleaseNames(t *testing.T) {
	u := desktopTestUpdater(t)
	u.state.LatestVersion = "26.11.103"
	var calls int
	u.client.Transport = desktopTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if !strings.Contains(r.URL.RawQuery, "per_page=100") {
			t.Error(r.URL)
		}
		return desktopJSON([]desktopRelease{
			{Tag: "v26.11.104", Body: "future"},
			{Tag: "v26.11.103", Body: "## LoopraX v26.11.103\n\n### 修复\n- 修复更新\n\n### 下载\nsecret package list\n<!-- metadata -->"},
			{Tag: "v26.11.102", Body: "## Loopra v26.11.102\n\n### 新增\n- 桌面端"},
			{Tag: "v26.11.101", Body: "installed"},
			{Tag: "v26.11.102", Prerelease: true},
		}), nil
	})
	notes, err := u.releaseNotes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(notes.Releases) != 2 || !notes.Complete || notes.Releases[0].Version != "26.11.103" || notes.Releases[0].Body != "### 修复\n- 修复更新" {
		t.Fatalf("notes = %+v", notes)
	}
	u.state.CurrentVersion = "26.11.103"
	notes, err = u.releaseNotes(context.Background())
	if err != nil || len(notes.Releases) != 1 || calls != 1 {
		t.Fatalf("cached notes = %+v, %v", notes, err)
	}
}

func TestDesktopRejectsMissingDigestAndUntrustedPackageURL(t *testing.T) {
	for _, raw := range []string{"http://github.com/ezdemo/loopra-release/releases/download/v1/pkg", "https://example.com/pkg", "https://github.com/other/repo/releases/download/v1/pkg"} {
		if validDesktopAssetURL(raw) {
			t.Errorf("accepted URL: %s", raw)
		}
	}
	u := desktopTestUpdater(t)
	asset := desktopTestAsset([]byte("MZxx"))
	asset.Digest = ""
	u.client.Transport = desktopTransport(func(*http.Request) (*http.Response, error) {
		t.Error("downloaded without checksum")
		return nil, io.EOF
	})
	if _, err := u.download(context.Background(), asset, "normal"); err == nil {
		t.Fatal("missing checksum accepted")
	}
}

func TestDesktopAppExtractionRejectsTraversalAndKeepsResources(t *testing.T) {
	for _, unsafe := range []bool{false, true} {
		var buffer bytes.Buffer
		archive := zip.NewWriter(&buffer)
		files := map[string]string{"Loopra.app/Contents/MacOS/Loopra": "\xcf\xfa\xed\xfebinary", "Loopra.app/Contents/Info.plist": "26.11.102", "Loopra.app/Contents/Resources/icon.icns": "icon"}
		if unsafe {
			files["Loopra.app/../../escape"] = "bad"
		}
		for name, data := range files {
			entry, _ := archive.Create(name)
			io.WriteString(entry, data)
		}
		archive.Close()
		work := t.TempDir()
		path := filepath.Join(work, "package.zip")
		os.WriteFile(path, buffer.Bytes(), 0o600)
		err := extractDesktopApp(path, work)
		if unsafe {
			if err == nil {
				t.Fatal("traversal was accepted")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if resource, _ := os.ReadFile(filepath.Join(work, "Loopra.app/Contents/Resources/icon.icns")); string(resource) != "icon" {
			t.Fatal("app resource lost")
		}
	}
}

func TestDesktopUpdaterUnavailableOnWebServer(t *testing.T) {
	s := &Controller{}
	w := httptest.NewRecorder()
	s.desktopUpdateController(w, httptest.NewRequest("GET", "/api/desktop-update/state", nil))
	if w.Code != http.StatusNotFound {
		t.Fatal(w.Code)
	}
}

func TestDesktopWindowsApplyReplacesAndPreservesUnicodeArguments(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows installer")
	}
	work := t.TempDir()
	target, staged := filepath.Join(work, "桌面端.exe"), filepath.Join(work, "package")
	os.WriteFile(target, []byte("old"), 0o600)
	os.WriteFile(staged, []byte("new"), 0o600)
	config := filepath.Join(work, "apply.json")
	args := []string{"--home", `C:\测试 数据\`, `quoted"value`, ""}
	data, _ := json.Marshal(map[string]any{"target": target, "staged": staged, "pid": 2147483647, "cwd": work, "args": args})
	os.WriteFile(config, data, 0o600)
	// Replace only the final process launch so this fixture can exercise the
	// real helper without opening a second desktop application.
	script := strings.Replace(desktopApplyWindows, "    Start-LoopraProcess @start | Out-Null", `    $start | ConvertTo-Json | Set-Content -LiteralPath ($Config + '.launch') -Encoding UTF8`, 1)
	helper := filepath.Join(work, "apply.ps1")
	os.WriteFile(helper, append([]byte{0xef, 0xbb, 0xbf}, []byte(script)...), 0o600)
	output, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Config", config).CombinedOutput()
	if err != nil {
		log, _ := os.ReadFile(config + ".log")
		t.Fatalf("apply: %v\n%s\n%s", err, output, log)
	}
	if value, _ := os.ReadFile(target); string(value) != "new" {
		t.Fatal("update not installed")
	}
	if _, err := os.Stat(target + ".old"); !os.IsNotExist(err) {
		t.Fatal("successful update left a .old backup")
	}
	launch, _ := os.ReadFile(config + ".launch")
	var info struct{ FilePath, WorkingDirectory, ArgumentList string }
	if err := json.Unmarshal(bytes.TrimPrefix(launch, []byte{0xef, 0xbb, 0xbf}), &info); err != nil {
		t.Fatal(err)
	}
	if info.FilePath != target || info.WorkingDirectory != work || info.ArgumentList != `"--home" "C:\测试 数据\\" "quoted\"value" ""` {
		t.Fatalf("launch = %+v", info)
	}
}

func TestDesktopWindowsInstallerHelperPreservesPathArgumentsAndStopsOnFailure(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows installer helper")
	}
	for _, exitCode := range []int{0, 5} {
		work := t.TempDir()
		target, staged := filepath.Join(work, "应用 目录", "Loopra.exe"), filepath.Join(work, "Loopra-Update.exe")
		os.MkdirAll(filepath.Dir(target), 0o700)
		os.WriteFile(target, []byte("installed app"), 0o600)
		os.WriteFile(staged, []byte("verified installer"), 0o600)
		config := filepath.Join(work, "apply.json")
		data, _ := json.Marshal(map[string]any{"target": target, "staged": staged, "pid": 2147483647, "cwd": work, "args": []string{"--home", `C:\用户 数据\`}, "packageType": "nsis"})
		os.WriteFile(config, data, 0o600)
		// Keep this test inside the workspace: the installer process is simulated,
		// while the real apply script handles its result and constructs the restart.
		script := strings.Replace(desktopApplyWindows,
			"        $setup = Start-LoopraProcess -FilePath $c.staged -ArgumentList ('/S /UPDATE /D=' + $directory) -WorkingDirectory $c.cwd",
			fmt.Sprintf("        ('/S /UPDATE /D=' + $directory) | Set-Content -LiteralPath ($Config + '.setup') -Encoding UTF8\n        $setup = [pscustomobject]@{ ExitCode = %d }\n        $setup | Add-Member ScriptMethod WaitForExit {}", exitCode), 1)
		script = strings.Replace(script, "    Start-LoopraProcess @start | Out-Null", `    $start | ConvertTo-Json | Set-Content -LiteralPath ($Config + '.launch') -Encoding UTF8`, 1)
		helper := filepath.Join(work, "apply.ps1")
		os.WriteFile(helper, append([]byte{0xef, 0xbb, 0xbf}, []byte(script)...), 0o600)
		output, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Config", config).CombinedOutput()
		if (err == nil) != (exitCode == 0) {
			t.Fatalf("helper exit=%d: %v\n%s", exitCode, err, output)
		}
		command, _ := os.ReadFile(config + ".setup")
		if strings.TrimSpace(string(bytes.TrimPrefix(command, []byte{0xef, 0xbb, 0xbf}))) != "/S /UPDATE /D="+filepath.Dir(target) {
			t.Fatalf("installer command = %s", command)
		}
		_, launchErr := os.Stat(config + ".launch")
		if (launchErr == nil) != (exitCode == 0) {
			t.Fatal("failed setup was allowed to relaunch")
		}
		if app, _ := os.ReadFile(target); string(app) != "installed app" {
			t.Fatal("installer was copied over the application executable")
		}
	}
}

// The updated executable runs just this child test, avoiding any desktop UI.
func TestDesktopUpdateRelaunchChild(t *testing.T) {
	output := os.Getenv("LOOPRA_UPDATE_TEST_CHILD")
	if output == "" {
		t.Skip("installer child process")
	}
	cwd, _ := os.Getwd()
	data, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "args": os.Args[1:], "cwd": cwd})
	if err := os.WriteFile(output, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestDesktopWindowsApplyRestartsUpdatedExecutable(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows installer")
	}
	work := t.TempDir()
	target, staged := filepath.Join(work, "桌面端.exe"), filepath.Join(work, "package")
	os.WriteFile(target, []byte("previous build"), 0o600)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(executable)
	if err != nil {
		t.Fatal(err)
	}
	output, err := os.Create(staged)
	if err != nil {
		input.Close()
		t.Fatal(err)
	}
	_, err = io.Copy(output, input)
	input.Close()
	output.Close()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(work, "restarted.json")
	t.Setenv("LOOPRA_UPDATE_TEST_CHILD", marker)
	args := []string{"-test.run=^TestDesktopUpdateRelaunchChild$", "--", "--home", `C:\测试 数据\`, `quoted"value`, ""}
	data, _ := json.Marshal(map[string]any{"target": target, "staged": staged, "pid": 2147483647, "cwd": work, "args": args})
	config, helper := filepath.Join(work, "apply.json"), filepath.Join(work, "apply.ps1")
	os.WriteFile(config, data, 0o600)
	os.WriteFile(helper, append([]byte{0xef, 0xbb, 0xbf}, []byte(desktopApplyWindows)...), 0o600)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	logs, err := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Config", config).CombinedOutput()
	if err != nil {
		detail, _ := os.ReadFile(config + ".log")
		t.Fatalf("apply/relaunch: %v\n%s\n%s", err, logs, detail)
	}
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		data, err = os.ReadFile(marker)
		if err != nil || !json.Valid(data) {
			continue
		}
		var child struct {
			PID  int
			Args []string
			Cwd  string
		}
		json.Unmarshal(data, &child)
		if process, err := os.FindProcess(child.PID); err == nil {
			process.Wait()
		}
		if strings.Join(child.Args, "\x00") != strings.Join(args, "\x00") || child.Cwd != work {
			t.Fatalf("restarted child = %+v", child)
		}
		if _, err := os.Stat(target + ".old"); !os.IsNotExist(err) {
			t.Fatal("successful restart left a .old backup")
		}
		return
	}
	t.Fatal("updated executable did not restart")
}
