param(
    [string]$ApkPath,
    [string]$BaselineApk,
    [string]$SdkPath = (Join-Path $env:LOCALAPPDATA 'Android\Sdk'),
    [string]$JdkPath = $env:JAVA_HOME
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ApkPath) { $ApkPath = Join-Path $repoRoot 'android\app\build\outputs\apk\debug\app-debug.apk' }
if (-not (Test-Path -LiteralPath $ApkPath -PathType Leaf)) { throw 'APK not found.' }
$toolsRoot = Join-Path $SdkPath 'build-tools'
if (-not (Test-Path -LiteralPath $toolsRoot -PathType Container)) { throw 'Android SDK build-tools not found.' }
$buildTools = Get-ChildItem -LiteralPath $toolsRoot -Directory | Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $buildTools) { throw 'Android SDK build-tools not found.' }
$signer = Join-Path $buildTools.FullName 'apksigner.bat'
$aapt = Join-Path $buildTools.FullName 'aapt2.exe'

function Read-ApkIdentity([string]$Path) {
    $signature = & $signer verify --print-certs $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'APK signature validation failed.' }
    $digests = @($signature | Select-String '^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$' | ForEach-Object { $_.Matches[0].Groups[1].Value.ToLowerInvariant() })
    if ($digests.Count -ne 1) { throw 'Expected exactly one APK signing certificate.' }
    $metadata = & $aapt dump badging $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'APK package metadata could not be read.' }
    $packageLine = $metadata | Select-String "^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'" | Select-Object -First 1
    if (-not $packageLine) { throw 'APK package metadata is incomplete.' }
    $groups = $packageLine.Matches[0].Groups
    [PSCustomObject]@{ ApplicationId = $groups[1].Value; VersionCode = [int]$groups[2].Value; VersionName = $groups[3].Value; CertificateSha256 = $digests[0] }
}

$previousJavaHome = $env:JAVA_HOME
try {
    if ($JdkPath) { $env:JAVA_HOME = $JdkPath }
    $current = Read-ApkIdentity $ApkPath
    $packageVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
    if ($current.ApplicationId -ne 'com.flylabs.salary') { throw 'The application ID changed; Android would install a separate app.' }
    if ($current.VersionName -ne $packageVersion) { throw 'APK version differs from package.json.' }
    # Public fingerprint of the key used for 0.3.2. The private key stays outside Git.
    # A new checkout must not publish an APK signed with an automatically generated debug key.
    if ($current.CertificateSha256 -ne 'e4e6766599c1795eacd3a75fd7cfc3ff26f1e101ce2623acd27318906b817539') {
        throw 'APK signing certificate differs from the existing distribution. Restore the original signing key before releasing.'
    }
    if ($current.VersionCode -lt 8) { throw 'APK versionCode must be at least 8 for this release line.' }
    if ($BaselineApk) {
        if (-not (Test-Path -LiteralPath $BaselineApk -PathType Leaf)) { throw 'Baseline APK not found.' }
        $baseline = Read-ApkIdentity $BaselineApk
        if ($baseline.ApplicationId -ne $current.ApplicationId -or $baseline.CertificateSha256 -ne $current.CertificateSha256) { throw 'Baseline and new APK identities differ; an in-place upgrade is not possible.' }
        if ($current.VersionCode -le $baseline.VersionCode) { throw 'Increase Android versionCode above the baseline before releasing.' }
    }
    $current
} finally { $env:JAVA_HOME = $previousJavaHome }
