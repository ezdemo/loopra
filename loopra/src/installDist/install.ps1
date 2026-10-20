#
# Loopra Web Installer for Windows PowerShell
# 支持重复安装，保留已有 config.json
# 复用系统 Java 17+ 或已有捆绑 JRE；都没有时自动下载 JRE 25（支持 LOOPRA_MIRROR 镜像）
# 桌面端可用 -SkipJava 先更新核心文件，随后单独引导安装 Java。
#
param(
    [switch]$Gui,
    [switch]$Setup,
    [switch]$SkipJava
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "   Loopra Web Installer (PowerShell)" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# =============================================
# 设置源目录和目标目录
# =============================================
$SOURCE_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $SOURCE_DIR) { $SOURCE_DIR = $PWD.Path }

$SOURCE_BIN_DIR = Join-Path $SOURCE_DIR "bin"
$SOURCE_CONFIG = Join-Path $SOURCE_DIR "config.json"
$SOURCE_AGENTS = Join-Path $SOURCE_DIR "loopra.md"

$CONFIG_DIR = Join-Path $env:USERPROFILE ".loopra"
$TARGET_DIR = if ($Gui) { Join-Path $env:USERPROFILE ".loopra-gui" } else { $CONFIG_DIR }
$IS_GUI_INSTALL = $Gui
$TARGET_BIN_DIR = Join-Path $TARGET_DIR "bin"
$TARGET_CONFIG = Join-Path $CONFIG_DIR "config.json"
$TARGET_AGENTS = Join-Path $CONFIG_DIR "loopra.md"
$JRE25_DIR = Join-Path $TARGET_DIR "jre25"

# =============================================
# Pre-check: 复用系统 Java 17+ 或已有捆绑 JRE；
# 都没有时自动下载 JRE 25（参考桌面端逻辑，支持 LOOPRA_MIRROR 镜像）
# =============================================
function Get-JavaVersionOutput {
    param([string]$JavaPath)
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo.FileName = $JavaPath
    $process.StartInfo.Arguments = "-version"
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.UseShellExecute = $false
    $process.Start() | Out-Null
    $out = $process.StandardError.ReadToEnd()
    $process.WaitForExit() | Out-Null
    return $out
}

function Test-JavaUsable {
    param([string]$JavaPath)
    if (-not $JavaPath -or -not (Test-Path $JavaPath)) { return $false }
    try {
        $verOut = Get-JavaVersionOutput $JavaPath
        if ($verOut -match '"(\d+)') {
            return ([int]$Matches[1] -ge 17)
        }
    } catch { }
    return $false
}

Write-Host ""
if ($SkipJava) {
    Write-Host "[Pre-check] Core-only install: Java setup is managed by the desktop app." -ForegroundColor Gray
} else {
Write-Host "[Pre-check] Verifying Java 17+ installation..." -ForegroundColor Yellow

$JAVA_EXE = $null
$JAVA_SOURCE = ""

# 1. 优先系统 Java（需 17+）
$sysJava = Get-Command java -ErrorAction SilentlyContinue
if ($sysJava -and (Test-JavaUsable $sysJava.Source)) {
    $JAVA_EXE = $sysJava.Source
    $JAVA_SOURCE = "System Java"
    Write-Host "      System Java found: $((Get-JavaVersionOutput $JAVA_EXE -split "`n" | Select-Object -First 1).Trim())" -ForegroundColor Gray
} elseif ($sysJava) {
    Write-Host "      System Java too old, checking bundled JRE..." -ForegroundColor Yellow
} else {
    Write-Host "      No system Java found, checking bundled JRE..." -ForegroundColor Yellow
}

# 2. 复用已有捆绑 JRE（~/.loopra/jre25 或 ~/.loopra-gui/jre25）
if (-not $JAVA_EXE) {
    $bundled = @(
        (Join-Path $JRE25_DIR "bin\java.exe"),
        (Join-Path $JRE25_DIR "bin\java"),
        (Join-Path $JRE25_DIR "Contents\Home\bin\java")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($bundled -and (Test-JavaUsable $bundled)) {
        $JAVA_EXE = $bundled
        $JAVA_SOURCE = "Bundled JRE ($JRE25_DIR)"
        Write-Host "      Bundled JRE found: $JRE25_DIR" -ForegroundColor Gray
    }
}

# 3. 都没有 → 自动下载 JRE 25（Adoptium 最新 LTS，经 GitHub 直连或 LOOPRA_MIRROR 指定的镜像）
if (-not $JAVA_EXE) {
    Write-Host ""
    Write-Host "      No usable Java found, downloading JRE 25 automatically..." -ForegroundColor Yellow

    # 3.1 解析平台（复刻桌面端 getJre25Platform）
    $os = "windows"
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64" { "x64" }
        "ARM64" { "aarch64" }
        "x86"   { "x32" }
        default { "x64" }
    }

    # 3.2 Adoptium assets API 获取最新 JRE 25 的 GitHub 直链
    $assetsApi = "https://api.adoptium.net/v3/assets/latest/25/hotspot?os=$os&architecture=$arch&image_type=jre&heap_size=normal&vendor=eclipse"
    $asset = $null
    try {
        $list = Invoke-RestMethod -Uri $assetsApi -TimeoutSec 30 -Headers @{ "User-Agent" = "Loopra/Installer" }
        $asset = if ($list -is [array]) { $list[0] } else { $list }
    } catch {
        Write-Host "      [Error] Failed to query Adoptium API: $($_.Exception.Message)" -ForegroundColor Red
    }

    if (-not $asset -or -not $asset.binary.package.link) {
        Write-Host ""
        Write-Host "[Error] Unable to resolve JRE 25 download address (network issue or no internet access)." -ForegroundColor Red
        Write-Host ""
        Write-Host "  Please install Java 17 or later manually:" -ForegroundColor White
        Write-Host "    - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/" -ForegroundColor White
        Write-Host "    - injdk.cn: https://injdk.cn" -ForegroundColor White
        Write-Host ""
        if (-not $Setup) { Read-Host "Press Enter to exit" }
        exit 1
    }

    $assetVersion = $asset.version.semver
    $fileName = $asset.binary.package.name
    $githubUrl = $asset.binary.package.link
    Write-Host "      Latest JRE 25: $assetVersion ($fileName)" -ForegroundColor Gray

    # 3.3 拼接下载地址（支持 LOOPRA_MIRROR 用户指定镜像，与更新脚本一致）
    $mirror = $env:LOOPRA_MIRROR
    $downloadUrl = $githubUrl
    if ($mirror) {
        $downloadUrl = $mirror.TrimEnd('/') + "/" + $githubUrl
        Write-Host "      Download via mirror: $mirror" -ForegroundColor Gray
    }

    # 3.4 下载到临时目录
    $jreTmpDir = Join-Path $env:TEMP "loopra-jre25-install"
    if (Test-Path $jreTmpDir) { Remove-Item -Recurse -Force $jreTmpDir }
    New-Item -ItemType Directory -Path $jreTmpDir -Force | Out-Null
    $archivePath = Join-Path $jreTmpDir $fileName
    try {
        Write-Host "      Downloading JRE 25 ..." -ForegroundColor Gray
        Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath -UseBasicParsing -TimeoutSec 600
    } catch {
        Write-Host "      [Error] JRE download failed: $($_.Exception.Message)" -ForegroundColor Red
        Remove-Item -Recurse -Force $jreTmpDir -ErrorAction SilentlyContinue
        exit 1
    }

    # 3.5 解压并安装到 $JRE25_DIR
    try {
        $extractDir = Join-Path $jreTmpDir "extract"
        New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
        Write-Host "      Extracting JRE 25 ..." -ForegroundColor Gray
        if ($archivePath -like "*.zip") {
            Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
        } else {
            tar -xzf $archivePath -C $extractDir
        }
        # 归档根目录通常是 jdk-25.0.x+y-jre，把其中内容整体搬到目标目录
        $extractEntries = Get-ChildItem -Path $extractDir -Force | Where-Object { $_.Name -ne "." -and $_.Name -ne ".." }
        $rootDir = if ($extractEntries.Count -eq 1 -and $extractEntries[0].PSIsContainer) { $extractEntries[0].FullName } else { $extractDir }
        if (Test-Path $JRE25_DIR) { Remove-Item -Recurse -Force $JRE25_DIR }
        New-Item -ItemType Directory -Path $JRE25_DIR -Force | Out-Null
        Copy-Item -Path (Join-Path $rootDir "*") -Destination $JRE25_DIR -Recurse -Force
        Remove-Item -Recurse -Force $jreTmpDir
        Write-Host "      JRE 25 installed to $JRE25_DIR" -ForegroundColor Green
    } catch {
        Write-Host "      [Error] JRE extraction failed: $($_.Exception.Message)" -ForegroundColor Red
        Remove-Item -Recurse -Force $jreTmpDir -ErrorAction SilentlyContinue
        exit 1
    }

    # 3.6 复用刚下载的 JRE
    $newJre = @(
        (Join-Path $JRE25_DIR "bin\java.exe"),
        (Join-Path $JRE25_DIR "bin\java"),
        (Join-Path $JRE25_DIR "Contents\Home\bin\java")
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($newJre -and (Test-JavaUsable $newJre)) {
        $JAVA_EXE = $newJre
        $JAVA_SOURCE = "Bundled JRE (downloaded)"
    }
}

if (-not $JAVA_EXE) {
    Write-Host ""
    Write-Host "[Error] Java 17+ is not available after JRE download attempt." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Please install Java 17 or later:" -ForegroundColor White
    Write-Host "    - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/" -ForegroundColor White
    Write-Host "    - injdk.cn: https://injdk.cn" -ForegroundColor White
    Write-Host ""
    if (-not $Setup) { Read-Host "Press Enter to exit" }
    exit 1
}

$javaVerLine = ((Get-JavaVersionOutput $JAVA_EXE) -split "`n" | Select-Object -First 1).Trim()
Write-Host "      Java ready ($JAVA_SOURCE): $javaVerLine" -ForegroundColor Green
}
Write-Host ""

# =============================================
# 检查源目录是否存在
# =============================================
if (-not (Test-Path $SOURCE_BIN_DIR)) {
    Write-Host "[Error] Source bin directory not found: $SOURCE_BIN_DIR" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# =============================================
# [1/5] 检查并备份已有的 config.json 和 loopra.md
# =============================================
Write-Host "[1/5] Checking for existing configuration..." -ForegroundColor Yellow

$CONFIG_BACKUP = $null
$AGENTS_BACKUP = $null

if (Test-Path $TARGET_CONFIG) {
    $CONFIG_BACKUP = Join-Path $env:TEMP "loopra_config_backup_$(Get-Random).json"
    Copy-Item $TARGET_CONFIG $CONFIG_BACKUP -Force
    Write-Host "      Found existing config.json (will be preserved)" -ForegroundColor Gray
} else {
    Write-Host "      No existing config.json found" -ForegroundColor Gray
}

if (Test-Path $TARGET_AGENTS) {
    $AGENTS_BACKUP = Join-Path $env:TEMP "loopra_agents_backup_$(Get-Random).md"
    Copy-Item $TARGET_AGENTS $AGENTS_BACKUP -Force
    Write-Host "      Found existing loopra.md (will be preserved)" -ForegroundColor Gray
} else {
    Write-Host "      No existing loopra.md found" -ForegroundColor Gray
}

# =============================================
# [2/5] 创建目标目录结构
# =============================================
Write-Host ""
Write-Host "[2/5] Preparing target directory: $TARGET_DIR" -ForegroundColor Yellow

if (-not (Test-Path $TARGET_DIR)) { New-Item -ItemType Directory -Path $TARGET_DIR -Force | Out-Null }
if (-not (Test-Path $CONFIG_DIR)) { New-Item -ItemType Directory -Path $CONFIG_DIR -Force | Out-Null }
if (-not (Test-Path $TARGET_BIN_DIR)) { New-Item -ItemType Directory -Path $TARGET_BIN_DIR -Force | Out-Null }

Write-Host "      Created directory structure" -ForegroundColor Gray

# =============================================
# [3/5] 复制文件
# =============================================
Write-Host ""
Write-Host "[3/5] Copying files to target directory..." -ForegroundColor Yellow

Copy-Item -Path "$SOURCE_BIN_DIR\*" -Destination $TARGET_BIN_DIR -Recurse -Force
Write-Host "      Copied bin/ directory" -ForegroundColor Gray

if (Test-Path $SOURCE_CONFIG) {
    Copy-Item $SOURCE_CONFIG $TARGET_CONFIG -Force
    Write-Host "      Copied config.json" -ForegroundColor Gray
}

if (Test-Path $SOURCE_AGENTS) {
    Copy-Item $SOURCE_AGENTS $TARGET_AGENTS -Force
    Write-Host "      Copied loopra.md" -ForegroundColor Gray
}

Write-Host "      Files copied successfully" -ForegroundColor Green

# =============================================
# [4/5] 恢复 config.json 和 loopra.md 并检查 jar 文件
# =============================================
Write-Host ""
Write-Host "[4/5] Finalizing installation..." -ForegroundColor Yellow

if ($CONFIG_BACKUP -and (Test-Path $CONFIG_BACKUP)) {
    Copy-Item $CONFIG_BACKUP $TARGET_CONFIG -Force
    Remove-Item $CONFIG_BACKUP -Force
    Write-Host "      Preserved existing config.json" -ForegroundColor Gray
}

if ($AGENTS_BACKUP -and (Test-Path $AGENTS_BACKUP)) {
    Copy-Item $AGENTS_BACKUP $TARGET_AGENTS -Force
    Remove-Item $AGENTS_BACKUP -Force
    Write-Host "      Preserved existing loopra.md" -ForegroundColor Gray
}

$JAR_FILE = Join-Path $TARGET_BIN_DIR "loopra-web.jar"
if (-not (Test-Path $JAR_FILE)) {
    Write-Host ""
    Write-Host "[Error] loopra-web.jar not found in $TARGET_BIN_DIR" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "      Found loopra-web.jar" -ForegroundColor Gray

# =============================================
# [5/5] 创建启动脚本并配置 PATH（系统 Java 或已有捆绑 JRE）
# =============================================
Write-Host ""
Write-Host "[5/5] Setting up 'loopra' command..." -ForegroundColor Yellow

# —— PowerShell 启动脚本 (loopra.ps1) ——
$LAUNCHER_PS1 = Join-Path $TARGET_BIN_DIR "loopra.ps1"
$LAUNCHER_PS1_CONTENT = @'
# Loopra Launcher for PowerShell — uses system Java (or bundled JRE)
param([Parameter(ValueFromRemainingArguments)]$RestArgs)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$LoopraHome = Split-Path -Parent $ScriptDir
$JreDir = Join-Path $LoopraHome "jre25"

# 优先系统 Java，其次复用已有捆绑 JRE（兼容旧安装）
$JavaBin = $null
$sysJava = Get-Command java -ErrorAction SilentlyContinue
if ($sysJava) {
    $JavaBin = $sysJava.Source
} else {
    foreach ($candidate in @((Join-Path $JreDir "bin\java.exe"), (Join-Path $JreDir "bin\java"), (Join-Path $JreDir "Contents\Home\bin\java"))) {
        if (Test-Path $candidate) { $JavaBin = $candidate; break }
    }
}
if (-not $JavaBin) {
    Write-Host "[ERROR] No Java found." -ForegroundColor Red
    Write-Host "  Please install Java 17 or later:" -ForegroundColor Gray
    Write-Host "    - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/" -ForegroundColor Gray
    Write-Host "    - injdk.cn: https://injdk.cn" -ForegroundColor Gray
    exit 1
}

# 显示帮助
$ShowHelp = ($RestArgs.Count -eq 0)
if (-not $ShowHelp -and $RestArgs.Count -ge 1) {
    $first = $RestArgs[0]
    if ($first -eq '-h' -or $first -eq '--help' -or $first -eq 'help') {
        $ShowHelp = $true
    }
}
if ($ShowHelp) {
    Write-Host "Loopra — AI Coding Assistant" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Usage:" -ForegroundColor Yellow
    Write-Host "  loopra web [port]    Start the web server"
    Write-Host "  loopra acp [wsPort]  Start with ACP protocol support"
    Write-Host ""
    Write-Host "Options:" -ForegroundColor Yellow
    Write-Host "  port    0 = random port, 8097 = default, or any port number"
    Write-Host "  wsPort  ACP WebSocket port (omit for stdio mode)"
    Write-Host ""
    Write-Host "Examples:" -ForegroundColor Yellow
    Write-Host "  loopra web           Start on default port (8097)"
    Write-Host "  loopra web 0         Start on a random available port"
    Write-Host "  loopra acp           Start ACP stdio + Web random"
    Write-Host "  loopra acp 8765      Start ACP WebSocket:8765 + Web random"
    Write-Host ""
    Write-Host "  loopra -h            Show this help"
    exit 0
}

$JarFile = Join-Path $ScriptDir "loopra-web.jar"

if (-not (Test-Path $JarFile)) {
    Write-Host "[Error] loopra-web.jar not found" -ForegroundColor Red
    Write-Host "Expected path: $JarFile"
    exit 1
}

# 设置控制台编码为 UTF-8
try {
    $OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# 检测 Java 版本，如果是 21+ 则添加 --enable-native-access 参数
$JavaArgs = @("-Dfile.encoding=UTF-8", "-Dstdout.encoding=UTF-8", "-Dstderr.encoding=UTF-8", "-Dstdin.encoding=UTF-8")

try {
    $VerProcess = New-Object System.Diagnostics.Process
    $VerProcess.StartInfo.FileName = $JavaBin
    $VerProcess.StartInfo.Arguments = "-version"
    $VerProcess.StartInfo.RedirectStandardError = $true
    $VerProcess.StartInfo.RedirectStandardOutput = $true
    $VerProcess.StartInfo.UseShellExecute = $false
    $VerProcess.Start() | Out-Null
    $VerOutput = $VerProcess.StandardError.ReadToEnd()
    $VerProcess.WaitForExit()
    
    if ($VerOutput -match '"(\d+)') {
        $JavaMajor = [int]$Matches[1]
        if ($JavaMajor -ge 21) {
            $JavaArgs += "--enable-native-access=ALL-UNNAMED"
        }
    }
} catch { }

# 解析 "web [port]" / "acp [wsPort]" 子命令
$PassThroughArgs = @()
$i = 0
while ($i -lt $RestArgs.Count) {
    if ($RestArgs[$i] -eq 'web' -and $i -eq 0) {
        $PassThroughArgs += "--solon.logging.appender.console.enable=false"
        $i++
        if ($i -lt $RestArgs.Count -and $RestArgs[$i] -match '^\d+$') {
            $portArg = $RestArgs[$i]
            if ($portArg -eq '0') {
                $found = $false
                for ($n = 0; $n -lt 30; $n++) {
                    $candidate = Get-Random -Minimum 1024 -Maximum 65535
                    try {
                        $tcp = New-Object System.Net.Sockets.TcpClient
                        $tcp.Connect('127.0.0.1', $candidate)
                        $tcp.Close()
                    } catch {
                        $portArg = $candidate
                        $found = $true
                        break
                    }
                }
                if (-not $found) { $portArg = Get-Random -Minimum 1024 -Maximum 65535 }
                Write-Host "Random port: $portArg" -ForegroundColor Green
            }
            $PassThroughArgs += "--server.port=$portArg"
            $i++
        }
    } elseif ($RestArgs[$i] -eq 'acp' -and $i -eq 0) {
        # ACP 模式：Web 随机端口 + ACP (stdio/WebSocket)
        $PassThroughArgs += "--solon.logging.appender.console.enable=false"
        # Web UI 始终随机端口
        $portArg = Get-Random -Minimum 1024 -Maximum 65535
        $PassThroughArgs += "--server.port=$portArg"
        # ACP 标志
        $PassThroughArgs += "--loopra.acp=true"
        $i++
        # 可选参数：ACP WebSocket 端口（不传则 stdio 模式）
        if ($i -lt $RestArgs.Count -and $RestArgs[$i] -match '^\d+$') {
            Write-Host "ACP WebSocket port: $($RestArgs[$i])"
            $PassThroughArgs += "--loopra.acp.ws.port=$($RestArgs[$i])"
            $i++
        }
    } else {
        $PassThroughArgs += $RestArgs[$i]
        $i++
    }
}

# 运行 Java 程序
& $JavaBin @JavaArgs -jar $JarFile @PassThroughArgs
'@

Set-Content -Path $LAUNCHER_PS1 -Value $LAUNCHER_PS1_CONTENT -Encoding UTF8
Write-Host "      Created: loopra.ps1" -ForegroundColor Gray

# —— CMD/.bat 启动脚本 (loopra.bat) ——
# NOTE: .bat must be ASCII-only (no Chinese), written in system default encoding (GBK on zh-CN Windows)
$LAUNCHER_BAT = Join-Path $TARGET_BIN_DIR "loopra.bat"
$LAUNCHER_BAT_CONTENT = @'
@echo off
rem Loopra Launcher for CMD - uses system Java (or bundled JRE)
setlocal enabledelayedexpansion

rem Locate script dir
set "SCRIPT_DIR=%~dp0"
set "LOOPRA_HOME=%SCRIPT_DIR%.."

rem Prefer system Java, then fall back to existing bundled JRE (old installs)
set "JAVA_BIN="
where java >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "JAVA_BIN=java"
) else (
    if exist "%LOOPRA_HOME%\jre25\bin\java.exe" (
        set "JAVA_BIN=%LOOPRA_HOME%\jre25\bin\java.exe"
    ) else if exist "%LOOPRA_HOME%\jre25\bin\java" (
        set "JAVA_BIN=%LOOPRA_HOME%\jre25\bin\java"
    ) else if exist "%LOOPRA_HOME%\jre25\Contents\Home\bin\java" (
        set "JAVA_BIN=%LOOPRA_HOME%\jre25\Contents\Home\bin\java"
    )
)
if not defined JAVA_BIN (
    echo [ERROR] No Java found.
    echo   Please install Java 17 or later:
    echo     - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/
    echo     - injdk.cn: https://injdk.cn
    exit /b 1
)

rem Show help (no args / -h / --help / help)
if "%~1"=="" goto :show_help
if "%~1"=="-h" goto :show_help
if "%~1"=="--help" goto :show_help
if "%~1"=="help" goto :show_help
goto :parse_args

:show_help
echo Loopra - AI Coding Assistant
echo.
echo Usage:
echo   loopra web [port]    Start the web server
echo   loopra acp [wsPort]  Start with ACP protocol support
echo.
echo Options:
echo   port    0 = random port, 8097 = default, or any port number
echo   wsPort  ACP WebSocket port (omit for stdio mode)
echo.
echo Examples:
echo   loopra web           Start on default port (8097)
echo   loopra web 0         Start on a random available port
echo   loopra acp           Start ACP stdio + Web random
echo   loopra acp 8765      Start ACP WebSocket:8765 + Web random
echo.
echo   loopra -h            Show this help
goto :end

:parse_args
set "JAR_FILE=%SCRIPT_DIR%loopra-web.jar"

if not exist "%JAR_FILE%" (
    echo [Error] loopra-web.jar not found
    echo Expected path: %JAR_FILE%
    exit /b 1
)

rem Java encoding options
set "JAVA_OPTS=-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -Dstdin.encoding=UTF-8"

rem Add --enable-native-access for Java 21+
for /f "tokens=3" %%v in ('"%JAVA_BIN%" -version 2^>^&1 ^| findstr /i version') do (
    set "VER=%%v"
    set "VER=!VER:~1!"
    for /f "tokens=1 delims=." %%j in ("!VER!") do (
        if %%j GEQ 21 set "JAVA_OPTS=!JAVA_OPTS! --enable-native-access=ALL-UNNAMED"
    )
)

rem Parse "web [port]" subcommand
set "PASS_ARGS="
set "NEXT_IS_PORT="
set "FIRST_ARG=1"
for %%a in (%*) do (
    if "!FIRST_ARG!"=="1" (
        if "%%a"=="web" (
            set "PASS_ARGS=!PASS_ARGS! --solon.logging.appender.console.enable=false"
            set "NEXT_IS_PORT=1"
        ) else if "%%a"=="acp" (
            rem ACP 模式：Web 随机端口 + ACP(stdio/WebSocket)
            rem Web UI 随机端口
            set /a PORT=!RANDOM! + 30000
            set "PASS_ARGS=!PASS_ARGS! --solon.logging.appender.console.enable=false"
            set "PASS_ARGS=!PASS_ARGS! --server.port=!PORT!"
            set "PASS_ARGS=!PASS_ARGS! --loopra.acp=true"
            set "NEXT_IS_ACP_PORT=1"
        ) else (
            set "PASS_ARGS=!PASS_ARGS! %%a"
        )
        set "FIRST_ARG=0"
    ) else (
        if defined NEXT_IS_PORT (
            if "%%a"=="0" (
                set /a PORT=!RANDOM! + 30000
                echo Random port: !PORT!
                set "PASS_ARGS=!PASS_ARGS! --server.port=!PORT!"
            ) else (
                set "PASS_ARGS=!PASS_ARGS! --server.port=%%a"
            )
            set "NEXT_IS_PORT="
        ) else if defined NEXT_IS_ACP_PORT (
            echo ACP WebSocket port: %%a
            set "PASS_ARGS=!PASS_ARGS! --loopra.acp.ws.port=%%a"
            set "NEXT_IS_ACP_PORT="
        ) else (
            set "PASS_ARGS=!PASS_ARGS! %%a"
        )
    )
)

rem Run Java
"%JAVA_BIN%" %JAVA_OPTS% -jar "%JAR_FILE%" %PASS_ARGS%

:end
'@

# Write .bat in system default encoding (GBK on zh-CN Windows) to avoid garbled chars in CMD
[System.IO.File]::WriteAllText($LAUNCHER_BAT, $LAUNCHER_BAT_CONTENT, [System.Text.Encoding]::Default)
Write-Host "      Created: loopra.bat" -ForegroundColor Gray

# —— Git Bash 启动脚本 (loopra) ——
$LAUNCHER_SH = Join-Path $TARGET_BIN_DIR "loopra"
$LAUNCHER_SH_CONTENT = @'
#!/bin/bash
# Loopra Launcher for Git Bash / WSL — uses system Java (or bundled JRE)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOOPRA_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"

# 优先系统 Java，其次复用已有捆绑 JRE（兼容旧安装）
JAVA_BIN=""
if command -v java &> /dev/null; then
    JAVA_BIN="java"
elif [ -f "$LOOPRA_HOME/jre25/bin/java" ]; then
    JAVA_BIN="$LOOPRA_HOME/jre25/bin/java"
elif [ -f "$LOOPRA_HOME/jre25/Contents/Home/bin/java" ]; then
    # macOS: JRE 有时在 Contents/Home 下
    JAVA_BIN="$LOOPRA_HOME/jre25/Contents/Home/bin/java"
else
    echo "[ERROR] No Java found."
    echo "  Please install Java 17 or later:"
    echo "    - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/"
    echo "    - injdk.cn: https://injdk.cn"
    exit 1
fi

# 显示帮助（无参数 或 -h/--help/help）
if [ $# -eq 0 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ] || [ "$1" = "help" ]; then
    echo -e "\033[0;36mLoopra — AI Coding Assistant\033[0m"
    echo ""
    echo -e "\033[0;33mUsage:\033[0m"
    echo "  loopra web [port]    Start the web server"
    echo "  loopra acp [wsPort]  Start with ACP protocol support"
    echo ""
    echo -e "\033[0;33mOptions:\033[0m"
    echo "  wsPort  ACP WebSocket port (omit for stdio mode)"
    echo ""
    echo -e "\033[0;33mExamples:\033[0m"
    echo "  loopra web           Start on default port (8097)"
    echo "  loopra web 0         Start on a random available port"
    echo "  loopra acp           Start ACP stdio + Web random"
    echo "  loopra acp 8765      Start ACP WebSocket:8765 + Web random"
    echo ""
    echo "  loopra -h            Show this help"
    echo "  loopra -h            Show this help"
    exit 0
fi

# 检测 Java 版本，如果是 21+ 则添加 --enable-native-access 参数
JAVA_VER=$("$JAVA_BIN" -version 2>&1 | head -n1 | grep -oE '"[0-9]+' | grep -oE '[0-9]+' | head -1)
if [ -z "$JAVA_VER" ]; then
    JAVA_VER=$("$JAVA_BIN" -version 2>&1 | head -n1 | cut -d'"' -f2 | cut -d'.' -f1)
fi
JAVA_OPTS="-Dfile.encoding=UTF-8"
if [ -n "$JAVA_VER" ] && [ "$JAVA_VER" -ge 21 ]; then
    JAVA_OPTS="$JAVA_OPTS --enable-native-access=ALL-UNNAMED"
fi

# 解析 "web [port]" 子命令
PASSTHROUGH_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        web)
            PASSTHROUGH_ARGS+=("--solon.logging.appender.console.enable=false")
            shift
            if [ $# -gt 0 ] && echo "$1" | grep -qE '^[0-9]+$'; then
                if [ "$1" = "0" ]; then
                    PORT=$(( RANDOM % 55536 + 10000 ))
                    echo "Random port: $PORT"
                    PASSTHROUGH_ARGS+=("--server.port=$PORT")
                else
                    PASSTHROUGH_ARGS+=("--server.port=$1")
                fi
                shift
            fi
            ;;
        acp)
            # ACP 模式：Web 随机端口 + ACP (stdio/WebSocket)
            PASSTHROUGH_ARGS+=("--solon.logging.appender.console.enable=false")
            # Web UI 始终随机端口
            PORT=$(( RANDOM % 55536 + 10000 ))
            echo "Web random port: $PORT"
            PASSTHROUGH_ARGS+=("--server.port=$PORT")
            # ACP 标志
            PASSTHROUGH_ARGS+=("--loopra.acp=true")
            shift
            # 可选参数：ACP WebSocket 端口（不传则 stdio 模式）
            if [ $# -gt 0 ] && echo "$1" | grep -qE '^[0-9]+$'; then
                echo "ACP WebSocket port: $1"
                PASSTHROUGH_ARGS+=("--loopra.acp.ws.port=$1")
                shift
            fi
            ;;
        *)
            PASSTHROUGH_ARGS+=("$1")
            shift
            ;;
    esac
done

"$JAVA_BIN" $JAVA_OPTS -jar "$SCRIPT_DIR/loopra-web.jar" "${PASSTHROUGH_ARGS[@]}"
'@

Set-Content -Path $LAUNCHER_SH -Value $LAUNCHER_SH_CONTENT -Encoding UTF8 -NoNewline
Write-Host "      Created: loopra (for Git Bash)" -ForegroundColor Gray

# =============================================
# 配置 PATH 环境变量（桌面运行时不注册命令行 PATH）
# =============================================
if (-not $IS_GUI_INSTALL) {
    Write-Host ""
    Write-Host "Configuring PATH..." -ForegroundColor Yellow

    $USER_PATH = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($USER_PATH -like "*$TARGET_BIN_DIR*") {
        Write-Host "      Already in user PATH" -ForegroundColor Gray
    } else {
        $NEW_PATH = if ($USER_PATH) { "$USER_PATH;$TARGET_BIN_DIR" } else { $TARGET_BIN_DIR }
        [Environment]::SetEnvironmentVariable("Path", $NEW_PATH, "User")
        Write-Host "      Added to user PATH" -ForegroundColor Green
    }
} else {
    Write-Host "      Desktop runtime: skipped PATH registration" -ForegroundColor Gray
}

# =============================================
# 完成
# =============================================
Write-Host ""
Write-Host "============================================" -ForegroundColor Green
Write-Host "   Installation Complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Install path: $TARGET_DIR" -ForegroundColor White
Write-Host "  Config path:  $CONFIG_DIR" -ForegroundColor White
if ($SkipJava) {
    Write-Host "  Java:         Setup deferred to desktop app; JRE/JDK required to start" -ForegroundColor White
} else {
    Write-Host "  Java:         System Java 17+ / existing bundled JRE / auto-downloaded JRE 25 ($JRE25_DIR)" -ForegroundColor White
}
Write-Host ""
if ($IS_GUI_INSTALL) {
    Write-Host "  Desktop runtime is managed by the Loopra Desktop app." -ForegroundColor Cyan
} else {
    Write-Host "  Usage:" -ForegroundColor Cyan
    Write-Host "    1. Open a NEW terminal window (PowerShell or Git Bash)"
    Write-Host "    2. Run: 'loopra web'        (default port 8097)"
    Write-Host "       Run: 'loopra web 0'      (random port)"
    Write-Host "       Run: 'loopra web 9636'   (specify port 9636)"
}
Write-Host ""
Write-Host "  Directory structure:" -ForegroundColor Cyan
Write-Host "    $TARGET_DIR\"
Write-Host "    +-- jre25/           (auto-downloaded or existing bundled JRE 25)"
Write-Host "    +-- bin/             (executables)"
Write-Host "        +-- loopra-web.jar"
Write-Host "        +-- loopra.ps1       (PowerShell launcher)"
Write-Host "        +-- loopra.bat       (CMD launcher)"
Write-Host "        +-- loopra           (Git Bash launcher)"
Write-Host "        +-- uninstall.ps1    (uninstall script)"
Write-Host "    $CONFIG_DIR\"
Write-Host "    +-- config.json      (configuration, preserved)"
Write-Host "    +-- loopra.md        (project docs, preserved)"
Write-Host ""
Write-Host "  API Endpoint:" -ForegroundColor Cyan
Write-Host "    http://localhost:8097"
Write-Host ""
Write-Host "  [Tip] To use loopra immediately in current terminal:" -ForegroundColor Yellow
Write-Host "    PowerShell: `$env:Path = [Environment]::GetEnvironmentVariable('Path','User')"
Write-Host ""

# If not called from a setup script, wait for user input
if (-not $Setup) {
    Read-Host "Press Enter to exit"
}
