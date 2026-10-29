<#
.SYNOPSIS
  打包前端、Web 服务和桌面端，产物写入仓库 bin/。

.DESCRIPTION
  先在 web/ 执行 pnpm build，再用 -tags webdist 把页面嵌进二进制。
  目标清单是同目录的 package-matrix.txt。

  桌面端只有 windows、linux、darwin 的 amd64 和 arm64。
  Web 另外包含 windows/386、linux/armv7（GOARM=7）和 linux/s390x。

  windows/amd64 会额外做两个硬链接，沿用 bin 里原来的文件名：
    looprax.exe
    looprax-desktop.exe

  darwin 桌面端打成 .app（访达里的名字是 LoopraX），并另写同名 .zip。
  把 zip 拷到 Mac 再解压，可执行权限才还在。

.EXAMPLE
  .\scripts\package.ps1

.EXAMPLE
  .\scripts\package.ps1 -Only web -OS windows -Arch amd64

.EXAMPLE
  .\scripts\package.ps1 -Only desktop -OS linux,darwin -SkipFrontend

.EXAMPLE
  .\scripts\package.cmd -DryRun
#>
[CmdletBinding()]
param(
    [string]$Only = 'frontend,web,desktop',
    [string]$OS = '',
    [string]$Arch = '',
    [string]$Out = '',
    [switch]$SkipFrontend,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Stop-Package {
    param([string]$Message, [int]$Code = 1)
    Write-Host $Message
    exit $Code
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$MatrixPath = Join-Path $PSScriptRoot 'package-matrix.txt'
if (-not $Out) {
    $Out = Join-Path $Root 'bin'
}

function Normalize-Token {
    param([string]$Value)
    switch ($Value.ToLowerInvariant()) {
        'macos' { return 'darwin' }
        'mac' { return 'darwin' }
        'osx' { return 'darwin' }
        'win' { return 'windows' }
        'armv7' { return 'arm' }
        'x64' { return 'amd64' }
        'x86_64' { return 'amd64' }
        'aarch64' { return 'arm64' }
        'x86' { return '386' }
        default { return $Value.ToLowerInvariant() }
    }
}

function Split-Filter {
    param([string]$Filter)
    $items = @()
    if (-not [string]::IsNullOrWhiteSpace($Filter)) {
        $items = @($Filter.Split(',') | ForEach-Object { Normalize-Token $_.Trim() } | Where-Object { $_ -ne '' })
    }
    # 逗号保证 0 个或 1 个结果也按数组返回，避免 foreach 把单个字符串拆成字符。
    return , $items
}

function Test-Selected {
    param([string[]]$Tokens, [string]$Value)
    if ($Tokens.Count -eq 0) {
        return $true
    }
    return $Tokens -contains (Normalize-Token $Value)
}

function Find-Go {
    $cmd = Get-Command go -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) {
        return $cmd.Source
    }
    $found = @()
    foreach ($pattern in @(
            (Join-Path $env:USERPROFILE 'go\go*\bin\go.exe'),
            (Join-Path $env:USERPROFILE 'sdk\go*\bin\go.exe')
        )) {
        $found += @(Get-Item -Path $pattern -ErrorAction SilentlyContinue)
    }
    $best = $found | Sort-Object {
        $version = [version]'0.0.0'
        if ($_.FullName -match 'go(\d+)\.(\d+)(?:\.(\d+))?') {
            $patch = 0
            if ($Matches[3]) { $patch = [int]$Matches[3] }
            $version = [version]('{0}.{1}.{2}' -f [int]$Matches[1], [int]$Matches[2], $patch)
        }
        $version
    } -Descending | Select-Object -First 1
    if (-not $best) {
        Stop-Package '未找到 go。请安装 Go 1.27.3，或把 go.exe 加入 PATH。'
    }
    return $best.FullName
}

function Read-Matrix {
    if (-not (Test-Path -LiteralPath $MatrixPath)) {
        Stop-Package "缺少目标清单 $MatrixPath"
    }
    $rows = @()
    foreach ($line in Get-Content -LiteralPath $MatrixPath) {
        $text = $line.Trim()
        if ($text -eq '' -or $text.StartsWith('#')) {
            continue
        }
        $parts = @($text -split '\s+' | Where-Object { $_ -ne '' })
        if ($parts.Count -lt 3 -or $parts.Count -gt 4) {
            Stop-Package "目标清单格式错误: $text"
        }
        $arm = ''
        if ($parts.Count -eq 4) { $arm = $parts[3] }
        $rows += [pscustomobject]@{
            Product = (Normalize-Token $parts[0])
            OS      = (Normalize-Token $parts[1])
            Arch    = (Normalize-Token $parts[2])
            GOARM   = $arm
        }
    }
    return $rows
}

function Get-ArtifactName {
    param($Row)
    $label = $Row.Arch
    if ($Row.Arch -eq 'arm' -and $Row.GOARM -eq '7') {
        $label = 'armv7'
    }
    $prefix = 'looprax'
    if ($Row.Product -eq 'desktop') {
        $prefix = 'looprax-desktop'
    }
    $name = '{0}-{1}-{2}' -f $prefix, $Row.OS, $label
    if ($Row.OS -eq 'windows') {
        $name += '.exe'
    } elseif ($Row.Product -eq 'desktop' -and $Row.OS -eq 'darwin') {
        $name += '.app'
    }
    return $name
}

function Get-MacBundleVersion {
    $path = Join-Path $Root 'internal\controller\version.go'
    $text = [System.IO.File]::ReadAllText($path)
    if ($text -match 'var Version = "([0-9]+\.[0-9]+\.[0-9]+)') {
        return $Matches[1]
    }
    return '0.1.0'
}

function Find-Python {
    foreach ($name in @('python', 'python3')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) {
            return $cmd.Source
        }
    }
    return $null
}

function Add-AppIcon {
    param([string]$Kind, [string]$Path)
    $python = Find-Python
    if (-not $python) {
        Write-Warning '未找到 Python，跳过图标。'
        return
    }
    & $python (Join-Path $PSScriptRoot 'appicon.py') $Kind $Path
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "图标未写入 $Path"
    }
}

# 把 darwin 桌面二进制套成 LoopraX.app。返回一并写出的 zip，没有 zip 时返回空。
function Publish-DarwinApp {
    param([string]$Binary, [string]$AppPath)
    if (Test-Path -LiteralPath $AppPath) {
        Remove-Item -LiteralPath $AppPath -Recurse -Force
    }
    $macos = Join-Path $AppPath 'Contents\MacOS'
    New-Item -ItemType Directory -Force -Path $macos | Out-Null
    Move-Item -LiteralPath $Binary -Destination (Join-Path $macos 'LoopraX')
    $template = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'macos\Info.plist'))
    $plist = $template.Replace('@VERSION@', (Get-MacBundleVersion))
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $AppPath 'Contents\Info.plist'), $plist, $utf8)
    [System.IO.File]::WriteAllText((Join-Path $AppPath 'Contents\PkgInfo'), 'APPL????', $utf8)
    Add-AppIcon -Kind app -Path $AppPath
    $zip = [System.IO.Path]::ChangeExtension($AppPath, '.zip')
    $python = Find-Python
    if (-not $python) {
        Write-Warning '未找到 Python，已生成 .app。从 Windows 拷到 Mac 后需要 chmod +x Contents/MacOS/LoopraX。'
        return $null
    }
    & $python (Join-Path $PSScriptRoot 'zip-macos-app.py') $AppPath $zip
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $zip)) {
        Write-Warning "未能写出带可执行权限的 zip：$zip"
        return $null
    }
    Write-Host ("  拷到 Mac 用 {0}" -f (Split-Path -Leaf $zip))
    return $zip
}

function Get-AliasName {
    param($Row)
    if ($Row.OS -ne 'windows' -or $Row.Arch -ne 'amd64') {
        return ''
    }
    if ($Row.Product -eq 'web') { return 'looprax.exe' }
    if ($Row.Product -eq 'desktop') { return 'looprax-desktop.exe' }
    return ''
}

function Publish-Alias {
    param([string]$Source, [string]$AliasPath)
    $leaf = Split-Path -Leaf $AliasPath
    try {
        if (Test-Path -LiteralPath $AliasPath) {
            Remove-Item -LiteralPath $AliasPath -Force
        }
        New-Item -ItemType HardLink -Path $AliasPath -Target $Source | Out-Null
        Write-Host "  别名 $leaf"
    } catch {
        try {
            Copy-Item -LiteralPath $Source -Destination $AliasPath -Force
            Write-Host "  别名 $leaf（副本）"
        } catch {
            Write-Warning "无法创建别名 ${leaf}: $($_.Exception.Message)"
        }
    }
}

$onlyTokens = Split-Filter $Only
$osTokens = Split-Filter $OS
$archTokens = Split-Filter $Arch
foreach ($token in $onlyTokens) {
    if (@('frontend', 'web', 'desktop') -notcontains $token) {
        Stop-Package "未知产品 '$token'。可用 frontend、web、desktop。" 2
    }
}
foreach ($token in $osTokens) {
    if (@('windows', 'linux', 'darwin') -notcontains $token) {
        Stop-Package "未知系统 '$token'。可用 windows、linux、darwin（macOS 写作 darwin）。" 2
    }
}
foreach ($token in $archTokens) {
    if (@('amd64', 'arm64', '386', 'arm', 's390x') -notcontains $token) {
        Stop-Package "未知架构 '$token'。可用 amd64、arm64、386、arm、s390x。" 2
    }
}

$wantFrontend = Test-Selected $onlyTokens 'frontend'
$wantWeb = Test-Selected $onlyTokens 'web'
$wantDesktop = Test-Selected $onlyTokens 'desktop'
if (-not $wantFrontend -and -not $wantWeb -and -not $wantDesktop) {
    Stop-Package '没有选择任何产物。' 2
}
# 编 Web 或桌面时默认先打前端，否则嵌进去的还是旧页面。
$buildFrontend = -not $SkipFrontend -and ($wantFrontend -or $wantWeb -or $wantDesktop)
if ($SkipFrontend -and -not $wantWeb -and -not $wantDesktop) {
    Stop-Package '-SkipFrontend 只在同时打包 web 或 desktop 时有意义。' 2
}

$rows = @(Read-Matrix | Where-Object {
        (($_.Product -eq 'web' -and $wantWeb) -or ($_.Product -eq 'desktop' -and $wantDesktop)) -and
        (Test-Selected $osTokens $_.OS) -and
        (Test-Selected $archTokens $_.Arch)
    })
if (($wantWeb -or $wantDesktop) -and $rows.Count -eq 0) {
    Stop-Package '没有符合条件的目标。桌面端只有 windows、linux、darwin 的 amd64 和 arm64。' 2
}

Write-Host ("仓库 {0}" -f $Root)
Write-Host ("输出 {0}" -f $Out)
if ($DryRun) {
    if ($buildFrontend) { Write-Host '前端 web/ （pnpm build）' }
    elseif ($wantWeb -or $wantDesktop) { Write-Host '前端 跳过，使用现有 web/dist' }
    foreach ($row in $rows) {
        $alias = Get-AliasName $row
        $suffix = ''
        if ($alias) { $suffix = "  ->  $alias" }
        Write-Host ("{0,-8} {1,-8} {2,-6} {3}{4}" -f $row.Product, $row.OS, $row.Arch, (Get-ArtifactName $row), $suffix)
    }
    return
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null

if ($buildFrontend) {
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        Stop-Package '未找到 pnpm。请先安装 pnpm，再打包前端。'
    }
    $web = Join-Path $Root 'web'
    if (-not (Test-Path -LiteralPath (Join-Path $web 'node_modules'))) {
        Write-Host '== pnpm install =='
        & pnpm --dir $web install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { Stop-Package "pnpm install 失败，退出码 $LASTEXITCODE" }
    }
    Write-Host '== 前端 =='
    & pnpm --dir $web build
    if ($LASTEXITCODE -ne 0) { Stop-Package "前端构建失败，退出码 $LASTEXITCODE" }
}

if ($rows.Count -eq 0) {
    Write-Host '前端已打包到 web/dist'
    return
}

$index = Join-Path $Root 'web\dist\index.html'
if (-not (Test-Path -LiteralPath $index)) {
    Stop-Package "缺少 $index。先打包前端，或去掉 -SkipFrontend。"
}

$go = Find-Go
$env:GOTOOLCHAIN = 'local'
Write-Host ("== {0} ==" -f (& $go version))
$when = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss') + 'Z'
$ldflags = "-s -w -X github.com/ezdemo/looprax/internal/controller.BuildTime=$when"
$failures = @()
$built = @()

Push-Location $Root
try {
    foreach ($row in $rows) {
        $name = Get-ArtifactName $row
        $dest = Join-Path $Out $name
        $tmp = "$dest.tmp"
        $pkg = './cmd/looprax'
        if ($row.Product -eq 'desktop') { $pkg = './cmd/looprax-desktop' }
        $label = '{0} {1}/{2}' -f $row.Product, $row.OS, $row.Arch
        if ($row.GOARM) { $label = '{0} GOARM={1}' -f $label, $row.GOARM }
        Write-Host "== $label =="
        $saved = @{
            GOOS        = $env:GOOS
            GOARCH      = $env:GOARCH
            GOARM       = $env:GOARM
            CGO_ENABLED = $env:CGO_ENABLED
        }
        try {
            $env:GOOS = $row.OS
            $env:GOARCH = $row.Arch
            $env:CGO_ENABLED = '0'
            if ($row.GOARM) {
                $env:GOARM = $row.GOARM
            } else {
                Remove-Item Env:GOARM -ErrorAction SilentlyContinue
            }
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
            # Windows 桌面端不分配控制台，双击打开时不会冒出黑窗口。
            $buildLdflags = $ldflags
            if ($row.Product -eq 'desktop' -and $row.OS -eq 'windows') {
                $buildLdflags = "$ldflags -H windowsgui"
            }
            & $go build -trimpath -tags webdist -ldflags $buildLdflags -o $tmp $pkg
            if ($LASTEXITCODE -ne 0) {
                throw "go build 退出码 $LASTEXITCODE"
            }
            if ($row.Product -eq 'desktop' -and $row.OS -eq 'darwin') {
                $zip = Publish-DarwinApp -Binary $tmp -AppPath $dest
                $built += $dest
                if ($zip) { $built += $zip }
            } else {
                Move-Item -LiteralPath $tmp -Destination $dest -Force
                $built += $dest
                if ($row.OS -eq 'windows') {
                    Add-AppIcon -Kind exe -Path $dest
                }
                $alias = Get-AliasName $row
                if ($alias) {
                    Publish-Alias -Source $dest -AliasPath (Join-Path $Out $alias)
                }
            }
        } catch {
            $failures += ('{0}: {1}' -f $label, $_.Exception.Message)
            Write-Host ("失败 {0}" -f $_.Exception.Message)
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        } finally {
            foreach ($key in @('GOOS', 'GOARCH', 'GOARM', 'CGO_ENABLED')) {
                if ([string]::IsNullOrEmpty($saved[$key])) {
                    Remove-Item "Env:$key" -ErrorAction SilentlyContinue
                } else {
                    Set-Item "Env:$key" $saved[$key]
                }
            }
        }
    }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host '产物'
foreach ($path in $built) {
    $item = Get-Item -LiteralPath $path
    $bytes = $item.Length
    if ($item.PSIsContainer) {
        $bytes = (Get-ChildItem -LiteralPath $path -Recurse -File | Measure-Object -Property Length -Sum).Sum
        if (-not $bytes) { $bytes = 0 }
    }
    Write-Host ('{0,8:N1} MB  {1}' -f ($bytes / 1MB), $item.Name)
}
if ($failures.Count -gt 0) {
    Write-Host ''
    Write-Host ('失败 {0} 个目标' -f $failures.Count)
    foreach ($failure in $failures) { Write-Host "  $failure" }
    exit 1
}
