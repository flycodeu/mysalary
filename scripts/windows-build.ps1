param([switch]$Test, [switch]$SkipFrontend)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $frameworkRoot 'csc.exe'
$wpfRoot = Join-Path $frameworkRoot 'WPF'
$outDir = Join-Path $repoRoot 'releases\windows'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'package.json must contain a stable major.minor.patch version.' }
$generatedDirectory = Join-Path $repoRoot '.artifacts\windows-build'
New-Item -ItemType Directory -Force -Path $generatedDirectory | Out-Null
$versionSource = Join-Path $generatedDirectory 'VersionInfo.cs'
[IO.File]::WriteAllText($versionSource, @"
using System.Reflection;
[assembly: AssemblyVersion("$version.0")]
[assembly: AssemblyFileVersion("$version.0")]
[assembly: AssemblyInformationalVersion("$version")]
"@, (New-Object Text.UTF8Encoding($false)))
& (Join-Path $PSScriptRoot 'generate-icons.ps1')
$sdkVersion = '1.0.4258.31'
$sdkSha256 = '56F7F4B8BF9AEE4B8EFEFBBDD4F67D5F74EBD1B100ED0806DA71BF76AF481AA9'
$sdkDir = Join-Path $repoRoot ".artifacts\webview2-sdk\$sdkVersion"
$sdkPackage = Join-Path $sdkDir 'sdk.nupkg'
New-Item -ItemType Directory -Force -Path $sdkDir | Out-Null
if (-not (Test-Path -LiteralPath $sdkPackage)) {
    Invoke-WebRequest "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg" -OutFile $sdkPackage
}
if ((Get-FileHash -LiteralPath $sdkPackage -Algorithm SHA256).Hash -ne $sdkSha256) { throw 'WebView2 SDK checksum mismatch.' }
$sdkContents = Join-Path $sdkDir 'package'
if (-not (Test-Path -LiteralPath $sdkContents)) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($sdkPackage, $sdkContents)
}
if (-not $SkipFrontend) {
    Push-Location $repoRoot
    try {
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
    } finally { Pop-Location }
}
$source = Join-Path $repoRoot 'windows\SalaryCollector\Program.cs'
$manifest = Join-Path $repoRoot 'windows\SalaryCollector\app.manifest'
$exe = Join-Path $outDir 'SalaryCollector.exe'
$references = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Runtime.Serialization.dll') | ForEach-Object { '/reference:' + (Join-Path $frameworkRoot $_) }
$references += @('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll') | ForEach-Object { '/reference:' + (Join-Path $wpfRoot $_) }
& $compiler /nologo /target:winexe /platform:anycpu /optimize+ /utf8output "/win32manifest:$manifest" "/out:$exe" @references $source
if ($LASTEXITCODE -ne 0) { throw 'Windows collector compilation failed.' }
$desktopExe = Join-Path $outDir 'Salary.exe'
$desktopIcon = Join-Path $repoRoot 'windows\Installer\Salary.ico'
$desktopSources = @(Get-ChildItem (Join-Path $repoRoot 'windows\SalaryDesktop\*.cs') | ForEach-Object { $_.FullName })
$desktopSources += $versionSource
$desktopReferences = $references + @('System.Net.Http.dll', 'System.Web.Extensions.dll', 'System.Security.dll', 'System.Xml.Linq.dll') | ForEach-Object { if ($_ -like '/reference:*') { $_ } else { '/reference:' + (Join-Path $frameworkRoot $_) } }
$webViewLib = Join-Path $sdkContents 'lib\net462'
foreach ($assembly in @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll')) {
    $desktopReferences += '/reference:' + (Join-Path $webViewLib $assembly)
    Copy-Item -LiteralPath (Join-Path $webViewLib $assembly) -Destination $outDir -Force
}
Copy-Item -LiteralPath (Join-Path $sdkContents 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $outDir -Force
Copy-Item -LiteralPath (Join-Path $sdkContents 'LICENSE.txt') -Destination (Join-Path $outDir 'WebView2-LICENSE.txt') -Force
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /utf8output /main:SalaryDesktop.Program "/win32manifest:$manifest" "/win32icon:$desktopIcon" "/out:$desktopExe" @desktopReferences $source @desktopSources
if ($LASTEXITCODE -ne 0) { throw 'Windows desktop compilation failed.' }
$frontendDist = Join-Path $repoRoot 'dist'
if (-not (Test-Path (Join-Path $frontendDist 'index.html'))) { throw 'Frontend dist/index.html is missing.' }
$appDir = Join-Path $outDir 'app'
if (Test-Path -LiteralPath $appDir) {
    $expectedAppPath = [IO.Path]::GetFullPath((Join-Path $repoRoot 'releases\windows\app'))
    $actualAppPath = (Get-Item -LiteralPath $appDir).FullName
    if ($actualAppPath -ne $expectedAppPath) { throw 'Refusing to replace assets outside the generated app directory.' }
    $linkedPaths = @(Get-Item -LiteralPath $appDir) + @(Get-ChildItem -LiteralPath $appDir -Recurse -Force)
    if ($linkedPaths | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Refusing to replace generated assets containing a link.' }
    Remove-Item -LiteralPath $actualAppPath -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $appDir | Out-Null
Copy-Item -Path (Join-Path $frontendDist '*') -Destination $appDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'README.md') -Destination (Join-Path $outDir '使用说明.md') -Force
if ($Test) {
    $testProcess = Start-Process -FilePath $exe -ArgumentList '--self-test' -Wait -PassThru -WindowStyle Hidden
    if ($testProcess.ExitCode -ne 0) { throw 'Windows collector self-test failed.' }
    $desktopTest = Start-Process -FilePath $desktopExe -ArgumentList '--self-test' -Wait -PassThru -WindowStyle Hidden
    if ($desktopTest.ExitCode -ne 0) { throw 'Windows desktop self-test failed.' }
}
Get-Item $desktopExe, $exe | Select-Object FullName, Length
