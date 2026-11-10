param([switch]$KeepNativeSymbols)
$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path $PSScriptRoot -Parent
$repoRoot = Split-Path $mobileRoot -Parent
$androidRoot = Join-Path $mobileRoot 'src-tauri/gen/android'
$nativeLibrary = Join-Path $mobileRoot 'src-tauri/target/aarch64-linux-android/debug/libloopra_mobile_lib.so'
if (-not (Test-Path -LiteralPath $nativeLibrary)) { throw '先编译 Android ARM64 调试动态库，再执行此打包步骤。' }
if (-not (Test-Path -LiteralPath (Join-Path $androidRoot 'tauri.settings.gradle'))) { throw '缺少 Tauri 生成的 Android 依赖配置，请先运行 pnpm tauri android build --debug --apk --target aarch64。' }
$header = New-Object byte[] 20
$nativeStream = [IO.File]::OpenRead($nativeLibrary)
try { if ($nativeStream.Read($header, 0, 20) -ne 20) { throw '动态库不完整。' } } finally { $nativeStream.Dispose() }
if ($header[0] -ne 127 -or $header[1] -ne 69 -or $header[2] -ne 76 -or $header[3] -ne 70 -or $header[18] -ne 183 -or $header[19] -ne 0) { throw '动态库不是 Android ARM64 ELF。' }
$jniDirectory = Join-Path $androidRoot 'app/src/main/jniLibs/arm64-v8a'
New-Item -ItemType Directory -Path $jniDirectory -Force | Out-Null
$packagedLibrary = Join-Path $jniDirectory 'libloopra_mobile_lib.so'
Copy-Item -LiteralPath $nativeLibrary -Destination $packagedLibrary -Force
if (-not $KeepNativeSymbols) {
    $ndkRoot = $env:NDK_HOME
    if (-not $ndkRoot -and $env:ANDROID_HOME) { $ndkRoot = (Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'ndk') -Directory | Sort-Object Name -Descending | Select-Object -First 1).FullName }
    if (-not $ndkRoot) { throw '请设置 NDK_HOME 或使用 -KeepNativeSymbols。' }
    $stripTool = Join-Path $ndkRoot 'toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-strip.exe'
    & $stripTool --strip-debug $packagedLibrary
    if ($LASTEXITCODE -ne 0) { throw '去除打包副本中的调试符号失败。' }
}
# Rust was already compiled above. Copying avoids privileged Windows symlinks;
# only the duplicate native build task is excluded from this packaging phase.
$apk = Join-Path $androidRoot 'app/build/outputs/apk/arm64/debug/app-arm64-debug.apk'
# Incremental APK updates can retain a large hole after replacing the native library.
# Recreate only this generated archive so downloads contain no obsolete payload.
if (Test-Path -LiteralPath $apk) { Remove-Item -LiteralPath $apk -Force }
& (Join-Path $androidRoot 'gradlew.bat') -p $androidRoot :app:assembleArm64Debug -x :app:rustBuildArm64Debug '-PtargetList=aarch64' '-ParchList=arm64' '-PabiList=arm64-v8a' --no-daemon --console plain
if ($LASTEXITCODE -ne 0) { throw 'Gradle APK 打包失败。' }
if (-not (Test-Path -LiteralPath $apk)) { throw '未找到打包后的 APK。' }
$version = (Get-Content -Raw -LiteralPath (Join-Path $mobileRoot 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw '安装包版本号无效。' }
$outputDirectory = Join-Path $repoRoot 'bin'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$output = Join-Path $outputDirectory "loopra-mobile-$version-arm64-debug.apk"
Copy-Item -LiteralPath $apk -Destination $output -Force
Write-Output $output
