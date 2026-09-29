param(
    [string]$JdkPath = $env:JAVA_HOME,
    [string]$SdkPath = $env:ANDROID_SDK_ROOT,
    [string]$PreviousApk
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $SdkPath) { $SdkPath = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Release requires a stable version.' }
if (-not $PreviousApk -or -not (Test-Path -LiteralPath $PreviousApk -PathType Leaf)) {
    throw 'Pass -PreviousApk with the previously distributed APK to verify signing continuity before distribution.'
}
$PreviousApk = (Resolve-Path -LiteralPath $PreviousApk).Path
Push-Location $repoRoot
try {
    & pnpm test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
    & pnpm exec cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'Android asset sync failed.' }
    & (Join-Path $PSScriptRoot 'windows-build.ps1') -Test -SkipFrontend
    & (Join-Path $PSScriptRoot 'windows-installer.ps1') -SkipBuild
    & (Join-Path $PSScriptRoot 'android-build.ps1') -SkipWebBuild -JdkPath $JdkPath -SdkPath $SdkPath
    $apk = Join-Path $repoRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
    & (Join-Path $PSScriptRoot 'verify-android-upgrade.ps1') -BaselineApk $PreviousApk -ApkPath $apk -SdkPath $SdkPath -JdkPath $JdkPath
    $releaseDir = Join-Path $repoRoot 'releases'
    # Keep the generated directory bounded. Only release artifacts at its root are disposable;
    # the Windows runtime folder is rebuilt separately and is needed for packaging.
    if (Test-Path -LiteralPath $releaseDir) {
        Get-ChildItem -LiteralPath $releaseDir -File -Force |
            Where-Object { $_.Name -match '^salary-\d+\.\d+\.\d+-(debug\.apk|windows(?:-setup\.exe|\.zip))$' -or $_.Name -eq 'SHA256SUMS.txt' } |
            Remove-Item -Force
    } else {
        New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
    }
    $apkOut = Join-Path $releaseDir "salary-$version-debug.apk"
    Copy-Item -LiteralPath $apk -Destination $apkOut -Force
    $zipOut = Join-Path $releaseDir "salary-$version-windows.zip"
    # Package only owned runtime files, excluding leftovers in the local build directory.
    $runtimeFiles = @('Salary.exe', 'SalaryCollector.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'WebView2-LICENSE.txt', '使用说明.md', 'app')
    $runtimePaths = @($runtimeFiles | ForEach-Object { Join-Path (Join-Path $releaseDir 'windows') $_ })
    Compress-Archive -LiteralPath $runtimePaths -DestinationPath $zipOut -Force
    $files = @($apkOut, $zipOut, (Join-Path $releaseDir "salary-$version-windows-setup.exe"))
    $hashes = @($files | ForEach-Object { "{0}  {1}" -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path -Leaf $_) })
    [IO.File]::WriteAllLines((Join-Path $releaseDir 'SHA256SUMS.txt'), $hashes, [Text.UTF8Encoding]::new($false))
    Write-Host "Built $version. No Git commit, push or release publication was performed."
} finally { Pop-Location }
