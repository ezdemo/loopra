$ErrorActionPreference = 'Stop'
$mobileRoot = Split-Path $PSScriptRoot -Parent
$repoRoot = Split-Path $mobileRoot -Parent
$output = Join-Path $repoRoot '.cache/mobile-launcher-icons'

# Keep Android launcher artwork separate from desktop, web and iOS branding.
Push-Location -LiteralPath $mobileRoot
try {
    & pnpm tauri icon 'icons/launcher.json' --output $output
    if ($LASTEXITCODE -ne 0) { throw 'Launcher icon generation failed.' }
} finally {
    Pop-Location
}

$androidIcons = Join-Path $output 'android'
$destinations = @(
    (Join-Path $mobileRoot 'src-tauri/icons/android'),
    (Join-Path $mobileRoot 'src-tauri/gen/android/app/src/main/res')
)
foreach ($destination in $destinations) {
    foreach ($directory in Get-ChildItem -LiteralPath $androidIcons -Directory) {
        $target = Join-Path $destination $directory.Name
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        foreach ($file in Get-ChildItem -LiteralPath $directory.FullName -File) {
            Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $target $file.Name) -Force
        }
    }
    # Some launchers prefer roundIcon. Both names must use the same adaptive layers.
    $adaptive = Join-Path $destination 'mipmap-anydpi-v26'
    Copy-Item -LiteralPath (Join-Path $adaptive 'ic_launcher.xml') -Destination (Join-Path $adaptive 'ic_launcher_round.xml') -Force
}
Write-Output 'Updated Android launcher icons in the source bundle and native project.'
