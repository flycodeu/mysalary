param(
    [string]$JdkPath = $env:JAVA_HOME,
    [string]$SdkPath = $env:ANDROID_SDK_ROOT,
    [string]$PreviousApk,
    [switch]$PublishGitHub
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
    $setup = Join-Path $repoRoot "releases\salary-$version-windows-setup.exe"
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw "Windows installer was not generated: $setup" }
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
    $files = @($apkOut, $zipOut, $setup)
    $hashes = @($files | ForEach-Object { "{0}  {1}" -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path -Leaf $_) })
    [IO.File]::WriteAllLines((Join-Path $releaseDir 'SHA256SUMS.txt'), $hashes, [Text.UTF8Encoding]::new($false))
    if ($PublishGitHub) {
        $ghPath = (Get-Command gh.exe -ErrorAction SilentlyContinue).Source
        if (-not $ghPath -and (Test-Path -LiteralPath 'C:\Program Files\GitHub CLI\gh.exe')) { $ghPath = 'C:\Program Files\GitHub CLI\gh.exe' }
        if (-not $ghPath) { throw 'GitHub CLI not found. Install gh or run without -PublishGitHub.' }
        & $ghPath auth status
        if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not authenticated.' }
        $repo = (& git config --get remote.origin.url).Trim() -replace '\.git$','' -replace '^https://github.com/',''
        if ($repo -notmatch '^[^/]+/[^/]+$') { throw 'Cannot determine GitHub owner/repository from origin.' }
        $tag = "v$version"
        $assets = @($apkOut, $zipOut, $setup, (Join-Path $releaseDir 'SHA256SUMS.txt'))
        & $ghPath release view $tag --repo $repo *> $null
        if ($LASTEXITCODE -eq 0) { & $ghPath release upload $tag @assets --repo $repo --clobber }
        else { & $ghPath release create $tag @assets --repo $repo --title "薪迹 $version" --notes "自动发布 $version。" }
        if ($LASTEXITCODE -ne 0) { throw "GitHub Release $tag publication failed." }
        Write-Host "Published GitHub Release $tag for $repo."
    } else {
        Write-Host "Built $version. Use -PublishGitHub to create or update the GitHub Release."
    }
} finally { Pop-Location }
