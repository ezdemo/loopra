package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func findDesktopApp(name string) string {
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	if name == "git-bash.exe" {
		for _, root := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs")} {
			path := filepath.Join(root, "Git", "git-bash.exe")
			if info, err := os.Stat(path); err == nil && !info.IsDir() {
				return path
			}
		}
	}
	return ""
}

func desktopApplications() []string {
	apps := []string{"folder"}
	if runtime.GOOS == "windows" {
		if findDesktopApp("powershell.exe") != "" {
			apps = append(apps, "powershell", "terminal")
		}
		if findDesktopApp("git-bash.exe") != "" {
			apps = append(apps, "git-bash", "bash")
		}
	} else {
		if findDesktopApp("pwsh") != "" {
			apps = append(apps, "powershell")
		}
		if runtime.GOOS == "darwin" || findDesktopApp("x-terminal-emulator") != "" || findDesktopApp("gnome-terminal") != "" {
			apps = append(apps, "bash", "terminal")
		}
	}
	return apps
}

func (s *Controller) systemAction(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimPrefix(r.URL.Path, "/api/system/")
	switch action {
	case "version":
		s.versionController(w, r)
	case "open-applications":
		writeOK(w, http.StatusOK, desktopApplications())
	case "open-workspace":
		var body struct {
			WorkspaceHash string `json:"workspaceHash"`
			Application   string `json:"application"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil || body.WorkspaceHash == "" {
			writeFail(w, http.StatusBadRequest, "请选择有效的项目")
			return
		}
		if !containsString(desktopApplications(), body.Application) {
			writeFail(w, http.StatusBadRequest, "不支持的打开方式")
			return
		}
		path, err := s.resolveProject(body.WorkspaceHash)
		if err != nil {
			writeFail(w, http.StatusBadRequest, "项目不存在，请刷新项目列表")
			return
		}
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			writeFail(w, http.StatusBadRequest, "项目文件夹不存在或无法访问")
			return
		}
		cmd, err := desktopCommand(path, body.Application)
		if err != nil {
			writeFail(w, http.StatusBadRequest, err.Error())
			return
		}
		cmd.Dir = path
		if err := cmd.Start(); err != nil {
			writeFail(w, http.StatusBadRequest, "无法打开所选应用: "+err.Error())
			return
		}
		go cmd.Wait()
		writeOK(w, http.StatusOK, path)
	case "pick-directory":
		var body struct {
			Path string `json:"path"`
		}
		if r.Body != nil {
			_ = json.NewDecoder(r.Body).Decode(&body)
		}
		var cmd *exec.Cmd
		switch runtime.GOOS {
		case "windows":
			cmd = exec.CommandContext(r.Context(), "powershell.exe", "-STA", "-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.SelectedPath = $env:LOOPRA_PICK_DIRECTORY; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); [Console]::Write($dialog.SelectedPath) }; $dialog.Dispose()`)
			cmd.Env = append(os.Environ(), "LOOPRA_PICK_DIRECTORY="+body.Path)
			hideProcess(cmd)
		case "darwin":
			cmd = exec.CommandContext(r.Context(), "osascript", "-e", `POSIX path of (choose folder with prompt "Select project folder")`)
		default:
			cmd = exec.CommandContext(r.Context(), "zenity", "--file-selection", "--directory", "--filename="+body.Path)
		}
		out, err := cmd.Output()
		if err != nil {
			if _, cancelled := err.(*exec.ExitError); cancelled {
				writeOK(w, http.StatusOK, "")
				return
			}
			writeFail(w, http.StatusBadRequest, "无法打开目录选择器: "+err.Error())
			return
		}
		writeOK(w, http.StatusOK, strings.TrimSpace(string(out)))
	default:
		writeFail(w, http.StatusNotFound, "未找到路径")
	}
}

func desktopCommand(path, application string) (*exec.Cmd, error) {
	if application == "folder" {
		switch runtime.GOOS {
		case "windows":
			return exec.Command("explorer.exe", path), nil
		case "darwin":
			return exec.Command("open", path), nil
		default:
			return exec.Command("xdg-open", path), nil
		}
	}
	if runtime.GOOS == "windows" {
		if application == "bash" || application == "git-bash" {
			return exec.Command(findDesktopApp("git-bash.exe"), "--cd="+path), nil
		}
		shell := findDesktopApp("pwsh.exe")
		if shell == "" {
			shell = findDesktopApp("powershell.exe")
		}
		cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath $env:LOOPRA_OPEN_EXECUTABLE -ArgumentList @('-NoLogo','-NoProfile','-NoExit') -WorkingDirectory $env:LOOPRA_OPEN_DIRECTORY -WindowStyle Normal -ErrorAction Stop`)
		cmd.Env = append(os.Environ(), "LOOPRA_OPEN_EXECUTABLE="+shell, "LOOPRA_OPEN_DIRECTORY="+path)
		hideProcess(cmd)
		return cmd, nil
	}
	shell := "bash"
	if application == "powershell" {
		shell = "pwsh"
	}
	if runtime.GOOS == "darwin" {
		return exec.Command("osascript", "-e", "on run argv\n tell application \"Terminal\"\n activate\n do script \"cd -- \" & quoted form of (item 1 of argv) & \"; exec \" & quoted form of (item 2 of argv)\n end tell\nend run", path, shell), nil
	}
	if executable := findDesktopApp("gnome-terminal"); executable != "" {
		return exec.Command(executable, "--working-directory="+path, "--", shell), nil
	}
	if executable := findDesktopApp("x-terminal-emulator"); executable != "" {
		return exec.Command(executable, "-e", shell), nil
	}
	return nil, fmt.Errorf("未找到桌面终端")
}
