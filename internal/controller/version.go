package controller

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ezdemo/looprax/internal/repository"
)

var Version = "0.1.0-go"
var BuildTime = ""

//go:embed update_scripts/update.ps1 update_scripts/update.sh
var updateScripts embed.FS

type updateJob struct {
	mu                      sync.Mutex
	cmd                     *exec.Cmd
	cancel                  context.CancelFunc
	running                 bool
	state, logFile, message string
}

func compareVersion(a, b string) int {
	parts := func(value string) []string {
		value = strings.TrimLeft(value, "vV")
		value = strings.SplitN(value, "-", 2)[0]
		return strings.Split(value, ".")
	}
	left, right := parts(a), parts(b)
	for i := 0; i < len(left) || i < len(right); i++ {
		x, y := 0, 0
		if i < len(left) {
			x, _ = strconv.Atoi(left[i])
		}
		if i < len(right) {
			y, _ = strconv.Atoi(right[i])
		}
		if x > y {
			return 1
		}
		if x < y {
			return -1
		}
	}
	return 0
}

func (s *Controller) checkVersion(w http.ResponseWriter, r *http.Request) {
	target := os.Getenv("LOOPRAX_RELEASE_LATEST_URL")
	if target == "" {
		target = "https://github.com/ezdemo/loopra-release/releases/latest"
	}
	checkTime := time.Now().Format("2006-01-02 15:04:05")
	view := map[string]any{"currentVersion": Version, "latestVersion": Version, "hasNewVersion": false, "checkTime": checkTime}
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err == nil {
		req.Header.Set("User-Agent", "Looprax/"+Version)
		client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		var resp *http.Response
		resp, err = client.Do(req)
		if err == nil {
			resp.Body.Close()
			location := resp.Header.Get("Location")
			index := strings.LastIndex(location, "/tag/")
			if resp.StatusCode >= 300 && resp.StatusCode < 400 && index >= 0 {
				latest := strings.TrimLeft(location[index+5:], "vV")
				view["latestVersion"], view["hasNewVersion"], view["releaseUrl"] = latest, compareVersion(latest, Version) > 0, target
			} else {
				err = fmt.Errorf("无法从重定向中获取最新版本号 (HTTP %d)", resp.StatusCode)
			}
		}
	}
	if err != nil {
		view["releaseNotes"] = "版本检查失败: " + err.Error()
	}
	writeOK(w, http.StatusOK, view)
}

func updateMirror(source string) (string, error) {
	switch strings.TrimSpace(strings.ToLower(source)) {
	case "", "normal":
		return "", nil
	case "mirror":
		return "https://gh-proxy.org/", nil
	}
	parsed, err := url.Parse(source)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", fmt.Errorf("不支持的更新来源")
	}
	if !containsString([]string{"gh-proxy.org", "github.boki.moe", "wget.la", "gh.monlor.com", "fastgit.cc", "ghproxy.net", "ghfast.top", "gh-proxy.com", "down.npee.cn", "ghproxy.vip"}, parsed.Hostname()) {
		return "", fmt.Errorf("不支持的更新来源")
	}
	return "https://" + parsed.Hostname() + "/", nil
}

func (s *Controller) updateController(w http.ResponseWriter, r *http.Request) {
	job := s.state.updater
	job.mu.Lock()
	defer job.mu.Unlock()
	if strings.HasSuffix(r.URL.Path, "/stop") {
		if !job.running {
			writeFail(w, http.StatusBadRequest, "当前没有正在进行的更新")
			return
		}
		job.state, job.running, job.message = "stopped", false, "更新已停止"
		job.cancel()
	} else if r.Method == http.MethodPost {
		if job.running {
			writeFail(w, http.StatusBadRequest, "核心服务更新已在进行中")
			return
		}
		var body struct {
			Source string `json:"source"`
		}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		mirror, err := updateMirror(body.Source)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		extension := ".sh"
		if runtime.GOOS == "windows" {
			extension = ".ps1"
		}
		script := os.Getenv("LOOPRAX_UPDATE_SCRIPT")
		if script == "" {
			script = filepath.Join(s.home, "updates", "update"+extension)
			content, err := updateScripts.ReadFile("update_scripts/update" + extension)
			if err != nil {
				writeFail(w, http.StatusInternalServerError, err.Error())
				return
			}
			if runtime.GOOS == "windows" {
				content = append([]byte{0xef, 0xbb, 0xbf}, content...)
			}
			if err := repository.WriteFile(script, content); err != nil {
				writeFail(w, http.StatusInternalServerError, err.Error())
				return
			}
		}
		info, err := os.Stat(script)
		if err != nil || info.IsDir() {
			writeFail(w, http.StatusBadRequest, "未安装 Looprax 更新脚本，请配置 LOOPRAX_UPDATE_SCRIPT 或通过发行包更新")
			return
		}
		script, err = filepath.Abs(script)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		directory := filepath.Join(s.home, "updates")
		if err := os.MkdirAll(directory, 0o755); err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		logFile := filepath.Join(directory, "update-"+time.Now().Format("20060102-150405")+"-"+newMsgID()+".log")
		log, err := os.OpenFile(logFile, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		ctx, cancel := context.WithCancel(context.Background())
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
		} else {
			cmd = exec.CommandContext(ctx, "bash", script)
		}
		hideProcess(cmd)
		executable, err := os.Executable()
		if err != nil {
			cancel()
			log.Close()
			writeFail(w, http.StatusInternalServerError, err.Error())
			return
		}
		cmd.Env = append(os.Environ(), "LOOPRA_MIRROR="+mirror, "LOOPRA_HOME="+s.home, "LOOPRAX_UPDATE_TARGET="+executable, "LOOPRAX_UPDATE_PID="+strconv.Itoa(os.Getpid()), "LOOPRAX_UPDATE_ARCH="+runtime.GOARCH, "LOOPRAX_UPDATE_OS="+runtime.GOOS)
		cmd.Stdout, cmd.Stderr, cmd.Dir = log, log, directory
		if err := cmd.Start(); err != nil {
			cancel()
			log.Close()
			writeFail(w, http.StatusBadRequest, "无法启动核心更新: "+err.Error())
			return
		}
		job.cmd, job.cancel, job.running, job.state, job.logFile, job.message = cmd, cancel, true, "running", logFile, "核心服务更新正在执行"
		go func() {
			err := cmd.Wait()
			log.Close()
			job.mu.Lock()
			defer job.mu.Unlock()
			if job.cmd != cmd || job.state == "stopped" {
				return
			}
			job.running = false
			if err != nil {
				job.state, job.message = "failed", "更新失败: "+err.Error()
			} else {
				job.state, job.message = "success", "更新完成，请重新启动服务"
			}
		}()
	}
	state, message := job.state, job.message
	if state == "" {
		state, message = "idle", "暂无更新任务"
	}
	logText := ""
	if job.logFile != "" {
		if file, err := os.Open(job.logFile); err == nil {
			if info, err := file.Stat(); err == nil {
				offset := info.Size() - 64*1024
				if offset > 0 {
					file.Seek(offset, 0)
				}
			}
			raw, _ := io.ReadAll(io.LimitReader(file, 64*1024))
			file.Close()
			logText = string(raw)
		}
	}
	platform, target := runtime.GOOS, "核心服务"
	if state == "idle" {
		platform, target = "", ""
	}
	writeOK(w, http.StatusOK, map[string]any{"running": job.running, "state": state, "platform": platform, "target": target, "logFile": job.logFile, "log": logText, "message": message})
}
