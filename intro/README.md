# Loopra 介绍页

无需构建的静态网站。中文源文案在 `index.html`，英文在 `i18n.js`；功能与架构描述应与根 README、`docs/` 和前端说明保持一致。

## 本地预览

在仓库根目录运行：

```sh
python -m http.server 8769 --bind 127.0.0.1 --directory intro
```

打开 `http://127.0.0.1:8769/`。发布时完整部署本目录的 HTML、JS、CSS 和 assets，无需 Node.js 服务。

页面中的本地 CSS、JS 引用带有 `?v=20261026-2` 等版本参数。以后修改这些资源并发布时，需要同步更新 `index.html` 中对应引用的版本参数，避免浏览器或 CDN 继续使用旧文件。先上传资源，再上传 `index.html`。

使用 Nginx / CDN 时，建议 HTML 设置 `Cache-Control: no-cache`，让浏览器每次验证页面是否更新；CDN 不应强制缓存 HTML，并应将查询参数纳入静态资源缓存键。若部署后只有新增区域缺少样式，可检查 `style.css` 的响应内容及 `CF-Cache-Status`、`Age`、`Last-Modified` 响应头，并清除 CDN 中对应旧资源的缓存；仅在浏览器强制刷新不一定能刷新 CDN 缓存。

## 最新版本与下载

`release.js` 请求公开接口 `https://api.github.com/repos/ezdemo/loopra-release/releases/latest`，展示 `tag_name`、`published_at` 与实际存在的桌面安装包。下载地址直接使用资产的 `browser_download_url`，过滤更新清单、blockmap 和 CLI 分发包。不要把 GitHub token 放入前端。

Windows、macOS 与 Linux 按资产名称、格式和架构分组；新增受支持格式的安装包后无需修改固定版本号。系统识别只作平台提示，不猜测用户芯片架构。

公开元数据在浏览器缓存 5 分钟，以减少匿名 API 限流。请求 8 秒超时；失败时明确标记缓存版本，或回退到 GitHub Releases，并提供重试按钮。本地存储不可用时仍能获取并下载。发布日期按 Asia/Shanghai 显示。

## 下载源与默认测速

`mirrors.js` 提供 GitHub 直连，以及 gh-proxy.org、gh-proxy.com、ghfast.top、ghproxy.net、fastgit.cc、gh.monlor.com 六个镜像。页面加载时默认并发测速，自动模式选择有效响应中延迟最低的源。手动选择会保存到本机，自动测速和语言切换均不会覆盖手动选择；可重新测速，或切回自动选择。

测速请求实际 Release 的小文件 `latest.yml`，使用 2 KiB Range、7 秒超时并检查文件内容；不下载完整安装包。展示的是响应延迟，不是带宽速度。错误页、超时或 CORS 限制不会被计为有效结果。不可测的源保留手动下载选项；全部测速失败则回退 GitHub 直连。镜像仅改写安装包链接，发布说明和 GitHub API 请求仍使用官方地址。

快速开始与下载区共用下载源选择，命令展示和复制内容同步更新。所有安装脚本（含 `-mirror`、`-gui` 变体）都支持 `LOOPRA_MIRROR`：具体镜像以环境变量传入，脚本本身固定从官方 raw 地址获取。例如：

```powershell
$env:LOOPRA_MIRROR='https://gh-proxy.org/'; irm https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.ps1 | iex
```

```bash
export LOOPRA_MIRROR='https://gh-proxy.org/'; curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra-release/main/.release/setup.sh | bash
```

未设置变量时，标准脚本走 GitHub 直连，`-mirror` 变体默认使用 gh-proxy.org。服务端核心更新使用同一约定：按操作系统获取官方 `setup.ps1` / `setup.sh`，把所选源传入更新子进程的 `LOOPRA_MIRROR`；选择直连时移除继承的镜像变量。

## 验证

```sh
node --check intro/main.js
node --check intro/i18n.js
node --check intro/release.js
node --check intro/mirrors.js
node --test intro/release.test.cjs intro/mirrors.test.cjs
git diff --check
```

浏览器检查应覆盖真实 GitHub 数据、中英切换、深浅主题、窄屏，以及请求失败时的 Releases 回退与缓存提示。
