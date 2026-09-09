#
# Loopra Desktop Web Installer for Windows
# Usage: irm https://raw.githubusercontent.com/ezdemo/loopra/main/.release/setup-gui.ps1 | iex
#

$ErrorActionPreference = "Stop"

$VERSION = "v26.9.91"
# 下载地址：优先使用用户指定的镜像（LOOPRA_MIRROR），否则 GitHub 直连
$MIRROR = $env:LOOPRA_MIRROR
if ($MIRROR) {
    $PACKAGE_URL = $MIRROR.TrimEnd('/') + "/https://github.com/ezdemo/loopra/releases/download/$VERSION/loopra-dist.tar.gz"
} else {
    $PACKAGE_URL = "https://github.com/ezdemo/loopra/releases/download/$VERSION/loopra-dist.tar.gz"
}
$TEMP_DIR = Join-Path $env:TEMP "loopra-gui-install"

function Write-Info {
    param([string]$Message)
    Write-Host "[INFO] " -ForegroundColor Green -NoNewline
    Write-Host $Message
}

function Write-Error {
    param([string]$Message)
    Write-Host "[ERROR] " -ForegroundColor Red -NoNewline
    Write-Host $Message
}

if (Test-Path $TEMP_DIR) {
    Remove-Item -Recurse -Force $TEMP_DIR
}
New-Item -ItemType Directory -Path $TEMP_DIR | Out-Null

try {
    Write-Info "Downloading Loopra Desktop runtime $VERSION$(if ($MIRROR) { " via mirror $MIRROR" } else { '' })..."

    $packageFile = Join-Path $TEMP_DIR "package.tar.gz"
    Invoke-WebRequest -Uri $PACKAGE_URL -OutFile $packageFile -UseBasicParsing

    Write-Info "Extracting package..."
    tar -xzf $packageFile -C $TEMP_DIR

    $installScript = Get-ChildItem -Path $TEMP_DIR -Filter "install.ps1" -Recurse | Select-Object -First 1
    if (-not $installScript) {
        Write-Error "install.ps1 not found in package"
        exit 1
    }

    Write-Info "Installing desktop runtime..."
    & $installScript.FullName -Gui -Setup

    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
        Write-Error "Installer failed with exit code: $LASTEXITCODE"
        throw "Installation failed"
    }

    Write-Host ""
    Write-Info "Desktop runtime installation complete!"
    Write-Host ""
} catch {
    Write-Error $_.Exception.Message
    throw
}
