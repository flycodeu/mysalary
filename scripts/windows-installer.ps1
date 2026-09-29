param(
    [switch]$SkipBuild,
    [string]$CompilerPath = $env:INNO_SETUP_COMPILER,
    [string]$SourceDirectory,
    [string]$OutputDirectory,
    [string]$InstallerTestId,
    [string]$InstallerTestRoot,
    [string]$TestVersion
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($InstallerTestId) {
    if ($InstallerTestId -notmatch '^[a-f0-9]{32}$') { throw 'InstallerTestId must be a GUID without separators.' }
    if (-not $InstallerTestRoot -or -not [IO.Path]::IsPathRooted($InstallerTestRoot)) { throw 'A full isolated InstallerTestRoot is required.' }
    $InstallerTestRoot = [IO.Path]::GetFullPath($InstallerTestRoot).TrimEnd('\')
    if ($InstallerTestRoot.Contains('"') -or $InstallerTestRoot.Contains("'")) { throw 'Invalid test root.' }
    if ($TestVersion) { $version = $TestVersion }
} elseif ($InstallerTestRoot -or $TestVersion -or $SourceDirectory) {
    throw 'Custom payload and test version are only available for isolated installer tests.'
}
if ($version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Invalid installer version.' }
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'windows-build.ps1') -Test
}
if (-not $SourceDirectory) { $SourceDirectory = Join-Path $repoRoot 'releases\windows' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot 'releases' }
$SourceDirectory = [IO.Path]::GetFullPath($SourceDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
foreach ($file in @('Salary.exe', 'SalaryCollector.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'WebView2-LICENSE.txt', '使用说明.md', 'app\index.html')) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDirectory $file) -PathType Leaf)) { throw "Missing installer payload: $file" }
}
if (-not $InstallerTestId) {
    $exeVersion = (Get-Item -LiteralPath (Join-Path $SourceDirectory 'Salary.exe')).VersionInfo.FileVersion
    if ($exeVersion -ne "$version.0") { throw 'Salary.exe version differs from package.json. Rebuild before packaging.' }
}
if (-not $CompilerPath) {
    $availableCompiler = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($availableCompiler) { $CompilerPath = $availableCompiler.Source }
}
if (-not $CompilerPath) {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Antigravity IDE\resources\app\node_modules\innosetup\bin\ISCC.exe')
    )
    $CompilerPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $CompilerPath -or -not (Test-Path -LiteralPath $CompilerPath -PathType Leaf)) {
    throw 'Inno Setup 6 compiler not found. Install Inno Setup or pass -CompilerPath (or INNO_SETUP_COMPILER).'
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$defines = @("/DAppVersion=$version", "/DSourceDir=$SourceDirectory", "/DOutputDir=$OutputDirectory")
if ($InstallerTestId) { $defines += @("/DInstallerTestId=$InstallerTestId", "/DInstallerTestRoot=$InstallerTestRoot") }
& $CompilerPath /Q @defines (Join-Path $repoRoot 'windows\Installer\Salary.iss')
if ($LASTEXITCODE -ne 0) { throw 'Windows installer compilation failed.' }
$outputName = if ($InstallerTestId) { "salary-installer-test-$version.exe" } else { "salary-$version-windows-setup.exe" }
$result = Get-Item -LiteralPath (Join-Path $OutputDirectory $outputName)
[PSCustomObject]@{ FullName = $result.FullName; Length = $result.Length; SHA256 = (Get-FileHash -LiteralPath $result.FullName -Algorithm SHA256).Hash }
