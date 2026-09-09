#!/bin/bash
#
# Loopra Web Installer (Mirror via GitHub + gh-proxy)
# Usage: curl -fsSL https://gh-proxy.org/https://github.com/ezdemo/loopra/releases/download/v26.8.3.1/setup-mirror.sh | bash
#

set -e

VERSION="v26.9.91"
# 下载地址：优先使用用户指定的镜像（LOOPRA_MIRROR），未指定时默认 gh-proxy.org
if [ -n "$LOOPRA_MIRROR" ]; then
    MIRROR="$LOOPRA_MIRROR"
else
    MIRROR="https://gh-proxy.org/"
fi
PACKAGE_URL="${MIRROR%/}/https://github.com/ezdemo/loopra/releases/download/${VERSION}/loopra-dist.tar.gz"
TEMP_DIR="/tmp/loopra-install"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

cleanup() {
    rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

# Create temp directory
mkdir -p "$TEMP_DIR"

info "Downloading Loopra Web ${VERSION} via GitHub mirror (${MIRROR})..."

# Download package
if command -v curl &> /dev/null; then
    curl -fsSL "$PACKAGE_URL" -o "$TEMP_DIR/package.tar.gz"
elif command -v wget &> /dev/null; then
    wget -q "$PACKAGE_URL" -O "$TEMP_DIR/package.tar.gz"
else
    error "curl or wget is required"
    exit 1
fi

info "Extracting package..."

# Extract
tar -xzf "$TEMP_DIR/package.tar.gz" -C "$TEMP_DIR"

# Find install.sh
INSTALL_SCRIPT=$(find "$TEMP_DIR" -name "install.sh" -type f | head -1)

if [ -z "$INSTALL_SCRIPT" ]; then
    error "install.sh not found in package"
    exit 1
fi

# Fix: Some packages have Windows (CRLF) line endings in shell scripts,
# which causes "command not found" errors on Linux/macOS.
# Strip carriage return characters before running.
if grep -rl $'\r' "$INSTALL_SCRIPT" &>/dev/null; then
    warn "Detected CRLF line endings in installer, converting to Unix format..."
    tr -d '\r' < "$INSTALL_SCRIPT" > "${INSTALL_SCRIPT}.fix"
    mv "${INSTALL_SCRIPT}.fix" "$INSTALL_SCRIPT"
    chmod +x "$INSTALL_SCRIPT"
fi

info "Running installer..."

# Run installer
bash "$INSTALL_SCRIPT" --setup

echo ""
info "Installation complete!"
echo ""

echo -e "You can now run: ${CYAN}loopra web${NC} or ${CYAN}loopra web 0${NC}"

echo ""

# Note: For immediate use in current shell session, user needs to manually source
# This is a limitation of piping to bash - subshell cannot modify parent shell's PATH
