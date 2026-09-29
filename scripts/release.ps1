param(
    [string]$JdkPath = $env:JAVA_HOME,
    [string]$SdkPath = $env:ANDROID_SDK_ROOT,
    [string]$PreviousApk,
    [string]$NotesFile,
    [switch]$PublishGitHub
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $SdkPath) { $SdkPath = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Release requires a stable version.' }
if (-not $PreviousApk -or -not (Test-Path -LiteralPath $PreviousApk -PathType Leaf)) {
    throw 'Pass -PreviousApk with the previously distributed APK to verify signing continuity.'
}
$PreviousApk = (Resolve-Path -LiteralPath $PreviousApk).Path
$releaseDir = Join-Path $repoRoot 'releases'
# A new staging directory leaves the last working packages intact if any build fails.
$stagingDir = Join-Path $repoRoot ('.artifacts\release-staging\' + $version + '-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
Push-Location $repoRoot
try {
    if ($PublishGitHub) {
        if (-not $NotesFile -or -not (Test-Path -LiteralPath $NotesFile -PathType Leaf)) { throw 'Publishing requires -NotesFile with reviewed release notes.' }
        $NotesFile = (Resolve-Path -LiteralPath $NotesFile).Path
        if (@(git status --porcelain).Count) { throw 'Commit all release source files before publishing.' }
        $releaseCommit = (& git rev-parse HEAD).Trim()
        $ghPath = (Get-Command gh.exe -ErrorAction SilentlyContinue).Source
        if (-not $ghPath -and (Test-Path -LiteralPath 'C:\Program Files\GitHub CLI\gh.exe')) { $ghPath = 'C:\Program Files\GitHub CLI\gh.exe' }
        if (-not $ghPath) { throw 'GitHub CLI not found.' }
        $repo = (& git config --get remote.origin.url).Trim() -replace '\.git$','' -replace '^https://github.com/',''
        if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Cannot determine GitHub owner/repository from origin.' }
        & $ghPath api "repos/$repo/commits/$releaseCommit" --jq .sha
        if ($LASTEXITCODE -ne 0) { throw 'Push the release commit to GitHub before publishing.' }
        $releaseList = & $ghPath release list --repo $repo --limit 1000 --json tagName
        if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect existing releases.' }
        if (@($releaseList | ConvertFrom-Json | Where-Object { $_.tagName -eq "v$version" }).Count) {
            throw 'This release already exists. Published assets are never overwritten; choose a new version.'
        }
    }
    & pnpm test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
    & pnpm exec cap sync android
    if ($LASTEXITCODE -ne 0) { throw 'Android asset sync failed.' }
    & (Join-Path $PSScriptRoot 'windows-build.ps1') -Test -SkipFrontend
    & (Join-Path $PSScriptRoot 'windows-installer.ps1') -SkipBuild -OutputDirectory $stagingDir
    $setup = Join-Path $stagingDir "salary-$version-windows-setup.exe"
    if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'Windows installer was not generated.' }
    & (Join-Path $PSScriptRoot 'android-build.ps1') -SkipWebBuild -JdkPath $JdkPath -SdkPath $SdkPath
    $apk = Join-Path $repoRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
    & (Join-Path $PSScriptRoot 'verify-android-upgrade.ps1') -BaselineApk $PreviousApk -ApkPath $apk -SdkPath $SdkPath -JdkPath $JdkPath
    $apkOut = Join-Path $stagingDir "salary-$version-debug.apk"
    Copy-Item -LiteralPath $apk -Destination $apkOut -Force
    $zipOut = Join-Path $stagingDir "salary-$version-windows.zip"
    $runtimeFiles = @('Salary.exe', 'SalaryCollector.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'WebView2-LICENSE.txt', '使用说明.md', 'app')
    $runtimePaths = @($runtimeFiles | ForEach-Object { Join-Path (Join-Path $releaseDir 'windows') $_ })
    Compress-Archive -LiteralPath $runtimePaths -DestinationPath $zipOut -Force
    $files = @($apkOut, $zipOut, $setup)
    $hashes = @($files | ForEach-Object { '{0}  {1}' -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path -Leaf $_) })
    $sums = Join-Path $stagingDir 'SHA256SUMS.txt'
    [IO.File]::WriteAllLines($sums, $hashes, [Text.UTF8Encoding]::new($false))
    $stagedAssets = @($files) + @($sums)
    foreach ($file in $stagedAssets) {
        $destination = Join-Path $releaseDir (Split-Path -Leaf $file)
        Copy-Item -LiteralPath $file -Destination $destination -Force
        if ((Get-FileHash -LiteralPath $file).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw 'Release copy verification failed. Staged files have been retained.' }
    }
    # Remove only recognized historical root packages after the complete new set is verified.
    $currentNames = @($stagedAssets | ForEach-Object { Split-Path -Leaf $_ })
    Get-ChildItem -LiteralPath $releaseDir -File -Force | Where-Object {
        $_.Name -match '^salary-\d+\.\d+\.\d+-(debug\.apk|windows(?:-setup\.exe|\.zip))$' -and $_.Name -notin $currentNames
    } | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }
    if ($PublishGitHub) {
        if (@(git status --porcelain).Count) { throw 'The build changed source files. Commit them and rebuild before publishing.' }
        $tag = "v$version"
        & $ghPath release create $tag @stagedAssets --repo $repo --target $releaseCommit --draft --title "薪迹 $version" --notes-file $NotesFile
        if ($LASTEXITCODE -ne 0) { throw 'Release draft upload failed. Any draft is retained for inspection.' }
        $downloadDir = Join-Path $stagingDir 'download-check'
        & $ghPath release download $tag --repo $repo --dir $downloadDir
        if ($LASTEXITCODE -ne 0) { throw 'Release download failed; the release remains a draft.' }
        foreach ($file in $stagedAssets) {
            $downloaded = Join-Path $downloadDir (Split-Path -Leaf $file)
            if ((Get-FileHash -LiteralPath $file).Hash -ne (Get-FileHash -LiteralPath $downloaded).Hash) { throw 'Uploaded asset checksum mismatch; the release remains a draft.' }
        }
        & $ghPath release edit $tag --repo $repo --draft=false --latest
        if ($LASTEXITCODE -ne 0) { throw 'Publishing the verified release draft failed.' }
        Write-Host "Published verified GitHub Release $tag for $repo."
    } else {
        Write-Host "Built $version. Pass -PublishGitHub and -NotesFile to publish a new verified Release."
    }
} finally { Pop-Location }
