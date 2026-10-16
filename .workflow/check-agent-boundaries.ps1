$ErrorActionPreference = 'Stop'

$classesPath = Join-Path $PSScriptRoot '../loopra/target/classes'
if (-not (Test-Path -LiteralPath $classesPath)) {
    throw 'Compile the backend with mvn test before checking dependency boundaries.'
}

# jdeps reads compiled class references, including dependencies hidden behind fully qualified names.
$dependencies = & jdeps --ignore-missing-deps -verbose:class -filter:none $classesPath
if ($LASTEXITCODE -ne 0) {
    throw "jdeps failed with exit code $LASTEXITCODE"
}
$violations = $dependencies | Where-Object {
    $_ -match '^\s+site\.sorghum\.loopra\.bin\..*\s+->\s+site\.sorghum\.loopra\.web\.'
}
if ($violations) {
    $violations | Write-Output
    throw 'Runtime code must depend on contracts, not Web implementations.'
}
Write-Output 'Agent dependency boundaries passed.'
