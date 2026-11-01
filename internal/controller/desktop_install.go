package controller

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ezdemo/looprax/internal/infrastructure/hideconsole"
)

// Run independently of the local HTTP server, so replacing the application can
// wait for the WebView and executable handles to close. Keep the previous build
// until the replacement has been moved into place.
const desktopApplyWindows = `param([string]$Config)
$ErrorActionPreference = 'Stop'
function Start-LoopraProcess([string]$FilePath, [string]$ArgumentList, [string]$WorkingDirectory) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $FilePath
    $info.Arguments = $ArgumentList
    $info.WorkingDirectory = $WorkingDirectory
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = 'Hidden'
    return [System.Diagnostics.Process]::Start($info)
}
$c = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
$backup = $c.target + '.old'
$replacement = $c.target + '.new'
try {
    $parent = Get-Process -Id $c.pid -ErrorAction SilentlyContinue
    if ($parent) { $parent.WaitForExit() }
    if ($c.packageType -eq 'nsis') {
        $directory = [System.IO.Path]::GetDirectoryName($c.target)
        # NSIS requires /D last, without quotes, including when the path has spaces.
        $setup = Start-LoopraProcess -FilePath $c.staged -ArgumentList ('/S /UPDATE /D=' + $directory) -WorkingDirectory $c.cwd
        $setup.WaitForExit()
        if ($setup.ExitCode -ne 0) { throw ('Installer failed with exit code ' + $setup.ExitCode) }
    } else {
        Copy-Item -LiteralPath $c.staged -Destination $replacement -Force
        $installed = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            try {
                Move-Item -LiteralPath $c.target -Destination $backup -Force
                try { Move-Item -LiteralPath $replacement -Destination $c.target -Force }
                catch { Move-Item -LiteralPath $backup -Destination $c.target -Force; throw }
                $installed = $true
                break
            } catch { Start-Sleep -Seconds 1 }
        }
        if (-not $installed) { throw 'Unable to replace the executable; the previous version was preserved' }
    }
    function Quote-Argument([string]$value) {
        return '"' + [regex]::Replace([regex]::Replace($value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
    }
    $start = @{ FilePath = $c.target; WorkingDirectory = $c.cwd }
    if ($c.args.Count -gt 0) { $start.ArgumentList = (($c.args | ForEach-Object { Quote-Argument $_ }) -join ' ') }
    Start-LoopraProcess @start | Out-Null
    Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $c.staged -Force
} catch {
    $_ | Out-String | Set-Content -LiteralPath ($Config + '.log')
    if (-not (Test-Path -LiteralPath $c.target) -and (Test-Path -LiteralPath $backup)) {
        Move-Item -LiteralPath $backup -Destination $c.target -Force
    }
    exit 1
}
`

const desktopApplyUnix = `#!/bin/sh
set -eu
pid=$1; target=$2; staged=$3; cwd=$4; platform=$5
shift 5
while kill -0 "$pid" 2>/dev/null; do sleep 1; done
cd "$cwd"
replacement="$target.new"
backup="$target.old"
if [ "$platform" = darwin ]; then
    # ditto preserves the complete app bundle, including resources and metadata.
    ditto "$staged" "$replacement"
else
    cp "$staged" "$replacement"
    chmod 755 "$replacement"
fi
if [ -e "$backup" ]; then
    # Only remove our known sibling backup, never a computed application root.
    if [ "$platform" = darwin ]; then rm -rf -- "$backup"; else rm -f -- "$backup"; fi
fi
mv -- "$target" "$backup"
if ! mv -- "$replacement" "$target"; then mv -- "$backup" "$target"; exit 1; fi
if [ "$platform" = darwin ]; then
    xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
    open -n "$target" --args "$@"
else
    nohup "$target" "$@" </dev/null >/dev/null 2>&1 &
fi
if [ "$platform" = darwin ]; then rm -rf -- "$backup"; else rm -f -- "$backup"; fi
`

func (u *desktopUpdater) install() error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.state.Supported {
		return fmt.Errorf("%s", u.state.UnsupportedReason)
	}
	if u.state.Status != "downloaded" || u.staged == "" {
		return fmt.Errorf("请先下载并校验桌面更新")
	}
	target, staged := u.executable, filepath.Join(u.staged, u.stagedPackage())
	if u.platform == "darwin" {
		if filepath.Base(filepath.Dir(target)) != "MacOS" || filepath.Base(filepath.Dir(filepath.Dir(target))) != "Contents" {
			return fmt.Errorf("请从已解压的 .app 中运行桌面端后再安装更新")
		}
		target = filepath.Dir(filepath.Dir(filepath.Dir(target)))
		if !strings.HasSuffix(target, ".app") {
			return fmt.Errorf("当前程序不在 .app 中")
		}
		staged = filepath.Join(u.staged, "Loopra.app")
	}
	probe, err := os.CreateTemp(filepath.Dir(target), ".loopra-update-")
	if err != nil {
		return fmt.Errorf("程序目录不可写，请将 Loopra 移到可写目录后重试：%w", err)
	}
	probe.Close()
	os.Remove(probe.Name())
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	var cmd *exec.Cmd
	if u.platform == "windows" {
		helper := filepath.Join(u.staged, "apply.ps1")
		config := filepath.Join(u.staged, "apply.json")
		data, err := json.Marshal(map[string]any{"target": target, "staged": staged, "pid": os.Getpid(), "cwd": cwd, "args": os.Args[1:], "packageType": u.state.PackageType})
		if err != nil {
			return err
		}
		if err := os.WriteFile(config, data, 0o600); err != nil {
			return err
		}
		if err := os.WriteFile(helper, append([]byte{0xef, 0xbb, 0xbf}, []byte(desktopApplyWindows)...), 0o600); err != nil {
			return err
		}
		cmd = exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Config", config)
	} else {
		helper := filepath.Join(u.staged, "apply.sh")
		if err := os.WriteFile(helper, []byte(desktopApplyUnix), 0o700); err != nil {
			return err
		}
		args := []string{helper, strconv.Itoa(os.Getpid()), target, staged, cwd, u.platform}
		cmd = exec.Command("sh", append(args, os.Args[1:]...)...)
	}
	hideconsole.Apply(cmd)
	log, err := os.OpenFile(filepath.Join(u.staged, "install.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		log.Close()
		return err
	}
	log.Close()
	go cmd.Wait()
	u.state.Status = "installing"
	u.state.Revision++
	// Give the install response time to reach the renderer before stopping HTTP.
	time.AfterFunc(500*time.Millisecond, u.quit)
	return nil
}
