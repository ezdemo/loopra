[CmdletBinding()]
param(
    [switch]$KeepNativeSymbols
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$mobileRoot = Split-Path $PSScriptRoot -Parent
$repoRoot = Split-Path $mobileRoot -Parent
$tauriRoot = Join-Path $mobileRoot 'src-tauri'
$manifestPath = Join-Path $tauriRoot 'Cargo.toml'
$lockPath = Join-Path $tauriRoot 'Cargo.lock'
$cacheRoot = Join-Path $repoRoot '.cache'
$tempRoot = Join-Path $cacheRoot 'mobile-native-tmp\clang-temp'
$vendorRoot = Join-Path $cacheRoot 'mobile-vendor'
$logRoot = Join-Path $cacheRoot 'mobile-android-build'
$buildLog = Join-Path $logRoot 'tauri-build.log'
$nativeLibrary = Join-Path $tauriRoot 'target/aarch64-linux-android/debug/libloopra_mobile_lib.so'
$savedEnvironment = @{}
$manifestSnapshot = $null
$lockSnapshot = $null

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Set-BuildEnvironment([string]$Name, [string]$Value) {
    if (-not $savedEnvironment.ContainsKey($Name)) {
        $savedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    }
    Set-Item -Path "Env:$Name" -Value $Value
}

function Format-NativeOutput($Item) {
    if ($Item -is [System.Management.Automation.ErrorRecord] -and $Item.Exception) {
        return $Item.Exception.Message
    }
    return $Item.ToString()
}

function Restore-BuildEnvironment {
    foreach ($entry in $savedEnvironment.GetEnumerator()) {
        if ($null -eq $entry.Value) {
            Remove-Item -Path "Env:$($entry.Key)" -ErrorAction SilentlyContinue
        } else {
            Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
        }
    }
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $mobileRoot) {
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object { Format-NativeOutput $_ }
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
        $ErrorActionPreference = $previousErrorAction
    }
    if ($exitCode -ne 0) {
        throw "Command failed with exit code ${exitCode}: $FilePath $($Arguments -join ' ')"
    }
}

function Find-CommandPath([string]$Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Find-WinLibsBin {
    $fromPath = Find-CommandPath 'x86_64-w64-mingw32-gcc.exe'
    if ($fromPath) {
        $bin = Split-Path $fromPath -Parent
        if (Test-Path -LiteralPath (Join-Path $bin 'as.exe')) { return $bin }
    }

    $packages = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    if (-not (Test-Path -LiteralPath $packages)) { return $null }
    $candidates = Get-ChildItem -LiteralPath $packages -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'BrechtSanders.WinLibs*' } |
        ForEach-Object { Join-Path $_.FullName 'mingw64\bin' } |
        Where-Object { Test-Path -LiteralPath (Join-Path $_ 'as.exe') }
    return $candidates | Select-Object -First 1
}

function Find-GnuToolchainName {
    $lines = & rustup toolchain list
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read the rustup toolchain list.' }
    $match = [regex]::Match(($lines -join "`n"), '(?m)^(\S+-windows-gnu)\b')
    if (-not $match.Success) { return $null }
    return $match.Groups[1].Value
}

function Get-BarcodeScannerVersion {
    $lockText = [IO.File]::ReadAllText($lockPath)
    $match = [regex]::Match($lockText, '(?ms)^\[\[package\]\]\r?\nname = "tauri-plugin-barcode-scanner"\r?\nversion = "([^"]+)"')
    if (-not $match.Success) { throw 'tauri-plugin-barcode-scanner version not found in Cargo.lock.' }
    return $match.Groups[1].Value
}

function Ensure-BarcodeScannerVendor([string]$Version) {
    $vendor = Join-Path $vendorRoot "tauri-plugin-barcode-scanner-$Version"
    if (Test-Path -LiteralPath (Join-Path $vendor 'Cargo.toml')) { return $vendor }

    $registryRoot = Join-Path $env:USERPROFILE '.cargo\registry\src'
    $source = Get-ChildItem -LiteralPath $registryRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "tauri-plugin-barcode-scanner-$Version" } |
        Where-Object { Test-Path -LiteralPath (Join-Path $_ 'Cargo.toml') } |
        Select-Object -First 1
    if (-not $source) {
        throw "Cargo source for tauri-plugin-barcode-scanner $Version not found under $registryRoot"
    }

    New-Item -ItemType Directory -Path $vendorRoot -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $vendor -Recurse
    return $vendor
}

if ($env:OS -ne 'Windows_NT') {
    throw 'This script only supports Windows.'
}

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

$pnpm = Find-CommandPath 'pnpm.cmd'
if (-not $pnpm) { $pnpm = Find-CommandPath 'pnpm' }
if (-not $pnpm) { throw 'pnpm was not found.' }
if (-not (Find-CommandPath 'rustup')) { throw 'rustup was not found.' }

Write-Step 'Checking dependencies'
if (-not (Test-Path -LiteralPath (Join-Path $mobileRoot 'node_modules'))) {
    Invoke-Native $pnpm @('install', '--frozen-lockfile') $mobileRoot
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'web\node_modules'))) {
    Invoke-Native $pnpm @('install', '--frozen-lockfile') (Join-Path $repoRoot 'web')
}

Write-Step 'Preparing Android and Windows toolchains'
if (-not $env:ANDROID_HOME) {
    $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (Test-Path -LiteralPath $defaultSdk) { Set-BuildEnvironment 'ANDROID_HOME' $defaultSdk }
}
if (-not $env:ANDROID_HOME) { throw 'Set ANDROID_HOME before building.' }
if (-not $env:NDK_HOME) {
    $ndk = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'ndk') -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($ndk) { Set-BuildEnvironment 'NDK_HOME' $ndk.FullName }
}
if (-not $env:NDK_HOME) { throw 'Set NDK_HOME before building.' }
$javaHomeValid = $env:JAVA_HOME -and (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin\java.exe'))
if (-not $javaHomeValid) {
    $java = Find-CommandPath 'java.exe'
    if ($java) {
        Set-BuildEnvironment 'JAVA_HOME' (Split-Path (Split-Path $java -Parent) -Parent)
    } else {
        throw 'Set JAVA_HOME or install Java.'
    }
}

Set-BuildEnvironment 'TMP' $tempRoot
Set-BuildEnvironment 'TEMP' $tempRoot

$hasMsvc = (Find-CommandPath 'cl.exe') -and (Find-CommandPath 'link.exe')
if (-not $hasMsvc) {
    $gnuName = Find-GnuToolchainName
    $mingwBin = Find-WinLibsBin
    if (-not $gnuName -or -not $mingwBin) {
        throw @'
Windows native build tools are missing. Choose one:
1. Install Visual Studio C++ Build Tools and run this script from a Developer PowerShell.
2. Install WinLibs and GNU Rust:
   winget install --id BrechtSanders.WinLibs.POSIX.UCRT --exact
   rustup toolchain install stable-x86_64-pc-windows-gnu
'@
    }

    $gnuBin = Join-Path $env:USERPROFILE ".rustup\toolchains\$gnuName\bin"
    Set-BuildEnvironment 'RUSTUP_TOOLCHAIN' $gnuName
    Set-BuildEnvironment 'PATH' "$mingwBin;$gnuBin;$env:PATH"
    Set-BuildEnvironment 'CC' (Join-Path $mingwBin 'x86_64-w64-mingw32-gcc.exe')
    Set-BuildEnvironment 'CXX' (Join-Path $mingwBin 'x86_64-w64-mingw32-g++.exe')
    Set-BuildEnvironment 'AR' (Join-Path $mingwBin 'ar.exe')
    Set-BuildEnvironment 'RANLIB' (Join-Path $mingwBin 'ranlib.exe')
    Write-Host "Using GNU Rust toolchain: $gnuName"
    Write-Host "Using MinGW: $mingwBin"
} else {
    Write-Host 'Using the active Visual Studio C++ toolchain.'
}

$targets = & rustup target list --installed
if ($LASTEXITCODE -ne 0 -or $targets -notcontains 'aarch64-linux-android') {
    Invoke-Native 'rustup' @('target', 'add', 'aarch64-linux-android')
}

Write-Step 'Preparing a writable barcode plugin copy'
$barcodeVersion = Get-BarcodeScannerVersion
$null = Ensure-BarcodeScannerVendor $barcodeVersion
$vendorRelative = "../../.cache/mobile-vendor/tauri-plugin-barcode-scanner-$barcodeVersion"
$manifestSnapshot = [IO.File]::ReadAllBytes($manifestPath)
$lockSnapshot = [IO.File]::ReadAllBytes($lockPath)
$manifestText = [IO.File]::ReadAllText($manifestPath)
if ($manifestText -match '(?m)^\[patch\.crates-io\]') {
    throw 'Cargo.toml already contains [patch.crates-io]. Remove the previous local patch first.'
}
$newline = if ($manifestText.EndsWith("`n")) { '' } else { "`n" }
$patch = "$newline`n[patch.crates-io]`ntauri-plugin-barcode-scanner = { path = `"$vendorRelative`" }`n"
[IO.File]::AppendAllText($manifestPath, $patch, [Text.UTF8Encoding]::new($false))
Write-Host "Temporary Cargo patch: $vendorRelative"

try {
    Write-Step 'Building the frontend and Android ARM64 library'
    $buildExit = 0
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $pnpm tauri android build --debug --apk --target aarch64 2>&1 |
            ForEach-Object { Format-NativeOutput $_ } |
            Tee-Object -FilePath $buildLog
        $buildExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }

    if ($buildExit -ne 0) {
        $log = Get-Content -Raw -LiteralPath $buildLog
        if ($log -notmatch '(?i)Creation symbolic link is not allowed|symbolic link') {
            throw "Tauri Android build failed. Full log: $buildLog"
        }
        Write-Warning 'Rust compiled successfully, but Windows cannot create the Tauri symlink. Packaging from the built library instead.'
    }
    if (-not (Test-Path -LiteralPath $nativeLibrary)) {
        throw "Android library was not built: $nativeLibrary"
    }

    Write-Step 'Copying the JNI library and packaging the APK'
    $packageArguments = @{}
    if ($KeepNativeSymbols) { $packageArguments['KeepNativeSymbols'] = $true }
    & (Join-Path $PSScriptRoot 'package-android.ps1') @packageArguments

    $version = (Get-Content -Raw -LiteralPath (Join-Path $mobileRoot 'package.json') | ConvertFrom-Json).version
    $apk = Join-Path $repoRoot "bin\loopra-mobile-$version-arm64-debug.apk"
    if (-not (Test-Path -LiteralPath $apk)) {
        throw "Final APK not found: $apk"
    }

    Write-Step 'Verifying the APK'
    $buildTools = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'build-tools') -Directory |
        Sort-Object { try { [version]$_.Name } catch { [version]'0.0.0' } } -Descending |
        Select-Object -First 1
    if (-not $buildTools) { throw 'Android build-tools were not found.' }
    $apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
    if (-not (Test-Path -LiteralPath $apksigner)) { throw "apksigner was not found: $apksigner" }
    Invoke-Native $apksigner @('verify', '--verbose', $apk) $repoRoot

    $item = Get-Item -LiteralPath $apk
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($apk)
    try {
        $hash = -join ($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('X2') })
    } finally {
        $stream.Dispose()
        $sha256.Dispose()
    }
    Write-Host ""
    Write-Host 'APK created' -ForegroundColor Green
    Write-Host "Path: $($item.FullName)"
    Write-Host "Size: $([math]::Round($item.Length / 1MB, 2)) MB"
    Write-Host "SHA256: $hash"
    Write-Output $item.FullName
} finally {
    if ($manifestSnapshot) {
        [IO.File]::WriteAllBytes($manifestPath, $manifestSnapshot)
    }
    if ($lockSnapshot) {
        [IO.File]::WriteAllBytes($lockPath, $lockSnapshot)
    }
    Restore-BuildEnvironment
}
