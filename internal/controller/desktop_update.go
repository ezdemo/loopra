package controller

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const desktopReleaseAPI = "https://api.github.com/repos/ezdemo/loopra-release/releases"
const maxDesktopDownload = 512 << 20

var stableReleaseVersion = regexp.MustCompile(`^v?\d+\.\d+\.\d+$`)
var releaseComments = regexp.MustCompile(`(?s)<!--.*?-->`)
var releaseHeading = regexp.MustCompile(`(?i)^## LoopraX? v[^\r\n]+\r?\n`)

type desktopUpdateState struct {
	PackageType    string  `json:"packageType,omitempty"`
	Supported      bool    `json:"supported"`
	CurrentVersion string  `json:"currentVersion"`
	LatestVersion  string  `json:"latestVersion"`
	Status         string  `json:"status"`
	Percent        float64 `json:"percent"`
	Transferred    int64   `json:"transferred"`
	Total          int64   `json:"total"`
	BytesPerSecond float64 `json:"bytesPerSecond"`
	Error          string  `json:"error"`
	CheckedAt      string  `json:"checkedAt"`
	Revision       uint64  `json:"revision"`
	Source         string  `json:"source"`
	ChangingSource bool    `json:"changingSource"`
}

type desktopAsset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}

type desktopRelease struct {
	Tag         string         `json:"tag_name"`
	Name        string         `json:"name"`
	Body        string         `json:"body"`
	PublishedAt string         `json:"published_at"`
	Draft       bool           `json:"draft"`
	Prerelease  bool           `json:"prerelease"`
	Assets      []desktopAsset `json:"assets"`
}

type desktopNote struct {
	Version     string `json:"version"`
	Name        string `json:"name"`
	Body        string `json:"body"`
	PublishedAt string `json:"publishedAt"`
	URL         string `json:"url"`
}

type desktopNotes struct {
	CurrentVersion string        `json:"currentVersion"`
	LatestVersion  string        `json:"latestVersion"`
	Releases       []desktopNote `json:"releases"`
	Complete       bool          `json:"complete"`
}

type desktopUpdater struct {
	mu                                    sync.Mutex
	state                                 desktopUpdateState
	home, executable, platform, arch, api string
	client                                *http.Client
	quit                                  func()
	ctx                                   context.Context
	cancel                                context.CancelFunc
	operationCancel                       context.CancelFunc
	asset                                 desktopAsset
	staged                                string
	notesMu                               sync.Mutex
	history                               []desktopNote
	historyAt                             time.Time
	historyComplete                       bool
}

func newDesktopUpdater(home string, quit func()) *desktopUpdater {
	executable, _ := os.Executable()
	executable, _ = filepath.EvalSymlinks(executable)
	ctx, cancel := context.WithCancel(context.Background())
	u := &desktopUpdater{home: home, executable: executable, platform: runtime.GOOS, arch: runtime.GOARCH,
		api: desktopReleaseAPI, client: &http.Client{Timeout: 10 * time.Minute}, quit: quit, ctx: ctx, cancel: cancel,
		state: desktopUpdateState{Supported: true, CurrentVersion: strings.TrimPrefix(Version, "v"), Status: "idle", Source: "normal"}}
	if runtime.GOOS == "windows" {
		u.state.PackageType = windowsDesktopPackageType(executable, runtime.GOARCH)
	}
	if data, err := os.ReadFile(filepath.Join(home, "updates", "desktop-source.json")); err == nil {
		var source string
		if json.Unmarshal(data, &source) == nil {
			if _, err := updateMirror(source); err == nil {
				u.state.Source = source
			}
		}
	}
	return u
}

func (u *desktopUpdater) snapshot() desktopUpdateState {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.state
}

func (u *desktopUpdater) autoCheck() {
	// Let the local API/window finish starting before making network requests.
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-u.ctx.Done():
			return
		case <-timer.C:
			u.startCheck()
			timer.Reset(30 * time.Minute)
		}
	}
}

func (u *desktopUpdater) getJSON(ctx context.Context, target string, dest any) error {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Loopra/"+Version)
	resp, err := u.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("获取发布信息失败（HTTP %d）", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 16<<20)).Decode(dest)
}

func desktopAssetName(platform, arch string) string {
	name := "loopra-desktop-" + platform + "-" + arch
	if platform == "windows" {
		name += ".exe"
	}
	if platform == "darwin" {
		name += ".zip"
	}
	return name
}

func windowsDesktopPackageType(executable, arch string) string {
	if !strings.EqualFold(filepath.Base(executable), "Loopra.exe") {
		return "portable"
	}
	var marker struct{ PackageType, Scope, Arch string }
	data, err := os.ReadFile(filepath.Join(filepath.Dir(executable), "loopra-install.json"))
	if err != nil || json.Unmarshal(data, &marker) != nil || marker.PackageType != "nsis" || marker.Scope != "user" || marker.Arch != arch {
		return "portable"
	}
	if info, err := os.Stat(filepath.Join(filepath.Dir(executable), "Uninstall.exe")); err != nil || !info.Mode().IsRegular() {
		return "portable"
	}
	return "nsis"
}

func (u *desktopUpdater) updateAssetName() string {
	name := desktopAssetName(u.platform, u.arch)
	if u.platform == "windows" && u.state.PackageType == "nsis" {
		name = strings.TrimSuffix(name, ".exe") + "-setup.exe"
	}
	return name
}

func (u *desktopUpdater) stagedPackage() string {
	if u.platform == "windows" && u.state.PackageType == "nsis" {
		return "Loopra-Update.exe"
	}
	return "package"
}

func validDesktopAssetURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host == "github.com" && parsed.User == nil &&
		strings.HasPrefix(parsed.Path, "/ezdemo/loopra-release/releases/download/") && parsed.RawQuery == "" && parsed.Fragment == ""
}

func (u *desktopUpdater) startCheck() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.state.Status == "checking" || u.state.Status == "downloading" || u.state.Status == "verifying" || u.state.Status == "downloaded" || u.state.Status == "installing" {
		return
	}
	u.beginCheckLocked()
}

func (u *desktopUpdater) beginCheckLocked() {
	ctx, cancel := context.WithCancel(u.ctx)
	u.operationCancel = cancel
	u.state.Status, u.state.Error = "checking", ""
	u.state.Percent, u.state.Transferred, u.state.Total, u.state.BytesPerSecond = 0, 0, 0, 0
	u.state.Revision++
	go func() {
		defer cancel()
		var release desktopRelease
		err := u.getJSON(ctx, u.api+"/latest", &release)
		if err == nil && (release.Draft || release.Prerelease || !stableReleaseVersion.MatchString(release.Tag)) {
			err = fmt.Errorf("发布服务返回了无效的正式版本")
		}
		var asset desktopAsset
		if err == nil && compareVersion(release.Tag, u.state.CurrentVersion) > 0 {
			for _, candidate := range release.Assets {
				if candidate.Name == u.updateAssetName() {
					asset = candidate
					break
				}
			}
			if asset.Name == "" {
				err = fmt.Errorf("该版本没有适合 %s/%s 的桌面更新包", u.platform, u.arch)
			}
			if err == nil && (!validDesktopAssetURL(asset.URL) || asset.Size <= 0 || asset.Size > maxDesktopDownload) {
				err = fmt.Errorf("桌面更新包信息无效")
			}
		}
		u.mu.Lock()
		defer u.mu.Unlock()
		if ctx.Err() != nil {
			return
		}
		u.state.CheckedAt = time.Now().UTC().Format(time.RFC3339)
		if err != nil {
			u.failLocked(err)
			return
		}
		u.state.LatestVersion = strings.TrimPrefix(release.Tag, "v")
		u.state.Status = "idle"
		u.state.Revision++
		if asset.Name != "" {
			u.asset = asset
			u.beginDownloadLocked()
		}
	}()
}

func (u *desktopUpdater) failLocked(err error) {
	u.state.Status, u.state.Error = "error", err.Error()
	u.state.Revision++
}

func (u *desktopUpdater) setSource(source string) error {
	if _, err := updateMirror(source); err != nil {
		return err
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.state.Status == "verifying" || u.state.Status == "downloaded" || u.state.Status == "installing" {
		return fmt.Errorf("更新包已就绪，暂时不能切换下载源")
	}
	data, _ := json.Marshal(source)
	if err := os.MkdirAll(filepath.Join(u.home, "updates"), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(u.home, "updates", "desktop-source.json"), data, 0o600); err != nil {
		return err
	}
	if u.operationCancel != nil {
		u.operationCancel()
	}
	u.state.Source = source
	u.beginCheckLocked()
	return nil
}

func (u *desktopUpdater) beginDownloadLocked() {
	ctx, cancel := context.WithCancel(u.ctx)
	u.operationCancel = cancel
	asset, source := u.asset, u.state.Source
	u.state.Status = "downloading"
	u.state.Total = asset.Size
	u.state.Revision++
	go func() {
		defer cancel()
		staged, err := u.download(ctx, asset, source)
		u.mu.Lock()
		defer u.mu.Unlock()
		if ctx.Err() != nil {
			if staged != "" {
				os.RemoveAll(staged)
			}
			return
		}
		if err != nil {
			u.failLocked(err)
			return
		}
		u.staged = staged
		u.state.Status, u.state.Percent, u.state.BytesPerSecond = "downloaded", 100, 0
		u.state.Revision++
	}()
}

func (u *desktopUpdater) download(ctx context.Context, asset desktopAsset, source string) (string, error) {
	directory := filepath.Join(u.home, "updates")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", err
	}
	work, err := os.MkdirTemp(directory, "desktop-")
	if err != nil {
		return "", err
	}
	success := false
	defer func() {
		if !success {
			os.RemoveAll(work)
		}
	}()
	checksum := strings.TrimPrefix(asset.Digest, "sha256:")
	decoded, err := hex.DecodeString(checksum)
	if err != nil || len(decoded) != sha256.Size || !strings.HasPrefix(asset.Digest, "sha256:") {
		return "", fmt.Errorf("发布包缺少有效的 SHA-256 校验值")
	}
	mirror, _ := updateMirror(source)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, mirror+asset.URL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Loopra-Updater/"+Version)
	resp, err := u.client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载更新失败（HTTP %d）", resp.StatusCode)
	}
	packagePath := filepath.Join(work, u.stagedPackage())
	file, err := os.OpenFile(packagePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	reader := io.LimitReader(resp.Body, maxDesktopDownload+1)
	buffer := make([]byte, 128<<10)
	var transferred int64
	started, last := time.Now(), time.Time{}
	for {
		n, readErr := reader.Read(buffer)
		if n > 0 {
			_, err = io.MultiWriter(file, hash).Write(buffer[:n])
			transferred += int64(n)
			if err != nil || transferred > asset.Size {
				if err == nil {
					err = fmt.Errorf("更新包大小与发布信息不符")
				}
				break
			}
			if time.Since(last) > 200*time.Millisecond {
				u.mu.Lock()
				if ctx.Err() == nil {
					u.state.Transferred, u.state.Percent = transferred, float64(transferred)*100/float64(asset.Size)
					u.state.BytesPerSecond = float64(transferred) / time.Since(started).Seconds()
					u.state.Revision++
				}
				u.mu.Unlock()
				last = time.Now()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				err = readErr
			}
			break
		}
	}
	closeErr := file.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	u.mu.Lock()
	if ctx.Err() == nil {
		u.state.Status = "verifying"
		u.state.Transferred = transferred
		u.state.Revision++
	}
	u.mu.Unlock()
	if transferred != asset.Size || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), checksum) {
		return "", fmt.Errorf("更新包校验失败，请重新下载")
	}
	if u.platform == "darwin" {
		if err := extractDesktopApp(packagePath, work); err != nil {
			return "", err
		}
	} else {
		if err := validateDesktopBinary(packagePath, u.platform); err != nil {
			return "", err
		}
		if err := os.Chmod(packagePath, 0o755); err != nil {
			return "", err
		}
	}
	success = true
	return work, nil
}

func validateDesktopBinary(path, platform string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var magic [4]byte
	_, err = io.ReadFull(f, magic[:])
	if err == nil && ((platform == "windows" && string(magic[:2]) == "MZ") || (platform == "linux" && string(magic[:]) == "\x7fELF") ||
		(platform == "darwin" && (string(magic[:]) == "\xcf\xfa\xed\xfe" || string(magic[:]) == "\xfe\xed\xfa\xcf"))) {
		return nil
	}
	return fmt.Errorf("下载包不是有效的 %s 程序", platform)
}

// Extract only ordinary bundle files; links and paths outside the staging folder
// must never be written by an update archive.
func extractDesktopApp(archivePath, work string) error {
	archive, err := zip.OpenReader(archivePath)
	if err != nil {
		return err
	}
	defer archive.Close()
	var total uint64
	for _, entry := range archive.File {
		name := filepath.ToSlash(entry.Name)
		parts := strings.SplitN(name, "/", 2)
		if len(parts) != 2 || !strings.HasSuffix(parts[0], ".app") {
			return fmt.Errorf("更新压缩包不是有效的 macOS 应用")
		}
		rel := filepath.Clean(filepath.FromSlash(parts[1]))
		if rel == "." && entry.FileInfo().IsDir() {
			continue
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) || strings.Contains(rel, ":") || entry.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("更新压缩包包含不安全的路径")
		}
		target := filepath.Join(work, "Loopra.app", rel)
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if !entry.Mode().IsRegular() {
			return fmt.Errorf("更新压缩包包含特殊文件")
		}
		total += entry.UncompressedSize64
		if total > maxDesktopDownload {
			return fmt.Errorf("解压后的更新包过大")
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		input, err := entry.Open()
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if strings.HasPrefix(filepath.ToSlash(rel), "Contents/MacOS/") {
			mode = 0o755
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
		if err != nil {
			input.Close()
			return err
		}
		_, err = io.Copy(output, io.LimitReader(input, maxDesktopDownload+1))
		input.Close()
		closeErr := output.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	if _, err := os.Stat(filepath.Join(work, "Loopra.app", "Contents", "Info.plist")); err != nil {
		return err
	}
	return validateDesktopBinary(filepath.Join(work, "Loopra.app", "Contents", "MacOS", "Loopra"), "darwin")
}

func cleanDesktopNotes(body string) string {
	body = releaseComments.ReplaceAllString(body, "")
	body = releaseHeading.ReplaceAllString(body, "")
	for _, heading := range []string{"\n### 下载\r\n", "\n### 下载\n"} {
		body = strings.SplitN(body, heading, 2)[0]
	}
	return strings.TrimSpace(body)
}

func (u *desktopUpdater) releaseNotes(ctx context.Context) (desktopNotes, error) {
	u.notesMu.Lock()
	defer u.notesMu.Unlock()
	state := u.snapshot()
	if time.Since(u.historyAt) > 5*time.Minute {
		history := []desktopNote{}
		complete := false
		for page := 1; page <= 10; page++ {
			var batch []desktopRelease
			if err := u.getJSON(ctx, fmt.Sprintf("%s?per_page=100&page=%d", u.api, page), &batch); err != nil {
				return desktopNotes{}, err
			}
			for _, release := range batch {
				if release.Draft || release.Prerelease || !stableReleaseVersion.MatchString(release.Tag) {
					continue
				}
				history = append(history, desktopNote{Version: strings.TrimPrefix(release.Tag, "v"), Name: release.Name, Body: cleanDesktopNotes(release.Body), PublishedAt: release.PublishedAt,
					URL: "https://github.com/ezdemo/loopra-release/releases/tag/" + url.PathEscape(release.Tag)})
			}
			if len(batch) < 100 {
				complete = true
				break
			}
		}
		sort.Slice(history, func(i, j int) bool { return compareVersion(history[i].Version, history[j].Version) > 0 })
		u.history, u.historyAt, u.historyComplete = history, time.Now(), complete
	}
	latest := state.LatestVersion
	if latest == "" && len(u.history) > 0 {
		latest = u.history[0].Version
	}
	notes := desktopNotes{CurrentVersion: state.CurrentVersion, LatestVersion: latest, Complete: u.historyComplete, Releases: []desktopNote{}}
	for _, note := range u.history {
		if (compareVersion(latest, state.CurrentVersion) > 0 && compareVersion(note.Version, state.CurrentVersion) > 0 && compareVersion(note.Version, latest) <= 0) ||
			(compareVersion(latest, state.CurrentVersion) <= 0 && compareVersion(note.Version, state.CurrentVersion) == 0) {
			notes.Releases = append(notes.Releases, note)
		}
	}
	return notes, nil
}

func (s *Controller) desktopUpdateController(w http.ResponseWriter, r *http.Request) {
	u := s.desktopUpdater
	if u == nil {
		writeFail(w, http.StatusNotFound, "当前服务没有桌面更新器")
		return
	}
	var err error
	switch strings.TrimPrefix(r.URL.Path, "/api/desktop-update/") {
	case "notes":
		notes, cause := u.releaseNotes(r.Context())
		if cause != nil {
			writeFail(w, http.StatusBadGateway, cause.Error())
			return
		}
		writeOK(w, http.StatusOK, notes)
		return
	case "check", "download":
		u.startCheck()
	case "source":
		var body struct {
			Source string `json:"source"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body) != nil {
			writeFail(w, http.StatusBadRequest, "更新源无效")
			return
		}
		err = u.setSource(body.Source)
	case "install":
		err = u.install()
	}
	if err != nil {
		writeFail(w, http.StatusBadRequest, err.Error())
		return
	}
	writeOK(w, http.StatusOK, u.snapshot())
}
