$ErrorActionPreference = 'Stop'
$api = $env:LOOPRAX_RELEASE_API_URL
if (-not $api) { $api = 'https://api.github.com/repos/ezdemo/loopra-release/releases/latest' }
$release = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'Looprax-Updater' }
$arch = $env:LOOPRAX_UPDATE_ARCH
$targetName = [System.IO.Path]::GetFileName($env:LOOPRAX_UPDATE_TARGET)
$desktop = $targetName -eq 'Loopra' -or $targetName -eq 'LoopraX' -or $targetName -like '*desktop*'
function Get-AssetTokens([string]$name) {
    $base = [System.IO.Path]::GetFileName($name).ToLowerInvariant()
    foreach ($suffix in @('.tar.gz', '.exe', '.zip', '.tgz')) {
        if ($base.EndsWith($suffix)) { return @($base.Substring(0, $base.Length - $suffix.Length) -split '-') }
    }
    return @($base -split '-')
}
$asset = $release.assets | Where-Object {
    $tokens = @(Get-AssetTokens $_.name)
    $archOk = if ($arch -eq 'arm') { ($tokens -contains 'armv7') -or ($tokens -contains 'arm') } else { $tokens -contains $arch }
    $shortExe = $arch -eq 'amd64' -and ($_.name -eq 'loopra.exe' -or $_.name -eq 'looprax.exe')
    $platformOk = ($tokens -contains 'windows') -or $shortExe
    $extOk = $_.name.EndsWith('.exe') -or $_.name.EndsWith('.zip')
    $kindOk = ($tokens -contains 'desktop') -eq [bool]$desktop
    (($platformOk -and $archOk -and $extOk -and $kindOk) -or ($shortExe -and -not $desktop -and $extOk))
} | Select-Object -First 1
if (-not $asset) { throw "No Windows $arch binary in this release" }
$directory = Join-Path $env:LOOPRA_HOME 'updates'
$download = Join-Path $directory ([guid]::NewGuid().ToString('N') + '-' + $asset.name)
$url = $asset.browser_download_url
if ($env:LOOPRA_MIRROR) { $url = $env:LOOPRA_MIRROR + $url }
Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing
if ($asset.digest -and $asset.digest.StartsWith('sha256:')) {
    $actual = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $asset.digest.Substring(7).ToLowerInvariant()) { throw 'Release checksum mismatch' }
}
$staged = Join-Path $directory ([guid]::NewGuid().ToString('N') + '.exe')
if ($asset.name.EndsWith('.zip')) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($download)
    try {
        $entry = $archive.Entries | Where-Object { $_.Name -eq 'loopra.exe' -or $_.Name -eq 'looprax.exe' } | Select-Object -First 1
        if (-not $entry) { throw 'Archive does not contain loopra.exe' }
        $inputStream = $entry.Open()
        $outputStream = [System.IO.File]::Create($staged)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    } finally { $archive.Dispose() }
    Remove-Item -LiteralPath $download
} else {
    Move-Item -LiteralPath $download -Destination $staged
}
$stream = [System.IO.File]::OpenRead($staged)
try {
    if ($stream.Length -lt 64 -or $stream.ReadByte() -ne 77 -or $stream.ReadByte() -ne 90) { throw 'Downloaded file is not a Windows executable' }
} finally { $stream.Dispose() }
$env:LOOPRAX_UPDATE_STAGED = $staged
$helper = Join-Path $directory ([guid]::NewGuid().ToString('N') + '-apply.ps1')
@'
$ErrorActionPreference = 'Stop'
$parent = Get-Process -Id ([int]$env:LOOPRAX_UPDATE_PID) -ErrorAction SilentlyContinue
if ($parent) { $parent.WaitForExit() }
$target = [System.IO.Path]::GetFullPath($env:LOOPRAX_UPDATE_TARGET)
$staged = [System.IO.Path]::GetFullPath($env:LOOPRAX_UPDATE_STAGED)
$replacement = $target + '.new'
Copy-Item -LiteralPath $staged -Destination $replacement -Force
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination ($target + '.old') -Force }
        Move-Item -LiteralPath $replacement -Destination $target -Force
        Remove-Item -LiteralPath $staged
        exit 0
    } catch {
        if ((-not (Test-Path -LiteralPath $target)) -and (Test-Path -LiteralPath ($target + '.old'))) {
            Move-Item -LiteralPath ($target + '.old') -Destination $target -Force
        }
        Start-Sleep -Seconds 1
    }
}
throw 'Unable to replace the executable; the previous executable was preserved'
'@ | Set-Content -LiteralPath $helper -Encoding UTF8
$powershell = Join-Path $PSHOME 'powershell.exe'
Start-Process -FilePath $powershell -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$helper`"") -WindowStyle Hidden
Write-Output 'Update downloaded and verified. Exit Looprax to apply it, then start Looprax again.'
