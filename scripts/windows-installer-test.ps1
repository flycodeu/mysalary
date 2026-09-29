param([string]$CompilerPath = $env:INNO_SETUP_COMPILER, [switch]$KeepInstalled)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$testId = [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "SalaryTrail-InstallerTest-$testId"
$payload = Join-Path $testRoot 'Payload'
$installPath = Join-Path $testRoot '自选目录 With Spaces\薪迹'
$userData = Join-Path $testRoot 'IsolatedUserData'
$packageDir = Join-Path $testRoot 'Packages'
$registryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SalaryTrail.Test.$testId`_is1"
$testLog = Join-Path $testRoot 'installer-test-result.json'
$checks = New-Object 'System.Collections.Generic.List[string]'

function Assert-Check([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw "Installer check failed: $Label" }
    $checks.Add($Label)
}
function Run-Installer([string]$Path, [string[]]$Arguments, [bool]$ExpectSuccess = $true) {
    $process = Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru -Wait -WindowStyle Hidden
    if ($ExpectSuccess -and $process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode). Logs: $testRoot" }
    if (-not $ExpectSuccess -and $process.ExitCode -eq 0) { throw 'The installer accepted a forbidden test directory.' }
}
function Assert-Sentinel {
    Assert-Check ((Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -eq $sentinelHash) 'isolated data remains byte-for-byte unchanged'
}
function Uninstall-Test {
    $uninstaller = Join-Path $installPath 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        Run-Installer $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $testRoot 'uninstall.log')`"")
    }
}

try {
    New-Item -ItemType Directory -Path $payload, $userData, $packageDir -Force | Out-Null
    Copy-Item -Path (Join-Path $repoRoot 'releases\windows\*') -Destination $payload -Recurse -Force
    $sentinel = Join-Path $userData 'archive-v1.json'
    [IO.File]::WriteAllText($sentinel, '{"synthetic":true,"purpose":"installer data retention check"}', (New-Object Text.UTF8Encoding($false)))
    $sentinelHash = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
    $readme = Join-Path $payload '使用说明.md'
    [IO.File]::WriteAllText($readme, 'Synthetic installer payload revision 1')
    $first = & (Join-Path $PSScriptRoot 'windows-installer.ps1') -SkipBuild -CompilerPath $CompilerPath -SourceDirectory $payload -OutputDirectory $packageDir -InstallerTestId $testId -InstallerTestRoot $testRoot -TestVersion '0.3.2.0'
    $firstSetup = ($first | Where-Object { $_.FullName } | Select-Object -Last 1).FullName
    Run-Installer $firstSetup @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=desktopicon', "/DIR=`"$installPath`"", "/LOG=`"$(Join-Path $testRoot 'install.log')`"")
    Assert-Check (Test-Path -LiteralPath (Join-Path $installPath 'Salary.exe')) 'installs into custom Chinese path containing spaces'
    Assert-Check (Test-Path -LiteralPath (Join-Path $installPath 'app\index.html')) 'shared interface payload installed'
    Assert-Check (Test-Path -LiteralPath $registryPath) 'independent current-user uninstall entry created'
    $registration = Get-ItemProperty -LiteralPath $registryPath
    Assert-Check ($registration.DisplayVersion -eq '0.3.2.0') 'installed version recorded'
    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcut in @('Shortcuts\Start Menu\薪迹.lnk', 'Shortcuts\Desktop\薪迹.lnk')) {
        $linkPath = Join-Path $testRoot $shortcut
        Assert-Check (Test-Path -LiteralPath $linkPath) 'isolated shortcut created'
        Assert-Check ($shell.CreateShortcut($linkPath).TargetPath -eq (Join-Path $installPath 'Salary.exe')) 'shortcut targets selected installation directory'
    }
    [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
    Assert-Sentinel

    [IO.File]::WriteAllText($readme, 'Synthetic installer payload revision 2')
    $second = & (Join-Path $PSScriptRoot 'windows-installer.ps1') -SkipBuild -CompilerPath $CompilerPath -SourceDirectory $payload -OutputDirectory $packageDir -InstallerTestId $testId -InstallerTestRoot $testRoot -TestVersion '0.4.0.0'
    $secondSetup = ($second | Where-Object { $_.FullName } | Select-Object -Last 1).FullName
    # No /DIR: verify an upgrade remembers the directory selected during installation.
    Run-Installer $secondSetup @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $testRoot 'upgrade.log')`"")
    Assert-Check ((Get-Content -LiteralPath (Join-Path $installPath '使用说明.md') -Raw) -eq 'Synthetic installer payload revision 2') 'upgrade replaces payload at the previous custom directory'
    Assert-Check ((Get-ItemProperty -LiteralPath $registryPath).DisplayVersion -eq '0.4.0.0') 'upgrade updates existing uninstall entry'
    Assert-Sentinel

    # The test build must reject installation outside its unique directory before copying files.
    $forbiddenPath = Join-Path ([IO.Path]::GetTempPath()) "SalaryTrail-Rejected-$testId"
    Run-Installer $secondSetup @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$forbiddenPath`"", "/LOG=`"$(Join-Path $testRoot 'rejected.log')`"") $false
    Assert-Check (-not (Test-Path -LiteralPath $forbiddenPath)) 'test installer rejects paths outside isolation'

    $junctionTarget = Join-Path $testRoot 'JunctionTarget'
    $junctionPath = Join-Path $testRoot 'LinkedInstallFolder'
    New-Item -ItemType Directory -Path $junctionTarget -Force | Out-Null
    New-Item -ItemType Junction -Path $junctionPath -Target $junctionTarget | Out-Null
    Run-Installer $secondSetup @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$(Join-Path $junctionPath 'Application')`"", "/LOG=`"$(Join-Path $testRoot 'rejected-junction.log')`"") $false
    Assert-Check (-not (Test-Path -LiteralPath (Join-Path $junctionTarget 'Application'))) 'installer rejects linked ancestor before writing payload'
    $aliasPath = Join-Path $testRoot 'SHORT~1\Application'
    Run-Installer $secondSetup @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$aliasPath`"", "/LOG=`"$(Join-Path $testRoot 'rejected-alias.log')`"") $false
    Assert-Check (-not (Test-Path -LiteralPath $aliasPath)) 'installer rejects short path aliases before writing payload'

    if (-not $KeepInstalled) {
        Uninstall-Test
        Assert-Check (-not (Test-Path -LiteralPath (Join-Path $installPath 'Salary.exe'))) 'uninstall removes application executable'
        Assert-Check (-not (Test-Path -LiteralPath (Join-Path $installPath 'app\index.html'))) 'uninstall removes application interface'
        Assert-Check (-not (Test-Path -LiteralPath $registryPath)) 'uninstall removes its independent registration'
        Assert-Check (-not (Test-Path -LiteralPath (Join-Path $testRoot 'Shortcuts\Desktop\薪迹.lnk'))) 'uninstall removes desktop shortcut'
        Assert-Check (-not (Test-Path -LiteralPath (Join-Path $testRoot 'Shortcuts\Start Menu\薪迹.lnk'))) 'uninstall removes start menu shortcut'
        Assert-Sentinel
    }
    $result = [PSCustomObject]@{ Status = 'PASS'; CheckCount = $checks.Count; Checks = $checks.ToArray(); TestRoot = $testRoot; InstallPath = $installPath; KeptInstalled = [bool]$KeepInstalled; RealUserDataAccessed = $false; AppLaunched = $false }
    $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $testLog -Encoding UTF8
    $result
} catch {
    try { Uninstall-Test } catch { Write-Warning 'Isolated installer cleanup failed; inspect the test directory.' }
    throw
}
