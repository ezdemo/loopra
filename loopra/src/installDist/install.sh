#!/bin/bash
# =============================================
#  Loopra Web Installer (Linux / macOS)
#  支持重复安装，保留已有 config.json
#  复用系统 Java 17+ 或已有捆绑 JRE；都没有时自动下载 JRE 25（支持 LOOPRA_MIRROR 镜像）
#  桌面端可用 --skip-java 先更新核心文件，随后单独引导安装 Java。
#  兼容 bash, zsh, sh 等多种 shell
# =============================================

GUI_INSTALL=false
SETUP_INSTALL=false
SKIP_JAVA=false

for arg in "$@"; do
    case "$arg" in
        --gui) GUI_INSTALL=true ;;
        --setup) SETUP_INSTALL=true ;;
        --skip-java) SKIP_JAVA=true ;;
        *)
            echo "[Error] Unknown argument: $arg"
            exit 2
            ;;
    esac
done

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo "============================================"
echo -e "   Loopra Web Installer"
echo "============================================"
echo ""

# =============================================
# 源目录（脚本所在目录）
# =============================================
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

LOOPRA_CONFIG_DIR="$HOME/.loopra"
TARGET_DIR="$LOOPRA_CONFIG_DIR"
IS_GUI_INSTALL="0"
if [ "$GUI_INSTALL" = true ]; then
    TARGET_DIR="$HOME/.loopra-gui"
    IS_GUI_INSTALL="1"
fi
TARGET_BIN_DIR="$TARGET_DIR/bin"
JRE25_DIR="$TARGET_DIR/jre25"

# 源目录
SOURCE_BIN_DIR="$SOURCE_DIR/bin"
SOURCE_CONFIG="$SOURCE_DIR/config.json"
SOURCE_AGENTS="$SOURCE_DIR/loopra.md"

# =============================================
# Pre-check: 复用系统 Java 17+ 或已有捆绑 JRE；
# 都没有时自动下载 JRE 25（参考桌面端逻辑，支持 LOOPRA_MIRROR 镜像）
# =============================================
echo ""
if [ "$SKIP_JAVA" = true ]; then
    echo "[Pre-check] Core-only install: Java setup is managed by the desktop app."
else
echo -e "${YELLOW}[Pre-check]${NC} Verifying Java 17+ installation..."

JAVA_EXE=""
JAVA_SOURCE=""

# 1. 优先系统 Java（需 17+）
get_java_major() {
    local bin="$1"
    local ver
    ver=$("$bin" -version 2>&1 | head -n1 | grep -oE '"[0-9]+' | grep -oE '[0-9]+' | head -1)
    if [ -z "$ver" ]; then
        ver=$("$bin" -version 2>&1 | head -n1 | cut -d'"' -f2 | cut -d'.' -f1)
    fi
    # 只接受纯数字：macOS 上 java 命令存在但无 JDK 时（系统占位命令）输出的是报错文本，
    # 不能当作版本号参与比较，一律视为"未拿到版本号"
    case "$ver" in
        ''|*[!0-9]*) ver="" ;;
    esac
    printf '%s' "$ver"
}

# 判断主版本号是否 >= 指定值（仅接受纯数字，避免报错文本触发整数比较错误）
java_major_at_least() {
    case "$1" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$1" -ge "$2" ]
}

if command -v java &> /dev/null; then
    JAVA_VER=$(get_java_major java)
    if java_major_at_least "$JAVA_VER" 17; then
        JAVA_EXE="java"
        JAVA_SOURCE="System Java"
        echo -e "      System Java found: $(java -version 2>&1 | head -n1)"
    else
        echo -e "      ${YELLOW}System Java too old (${JAVA_VER:-unknown}), checking bundled JRE...${NC}"
    fi
else
    echo -e "      No system Java found, checking bundled JRE..."
fi

# 2. 复用已有捆绑 JRE（~/.loopra/jre25 或 ~/.loopra-gui/jre25）
if [ -z "$JAVA_EXE" ]; then
    for candidate in "$JRE25_DIR/bin/java" "$JRE25_DIR/bin/java.exe" "$JRE25_DIR/Contents/Home/bin/java"; do
        if [ -f "$candidate" ]; then
            JAVA_VER=$(get_java_major "$candidate")
            if java_major_at_least "$JAVA_VER" 17; then
                JAVA_EXE="$candidate"
                JAVA_SOURCE="Bundled JRE ($JRE25_DIR)"
                echo -e "      Bundled JRE found: $JRE25_DIR"
                break
            fi
        fi
    done
fi

# 3. 都没有 → 自动下载 JRE 25（Adoptium 最新 LTS，经 GitHub 直连或 LOOPRA_MIRROR 指定的镜像）
if [ -z "$JAVA_EXE" ]; then
    echo ""
    echo -e "${YELLOW}      No usable Java found, downloading JRE 25 automatically...${NC}"

    # 3.1 解析平台（复刻桌面端 getJre25Platform）
    OS_NAME=$(uname -s)
    case "$OS_NAME" in
        Darwin) OS_TYPE="mac" ;;
        *)      OS_TYPE="linux" ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64)    ARCH="x64" ;;
        aarch64|arm64)   ARCH="aarch64" ;;
        i386|i686)       ARCH="x32" ;;
        *)               ARCH="x64" ;;
    esac

    # 3.2 Adoptium assets API 获取最新 JRE 25 的 GitHub 直链
    ASSETS_API_URL="https://api.adoptium.net/v3/assets/latest/25/hotspot?os=${OS_TYPE}&architecture=${ARCH}&image_type=jre&heap_size=normal&vendor=eclipse"
    API_JSON=""
    if command -v curl &> /dev/null; then
        API_JSON=$(curl -fsSL --max-time 30 -A "Loopra/Installer" "$ASSETS_API_URL" 2>/dev/null || true)
    elif command -v wget &> /dev/null; then
        API_JSON=$(wget -qO- --timeout=30 "$ASSETS_API_URL" 2>/dev/null || true)
    fi
    GITHUB_URL=""
    FILE_NAME=""
    if [ -n "$API_JSON" ]; then
        # 只选 .tar.gz 便携压缩包，避开 .pkg/.msi 安装包：
        # Adoptium 响应中同一资产同时含 installer（macOS 为 .pkg）和 package（.tar.gz）两个条目，
        # 且 installer 排在前面；pkg 是 xar 打包的安装向导，tar 解不出可运行的 java。
        FILE_NAME=$(printf '%s' "$API_JSON" | grep -oE '"name"[[:space:]]*:[[:space:]]*"[^"]*\.tar\.gz"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' || true)
        GITHUB_URL=$(printf '%s' "$API_JSON" | grep -oE '"link"[[:space:]]*:[[:space:]]*"[^"]*\.tar\.gz"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' || true)
        # 兜底：万一 API 结构变化拿到非 .tar.gz，按解析失败处理，避免下载到无法解压的安装包
        case "$FILE_NAME" in
            *.tar.gz) ;;
            *) FILE_NAME="" ;;
        esac
    fi

    if [ -z "$GITHUB_URL" ] || [ -z "$FILE_NAME" ]; then
        echo ""
        echo -e "${RED}[Error] Unable to resolve JRE 25 download address (network issue or no internet access).${NC}"
        echo ""
        echo "  Please install Java 17 or later manually:"
        echo "    - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/"
        echo "    - injdk.cn: https://injdk.cn"
        echo ""
        if [ "$SETUP_INSTALL" = false ]; then
            echo "Press Enter to exit..."
            read -r
        fi
        exit 1
    fi
    echo -e "      Latest JRE 25: $FILE_NAME"

    # 3.3 拼接下载地址（支持 LOOPRA_MIRROR 用户指定镜像，与更新脚本一致）
    DOWNLOAD_URL="$GITHUB_URL"
    if [ -n "$LOOPRA_MIRROR" ]; then
        DOWNLOAD_URL="${LOOPRA_MIRROR%/}/$GITHUB_URL"
        echo -e "      Download via mirror: $LOOPRA_MIRROR"
    fi

    # 3.4 下载到临时目录（60 分钟超时）
    JRE_TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/loopra-jre25.XXXXXX")
    ARCHIVE_PATH="$JRE_TMP_DIR/$FILE_NAME"
    echo "      Downloading JRE 25 ..."
    if command -v curl &> /dev/null; then
        if ! curl -fsSL --max-time 3600 -A "Loopra/Installer" "$DOWNLOAD_URL" -o "$ARCHIVE_PATH"; then
            echo -e "${RED}      [Error] JRE download failed.${NC}"
            rm -rf "$JRE_TMP_DIR"
            echo ""
            echo "  Please install Java 17 or later manually:"
            echo "    - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/"
            echo "    - injdk.cn: https://injdk.cn"
            exit 1
        fi
    elif command -v wget &> /dev/null; then
        if ! wget -q --timeout=3600 -U "Loopra/Installer" -O "$ARCHIVE_PATH" "$DOWNLOAD_URL"; then
            echo -e "${RED}      [Error] JRE download failed.${NC}"
            rm -rf "$JRE_TMP_DIR"
            echo ""
            echo "  Please install Java 17 or later manually:"
            echo "    - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/"
            echo "    - injdk.cn: https://injdk.cn"
            exit 1
        fi
    else
        echo -e "${RED}      [Error] curl or wget is required to download JRE 25.${NC}"
        rm -rf "$JRE_TMP_DIR"
        exit 1
    fi

    # 3.5 解压并安装到 $JRE25_DIR
    echo "      Extracting JRE 25 ..."
    if ! tar -xzf "$ARCHIVE_PATH" -C "$JRE_TMP_DIR"; then
        echo -e "${RED}      [Error] JRE extraction failed.${NC}"
        rm -rf "$JRE_TMP_DIR"
        exit 1
    fi
    # 归档根目录通常是 jdk-25.0.x+y-jre（macOS 内含 Contents/Home），把其中内容整体搬到目标目录
    ROOT_DIR=$(find "$JRE_TMP_DIR" -mindepth 1 -maxdepth 1 -type d ! -path "$JRE_TMP_DIR" | head -1)
    if [ -z "$ROOT_DIR" ]; then
        echo -e "${RED}      [Error] JRE archive structure unexpected.${NC}"
        rm -rf "$JRE_TMP_DIR"
        exit 1
    fi
    rm -rf "$JRE25_DIR"
    mkdir -p "$JRE25_DIR"
    cp -R "$ROOT_DIR/"* "$JRE25_DIR/" 2>/dev/null || cp -R "$ROOT_DIR/." "$JRE25_DIR/"
    rm -rf "$JRE_TMP_DIR"
    echo -e "      ${GREEN}JRE 25 installed to $JRE25_DIR${NC}"

    # 3.6 复用刚下载的 JRE
    for candidate in "$JRE25_DIR/bin/java" "$JRE25_DIR/bin/java.exe" "$JRE25_DIR/Contents/Home/bin/java"; do
        if [ -f "$candidate" ]; then
            JAVA_VER=$(get_java_major "$candidate")
            if java_major_at_least "$JAVA_VER" 17; then
                JAVA_EXE="$candidate"
                JAVA_SOURCE="Bundled JRE (downloaded)"
                break
            fi
        fi
    done
fi

if [ -z "$JAVA_EXE" ]; then
    echo ""
    echo -e "${RED}[Error] Java 17+ is not available after JRE download attempt.${NC}"
    echo ""
    echo "  Please install Java 17 or later:"
    echo "    - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/"
    echo "    - injdk.cn: https://injdk.cn"
    echo ""
    if [ "$SETUP_INSTALL" = false ]; then
        echo "Press Enter to exit..."
        read -r
    fi
    exit 1
fi

echo -e "      ${GREEN}Java ready (${JAVA_SOURCE}): $("$JAVA_EXE" -version 2>&1 | head -n1)${NC}"
fi
echo ""

# =============================================
# 检查源目录是否存在
# =============================================
if [ ! -d "$SOURCE_BIN_DIR" ]; then
    echo "[Error] Source bin directory not found: $SOURCE_BIN_DIR"
    exit 1
fi

# =============================================
# [1/5] 检查并备份已有的 config.json 和 loopra.md
# =============================================
echo "[1/5] Checking for existing configuration..."
CONFIG_BACKUP=""
AGENTS_BACKUP=""
TARGET_CONFIG="$LOOPRA_CONFIG_DIR/config.json"
TARGET_AGENTS="$LOOPRA_CONFIG_DIR/loopra.md"

# 备份现有的配置文件
if [ -f "$TARGET_CONFIG" ]; then
    CONFIG_BACKUP=$(mktemp)
    cp "$TARGET_CONFIG" "$CONFIG_BACKUP"
    echo "      Found existing config.json (will be preserved)"
else
    echo "      No existing config.json found"
fi

if [ -f "$TARGET_AGENTS" ]; then
    AGENTS_BACKUP=$(mktemp)
    cp "$TARGET_AGENTS" "$AGENTS_BACKUP"
    echo "      Found existing loopra.md (will be preserved)"
else
    echo "      No existing loopra.md found"
fi

# =============================================
# [2/5] 创建目标目录结构
# =============================================
echo ""
echo "[2/5] Preparing target directory: $TARGET_DIR"

mkdir -p "$TARGET_DIR"
mkdir -p "$LOOPRA_CONFIG_DIR"
mkdir -p "$TARGET_BIN_DIR"

echo "      Created directory structure"

# =============================================
# [3/5] 复制文件
# =============================================
echo ""
echo "[3/5] Copying files..."

# 复制 bin 目录内容
cp -R "$SOURCE_BIN_DIR/"* "$TARGET_BIN_DIR/" 2>/dev/null || true
echo "      Copied bin/ directory"

# 复制 config.json（从根目录）
if [ -f "$SOURCE_CONFIG" ]; then
    cp "$SOURCE_CONFIG" "$TARGET_CONFIG" 2>/dev/null || true
    echo "      Copied config.json"
fi

# 复制 loopra.md（从根目录）
if [ -f "$SOURCE_AGENTS" ]; then
    cp "$SOURCE_AGENTS" "$TARGET_AGENTS" 2>/dev/null || true
    echo "      Copied loopra.md"
fi

# =============================================
# [4/5] 恢复 config.json 和 loopra.md（如果之前存在）
# =============================================
echo ""
echo "[4/5] Finalizing installation..."

if [ -n "$CONFIG_BACKUP" ]; then
    cp "$CONFIG_BACKUP" "$TARGET_CONFIG"
    rm -f "$CONFIG_BACKUP"
    echo "      Preserved existing config.json"
fi

if [ -n "$AGENTS_BACKUP" ]; then
    cp "$AGENTS_BACKUP" "$TARGET_AGENTS"
    rm -f "$AGENTS_BACKUP"
    echo "      Preserved existing loopra.md"
fi

# 检查 jar 文件是否存在
if [ ! -f "$TARGET_BIN_DIR/loopra-web.jar" ]; then
    echo "[Error] loopra-web.jar not found in $TARGET_BIN_DIR"
    exit 1
fi
echo "      Found loopra-web.jar"

# =============================================
# [5/5] 创建 loopra 命令脚本（系统 Java 或已有捆绑 JRE）
# =============================================
echo ""
echo "[5/5] Creating 'loopra' command..."

cat > "$TARGET_BIN_DIR/loopra" << 'LAUNCHER_EOF'
#!/bin/bash
# Loopra Launcher — uses system Java (or bundled JRE)

# 获取脚本真实路径（兼容软链接）
SCRIPT_PATH="$0"
while [ -L "$SCRIPT_PATH" ]; do
    SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
    case "$SCRIPT_PATH" in
        /*) ;;
        *)  SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH" ;;
    esac
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

# 优先系统 Java，其次复用已有捆绑 JRE（兼容旧安装）
LOOPRA_HOME="$(cd "$SCRIPT_DIR/.." && pwd)"
JAVA_BIN=""
if command -v java &> /dev/null; then
    JAVA_BIN="java"
    # macOS 无 JDK 时系统自带的 java 是占位命令：能调用但无法运行，验证失败则回退捆绑 JRE
    if ! "$JAVA_BIN" -version >/dev/null 2>&1; then
        JAVA_BIN=""
    fi
fi
if [ -z "$JAVA_BIN" ] && [ -f "$LOOPRA_HOME/jre25/bin/java" ]; then
    JAVA_BIN="$LOOPRA_HOME/jre25/bin/java"
fi
if [ -z "$JAVA_BIN" ] && [ -f "$LOOPRA_HOME/jre25/Contents/Home/bin/java" ]; then
    # macOS: JRE 顶层是 Contents/Home
    JAVA_BIN="$LOOPRA_HOME/jre25/Contents/Home/bin/java"
fi
if [ -z "$JAVA_BIN" ]; then
    echo "[ERROR] No Java found."
    echo "  Please install Java 17 or later:"
    echo "    - Tsinghua Adoptium mirror: https://mirrors.tuna.tsinghua.edu.cn/Adoptium/25/jdk/"
    echo "    - injdk.cn: https://injdk.cn"
    exit 1
fi

# 显示帮助（无参数 或 -h/--help/help）
if [ $# -eq 0 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ] || [ "$1" = "help" ]; then
    echo "Loopra — AI Coding Assistant"
    echo ""
    echo "Usage:"
    echo "  loopra web [port]    Start the web server"
    echo "  loopra acp [wsPort]  Start with ACP protocol support"
    echo ""
    echo "Options:"
    echo "  port    0 = random port, 8097 = default, or any port number"
    echo "  wsPort  ACP WebSocket port (omit for stdio mode)"
    echo ""
    echo "Examples:"
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
case "$JAVA_VER" in
    ''|*[!0-9]*) JAVA_VER="" ;;
esac
JAVA_OPTS="-Dfile.encoding=UTF-8"
if [ -n "$JAVA_VER" ] && [ "$JAVA_VER" -ge 21 ]; then
    JAVA_OPTS="$JAVA_OPTS --enable-native-access=ALL-UNNAMED"
fi

# 解析子命令
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

# Git Bash / MSYS terminals on Windows often need winpty
if [ -n "$MSYSTEM" ]; then
    JAVA_OPTS="$JAVA_OPTS -Djline.terminal.type=xterm-256color"
    if [ -t 0 ] && [ -t 1 ] && command -v winpty >/dev/null 2>&1; then
        exec winpty "$JAVA_BIN" $JAVA_OPTS -jar "$SCRIPT_DIR/loopra-web.jar" "${PASSTHROUGH_ARGS[@]}"
    fi
fi

"$JAVA_BIN" $JAVA_OPTS -jar "$SCRIPT_DIR/loopra-web.jar" "${PASSTHROUGH_ARGS[@]}"
LAUNCHER_EOF

chmod +x "$TARGET_BIN_DIR/loopra"
echo "      Created: $TARGET_BIN_DIR/loopra"

# =============================================
# 配置 PATH 环境变量（桌面运行时不注册命令行 PATH）
# =============================================
if [ "$IS_GUI_INSTALL" = "1" ]; then
    echo ""
    echo "Skipping PATH configuration for desktop runtime"
else
    echo ""
    echo "Configuring PATH..."

# 要添加的 PATH 配置
PATH_LINE='export PATH="$PATH:$HOME/.loopra/bin"'
PATH_MARKER='# Loopra Web'

# 检测当前用户默认 shell
USER_SHELL=$(basename "$SHELL" 2>/dev/null || echo "unknown")

# 定义需要配置的 shell 配置文件（按优先级排序）
declare -a CONFIG_FILES=()

case "$USER_SHELL" in
    zsh)
        CONFIG_FILES+=("$HOME/.zshrc")
        ;;
    bash)
        if [[ "$(uname -s)" == "Darwin" ]]; then
            CONFIG_FILES+=("$HOME/.bash_profile")
            CONFIG_FILES+=("$HOME/.bashrc")
        else
            CONFIG_FILES+=("$HOME/.bashrc")
            CONFIG_FILES+=("$HOME/.bash_profile")
        fi
        ;;
    fish)
        CONFIG_FILES+=("$HOME/.config/fish/config.fish")
        PATH_LINE='set -gx PATH $PATH $HOME/.loopra/bin'
        ;;
    *)
        CONFIG_FILES+=("$HOME/.profile")
        CONFIG_FILES+=("$HOME/.bashrc")
        CONFIG_FILES+=("$HOME/.zshrc")
        ;;
esac

# 写入配置文件
CONFIG_UPDATED=false
for CONFIG_FILE in "${CONFIG_FILES[@]}"; do
    if [[ "$USER_SHELL" == "fish" && "$CONFIG_FILE" == *".fish" ]]; then
        PATH_LINE='set -gx PATH $PATH $HOME/.loopra/bin'
    else
        PATH_LINE='export PATH="$PATH:$HOME/.loopra/bin"'
    fi

    if [ -f "$CONFIG_FILE" ]; then
        if grep -qF '.loopra/bin' "$CONFIG_FILE" 2>/dev/null; then
            echo "      PATH already configured in $(basename "$CONFIG_FILE")"
            CONFIG_UPDATED=true
            continue
        fi
    fi

    CONFIG_DIR=$(dirname "$CONFIG_FILE")
    if [ ! -d "$CONFIG_DIR" ]; then
        mkdir -p "$CONFIG_DIR" 2>/dev/null || continue
    fi

    echo "" >> "$CONFIG_FILE" 2>/dev/null || continue
    echo "$PATH_MARKER" >> "$CONFIG_FILE" 2>/dev/null || continue
    echo "$PATH_LINE" >> "$CONFIG_FILE" 2>/dev/null || continue
    echo "      Added to PATH in $(basename "$CONFIG_FILE")"
    CONFIG_UPDATED=true
done
fi

# =============================================
# 尝试创建软链接到 /usr/local/bin（仅命令行安装）
# =============================================
SYMLINK_CREATED=false
if [ "$IS_GUI_INSTALL" != "1" ] && [ ! -e "/usr/local/bin/loopra" ]; then
    if [ -w "/usr/local/bin" ] 2>/dev/null; then
        ln -sf "$TARGET_BIN_DIR/loopra" /usr/local/bin/loopra 2>/dev/null && SYMLINK_CREATED=true
    elif command -v sudo >/dev/null 2>&1; then
        if sudo -n true 2>/dev/null; then
            sudo ln -sf "$TARGET_BIN_DIR/loopra" /usr/local/bin/loopra 2>/dev/null && SYMLINK_CREATED=true
        fi
    fi
fi

if [ "$SYMLINK_CREATED" = true ]; then
    echo "      Created symlink: /usr/local/bin/loopra"
fi

# =============================================
# 完成
# =============================================
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}   Installation Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo "  Install path: $TARGET_DIR"
echo "  Config path:  $LOOPRA_CONFIG_DIR"
if [ "$SKIP_JAVA" = true ]; then
    echo "  Java:         Setup deferred to desktop app; JRE/JDK required to start"
else
    echo "  Java:         System Java 17+ / existing bundled JRE / auto-downloaded JRE 25 ($JRE25_DIR)"
fi
echo ""

if [ "$IS_GUI_INSTALL" = "1" ]; then
    echo -e "  ${CYAN}Desktop runtime is managed by the Loopra Desktop app.${NC}"
elif [ "$SYMLINK_CREATED" = true ]; then
    echo -e "  ${CYAN}Symlink created: /usr/local/bin/loopra${NC}"
    echo -e "  You can run ${CYAN}loopra web${NC} directly now!"
else
    echo -e "  ${CYAN}Usage:${NC}"
    echo "    1. Run: source ~/.${USER_SHELL}rc"
    echo "    2. Or restart your terminal"
    echo "    3. Then run: 'loopra web'         (default port 8097)"
    echo "                'loopra web 0'       (random port)"
    echo "                'loopra web 9636'    (specify port 9636)"
fi

echo ""
echo -e "  ${CYAN}Directory structure:${NC}"
echo "    $TARGET_DIR/"
echo "    ├── jre25/           (auto-downloaded or existing bundled JRE 25)"
echo "    └── bin/             (executables)"
echo "        ├── loopra-web.jar"
echo "        ├── loopra           (launcher)"
echo "        └── uninstall.sh    (uninstall script)"
echo "    $LOOPRA_CONFIG_DIR/"
echo "    ├── config.json      (configuration, preserved if exists)"
echo "    └── loopra.md        (project docs, preserved if exists)"
echo ""
echo -e "  ${CYAN}API Endpoint:${NC}"
echo "    http://localhost:8097"
echo ""
if [ "$IS_GUI_INSTALL" != "1" ]; then
    echo -e "  ${YELLOW}[Tip]${NC} To use loopra immediately in current terminal:"
    echo "    source ~/.${USER_SHELL}rc"
fi
echo ""

if [ "$SETUP_INSTALL" = false ]; then
    echo "Press Enter to exit..."
    read -r
fi
