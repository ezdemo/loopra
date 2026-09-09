#!/bin/bash
#
# Loopra Desktop Web Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/ezdemo/loopra/main/.release/setup-gui.sh | bash
#

set -euo pipefail

VERSION="v26.9.91"
# 下载地址：优先使用用户指定的镜像（LOOPRA_MIRROR），否则 GitHub 直连
if [ -n "$LOOPRA_MIRROR" ]; then
    PACKAGE_URL="${LOOPRA_MIRROR%/}/https://github.com/ezdemo/loopra/releases/download/${VERSION}/loopra-dist.tar.gz"
else
    PACKAGE_URL="https://github.com/ezdemo/loopra/releases/download/${VERSION}/loopra-dist.tar.gz"
fi
TEMP_DIR="/tmp/loopra-gui-install"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

cleanup() {
    rm -rf "$TEMP_DIR"
}

trap cleanup EXIT
mkdir -p "$TEMP_DIR"

info "Downloading Loopra Desktop runtime ${VERSION}${LOOPRA_MIRROR:+ via mirror $LOOPRA_MIRROR}..."

if command -v curl &> /dev/null; then
    curl -fsSL "$PACKAGE_URL" -o "$TEMP_DIR/package.tar.gz"
elif command -v wget &> /dev/null; then
    wget -q "$PACKAGE_URL" -O "$TEMP_DIR/package.tar.gz"
else
    error "curl or wget is required"
    exit 1
fi

info "Extracting package..."
tar -xzf "$TEMP_DIR/package.tar.gz" -C "$TEMP_DIR"

INSTALL_SCRIPT=$(find "$TEMP_DIR" -name "install.sh" -type f | head -1)
if [ -z "$INSTALL_SCRIPT" ]; then
    error "install.sh not found in package"
    exit 1
fi

if grep -rl $'\r' "$INSTALL_SCRIPT" &>/dev/null; then
    tr -d '\r' < "$INSTALL_SCRIPT" > "${INSTALL_SCRIPT}.fix"
    mv "${INSTALL_SCRIPT}.fix" "$INSTALL_SCRIPT"
    chmod +x "$INSTALL_SCRIPT"
fi

info "Installing desktop runtime..."
bash "$INSTALL_SCRIPT" --gui --setup

echo ""
info "Desktop runtime installation complete!"
echo ""
