param(
    [Parameter(Mandatory=$true, HelpMessage="New version number, e.g. 26.10.1")]
    [ValidatePattern('^\d+\.\d+\.\d+(\.\d+)?$')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$electronVersion = ($Version.Split('.') | Select-Object -First 3) -join '.'
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# Release tooling and installers live in ezdemo/loopra-release. That repository
# reads the version from this source checkout; no second release version exists.
function Update-SourceFile {
    param([string]$RelativePath, [scriptblock]$Transform)
    $path = Join-Path $root $RelativePath
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "  [--] $RelativePath (not found)"
        return
    }
    $before = [System.IO.File]::ReadAllText($path)
    $after = & $Transform $before
    if ($after -ne $before) {
        [System.IO.File]::WriteAllText($path, $after.TrimStart([char]0xFEFF), $utf8NoBom)
        Write-Host "  [OK] $RelativePath"
    } else { Write-Host "  [--] $RelativePath (unchanged)" }
}

Write-Host "Updating source version to $Version (Electron: $electronVersion)"
foreach ($pom in @('pom.xml', 'loopra/pom.xml')) {
    Update-SourceFile $pom {
        param($text)
        $text = [regex]::Replace($text, '(?<=<artifactId>loopra</artifactId>\s*\r?\n\s*<version>)[^<]+', $Version)
        [regex]::Replace($text, '(?<=<loopra\.version>)[^<]+', $Version)
    }
}
Update-SourceFile 'loopra/dependency-reduced-pom.xml' {
    param($text)
    [regex]::Replace($text, '(?<=<artifactId>loopra</artifactId>\s*\r?\n\s*<groupId>site\.sorghum\.agent</groupId>\s*\r?\n\s*<version>)[^<]+', $Version)
}
Update-SourceFile 'loopra-front/package.json' {
    param($text)
    [regex]::Replace($text, '(?<="version"\s*:\s*")[^"]+', $electronVersion)
}
Update-SourceFile 'loopra/src/installDist/bin/version.txt' {
    param($text)
    $Version + "`n"
}
Write-Host 'Review git diff, then commit the source version before releasing from loopra-release.'
