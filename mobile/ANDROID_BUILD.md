# Loopra Mobile Android 打包

本文记录在 Windows 上生成 ARM64 调试 APK 的实际步骤，包括当前机器的备用工具链和常见报错。命令默认从 `mobile/` 执行；最终 APK 写入仓库的 `bin/`。

> 当前产物是 Debug 包，使用 Android Debug 证书签名，不用于正式发布。

## 一键打包（推荐）

从 `mobile/` 执行：

```powershell
.\scripts\build-android.ps1
```

也可以使用 package script：

```powershell
pnpm android:debug
```

脚本会自动完成：

1. 检查 pnpm、Java、Android SDK/NDK 和 Rust Android target。
2. 优先使用已激活的 MSVC；否则自动查找 WinLibs 和 GNU Rust 工具链。
3. 设置隔离的 `TMP` / `TEMP` 目录。
4. 为条码插件准备可写 vendor 副本，并临时添加 Cargo patch。
5. 构建前端和 ARM64 动态库。
6. 在 Windows 无符号链接权限时自动改用复制方式打包。
7. 校验签名并输出 APK 路径、大小和 SHA-256。
8. 无论成功或失败，都恢复 `Cargo.toml`、`Cargo.lock` 和当前进程环境变量。

需要保留原生调试符号时：

```powershell
.\scripts\build-android.ps1 -KeepNativeSymbols
```

最终文件：

```text
bin/loopra-mobile-<version>-arm64-debug.apk
```

下面的手动流程用于排查脚本内部步骤或迁移到新机器。

## 手动流程

如果机器已安装 Visual Studio C++ Build Tools，并启用了 Windows 开发者模式：

```powershell
cd mobile
pnpm install --frozen-lockfile
rustup target add aarch64-linux-android
pnpm tauri android build --debug --apk --target aarch64
```

成功后 Tauri 会生成 APK。如果 Rust 动态库已经编译完成，只在最后创建 Windows 符号链接时失败，执行：

```powershell
.\scripts\package-android.ps1
```

注意：`package-android.ps1` 只复制已编译的 Rust 动态库并重新执行 Gradle 打包，不会重新编译前端或 Rust。因此修改前端后必须先运行 `pnpm tauri android build`，不能直接跳到该脚本。

## 本机现状

当前机器没有 Visual Studio C++ Build Tools，但有 WinLibs MinGW 和 Rust GNU 工具链。可用以下方式完成构建。

### 1. 安装备用 Windows 编译工具

```powershell
winget install --id BrechtSanders.WinLibs.POSIX.UCRT --exact
```

本次安装位置：

```text
C:\Users\15614\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin
```

### 2. 在 PowerShell 中设置本次构建环境

从 `mobile/` 执行：

```powershell
$mingw = 'C:\Users\15614\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin'
$gnu = 'C:\Users\15614\.rustup\toolchains\stable-x86_64-pc-windows-gnu'
$tmp = (Resolve-Path '..\.cache\mobile-native-tmp\clang-temp').Path

$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnu'
$env:PATH = "$mingw;$gnu\bin;$env:PATH"
$env:CC = "$mingw\x86_64-w64-mingw32-gcc.exe"
$env:CXX = "$mingw\x86_64-w64-mingw32-g++.exe"
$env:AR = "$mingw\ar.exe"
$env:RANLIB = "$mingw\ranlib.exe"
$env:TMP = $tmp
$env:TEMP = $tmp
```

`TMP` / `TEMP` 指向仓库旁的临时目录，避免 Android NDK 的 `clang` 因系统临时目录权限而报错。

如果该目录不存在：

```powershell
New-Item -ItemType Directory -Force -Path '..\.cache\mobile-native-tmp\clang-temp' | Out-Null
```

### 3. 编译前端与 ARM64 动态库

```powershell
pnpm tauri android build --debug --apk --target aarch64
```

该命令会先执行 `pnpm build`，再编译 `aarch64-linux-android` 动态库。

如果最后只出现如下错误：

```text
Creation symbolic link is not allowed for this system.
```

说明编译已经成功，只是 Windows 不允许 Tauri 在 `jniLibs` 中创建符号链接。继续执行：

```powershell
.\scripts\package-android.ps1
```

需要保留原生调试符号时：

```powershell
.\scripts\package-android.ps1 -KeepNativeSymbols
```

### 4. 条形码插件的本机写入限制

在受限终端或 Codex 沙箱中，`tauri-plugin-barcode-scanner` 的构建脚本可能无法写入 Cargo 缓存：

```text
failed to copy tauri-api to the plugin project
failed to create directory ...\tauri-plugin-barcode-scanner-2.5.3\android\.tauri\tauri-api
```

本项目已经在本机 `.cache/mobile-vendor/` 保存了可写副本。若副本不存在，可手动复制：

```powershell
$src = "$env:USERPROFILE\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\tauri-plugin-barcode-scanner-2.5.3"
$dst = '..\.cache\mobile-vendor\tauri-plugin-barcode-scanner-2.5.3'
Copy-Item -LiteralPath $src -Destination $dst -Recurse
```

然后临时在 `mobile/src-tauri/Cargo.toml` 末尾加入：

```toml
[patch.crates-io]
tauri-plugin-barcode-scanner = { path = "../../.cache/mobile-vendor/tauri-plugin-barcode-scanner-2.5.3" }
```

再次执行构建。打包完成后应手动移除该 `[patch.crates-io]`，并确保 `mobile/src-tauri/Cargo.lock` 不保留指向 `.cache` 的本地路径。`.cache/mobile-vendor/` 和该 patch 都不应提交。

## 产物位置

构建链依次产生：

```text
mobile/dist/                                                      前端构建
mobile/src-tauri/target/aarch64-linux-android/debug/libloopra_mobile_lib.so
mobile/src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk
bin/loopra-mobile-<version>-arm64-debug.apk
```

只有最后的 `bin/` 文件用于安装或分发。版本号取自 `mobile/package.json`。

## 验证 APK

```powershell
$apk = '..\bin\loopra-mobile-0.1.1-arm64-debug.apk'
$apksigner = Join-Path $env:ANDROID_HOME 'build-tools\37.0.0\apksigner.bat'

& $apksigner verify --verbose --print-certs $apk
Get-FileHash -Algorithm SHA256 -LiteralPath $apk
```

检查包名、版本、最低系统版本和 ABI：

```powershell
$aapt = Join-Path $env:ANDROID_HOME 'build-tools\37.0.0\aapt.exe'
& $aapt dump badging (Resolve-Path $apk)
```

正常应看到：

```text
package: name='app.loopra.mobile' versionCode='1001' versionName='0.1.1'
sdkVersion:'24'
targetSdkVersion:'37'
native-code: 'arm64-v8a'
```

## 安装

```powershell
adb devices
adb install -r '..\bin\loopra-mobile-0.1.1-arm64-debug.apk'
```

也可以把 APK 传到手机后直接打开安装。没有连接设备时，`adb devices` 可能只显示 `List of devices attached`。

## 后台连接验收

连接桌面时，Android 原生插件启动同进程的 `RelayConnectionService`（`remoteMessaging` 前台服务），显示「正在保持桌面连接」。Android 13+ 首次请求通知权限，拒绝不阻止服务运行。取消连接、移除配对、退出或从最近任务移除后应停止服务；旧连接的迟到关闭事件不能停止新连接。

已完成 Rust 编译后，可从 `src-tauri/gen/android/` 验证服务所有权逻辑，无需设备：

```powershell
.\gradlew.bat :app:testArm64DebugUnitTest -x :app:rustBuildArm64Debug -PtargetList=aarch64 -ParchList=arm64 -PabiList=arm64-v8a --no-daemon --console plain
```

真机验收应在桌面持续回复时按 Home 切换到其他应用，再返回 Loopra，确认健康连接与回复流没有被主动重建；断网后恢复应重新握手且不重复发送消息。分别验证通知允许与拒绝、退出后服务清理，以及从旧实例切换到新实例后旧回调的隔离。可用 `adb shell dumpsys activity services app.loopra.mobile` 检查前台服务是否仅在连接期间存活。

前台服务不等同于省电白名单；深度 Doze、厂商省电限制、系统强制停止和进程回收仍需要真机覆盖。当前没有申请常驻唤醒锁，不承诺锁屏后无限期在线。

## 常见问题

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `linker link.exe not found` | 缺少 MSVC Build Tools | 安装 Visual Studio C++ Build Tools，或使用上面的 WinLibs + GNU Rust 环境 |
| `dlltool ... CreateProcess` | GNU 工具链找不到 MinGW 的 `as.exe` 等工具 | 安装 WinLibs，并把其 `mingw64\bin` 放到 `PATH` 最前面 |
| `clang: error: unable to make temporary file: Permission denied` | 系统临时目录不可写 | 将 `TMP` / `TEMP` 指向 `..\.cache\mobile-native-tmp\clang-temp` |
| `failed to copy tauri-api ... 拒绝访问` | 条形码插件无法写 Cargo 缓存 | 使用 `.cache/mobile-vendor/` 副本和临时 Cargo patch |
| `Creation symbolic link is not allowed` | Windows 符号链接权限不足 | 执行 `.\scripts\package-android.ps1` |
| 只有 Gradle `obsolete` / `deprecated` 警告 | AGP / Kotlin 版本提示 | 不影响本次 Debug APK，无需仅为打包升级依赖 |

## 发布包

本文只覆盖可直接安装和验收的 Debug APK。正式发布需要配置 Android 签名、更新版本号，并执行正式构建流程；不要分发使用 Android Debug 证书签名的安装包。
