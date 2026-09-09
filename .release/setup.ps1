#
# Loopra Web Installer for Windows
# Usage: irm https://github.com/ezdemo/loopra/releases/download/v26.8.3.1/setup.ps1 | iex
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
$TEMP_DIR = Join-Path $env:TEMP "loopra-install"

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

# Cleanup temp directory
if (Test-Path $TEMP_DIR) {
    Remove-Item -Recurse -Force $TEMP_DIR
}
New-Item -ItemType Directory -Path $TEMP_DIR | Out-Null

try {
    Write-Info "Downloading Loopra Web $VERSION$(if ($MIRROR) { " via mirror $MIRROR" } else { '' })..."

    $packageFile = Join-Path $TEMP_DIR "package.tar.gz"
    Invoke-WebRequest -Uri $PACKAGE_URL -OutFile $packageFile -UseBasicParsing

    Write-Info "Extracting package..."

    # Extract tar.gz using built-in tar (Windows 10+)
    tar -xzf $packageFile -C $TEMP_DIR

    # Find install.ps1
    $installScript = Get-ChildItem -Path $TEMP_DIR -Filter "install.ps1" -Recurse | Select-Object -First 1

    if (-not $installScript) {
        Write-Error "install.ps1 not found in package"
        exit 1
    }

    Write-Info "Running installer..."

    # Run PowerShell installer
    $installPath = $installScript.FullName
    $installDir = Split-Path $installPath -Parent
    
    Write-Host "Install path: $installPath" -ForegroundColor Gray
    
    # Execute the installer script
    & $installPath -Setup
    
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $null) {
        Write-Error "Installer failed with exit code: $LASTEXITCODE"
        throw "Installation failed"
    }

    # Refresh PATH for current session
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $env:Path = $env:Path.TrimEnd(';')

    Write-Host ""
    Write-Info "Installation complete!"
    Write-Host ""
    Write-Host "You can now run: " -NoNewline
    Write-Host "loopra web" -ForegroundColor Cyan -NoNewline
    Write-Host " or " -NoNewline
    Write-Host "loopra web 0" -ForegroundColor Cyan
    Write-Host ""

} catch {
    Write-Error $_.Exception.Message
    throw $_
}
