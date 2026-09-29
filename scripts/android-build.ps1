param(
    [string]$JdkPath = $env:JAVA_HOME,
    [string]$SdkPath = $env:ANDROID_SDK_ROOT,
    [string]$ProxyUrl = '',
    [switch]$SkipWebBuild,
    [string[]]$Tasks = @(':app:assembleDebug', ':app:testDebugUnitTest', ':app:lintDebug')
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $SdkPath) { $SdkPath = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not $JdkPath) {
    $javaCommand = Get-Command java.exe -ErrorAction SilentlyContinue
    if ($javaCommand) { $JdkPath = Split-Path -Parent (Split-Path -Parent $javaCommand.Source) }
}
if (-not $JdkPath) { throw 'Set JAVA_HOME to a JDK 21 directory or pass -JdkPath.' }
if (-not (Test-Path -LiteralPath (Join-Path $JdkPath 'bin\java.exe'))) {
    throw "JDK not found at $JdkPath. Pass -JdkPath with a JDK 21 directory."
}
if (-not (Test-Path -LiteralPath $SdkPath)) {
    throw "Android SDK not found at $SdkPath. Pass -SdkPath with an existing SDK directory."
}

$previousJavaHome = $env:JAVA_HOME
$previousAndroidHome = $env:ANDROID_HOME
$previousAndroidSdkRoot = $env:ANDROID_SDK_ROOT
Push-Location $projectRoot
try {
    # Child-process environment only. The user's system JDK and SDK settings are not changed.
    $env:JAVA_HOME = $JdkPath
    $env:ANDROID_HOME = $SdkPath
    $env:ANDROID_SDK_ROOT = $SdkPath
    if (-not $SkipWebBuild) {
        & (Join-Path $PSScriptRoot 'generate-icons.ps1')
        & pnpm build
        if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
        & pnpm exec cap sync android
        if ($LASTEXITCODE -ne 0) { throw 'Capacitor sync failed.' }
    }
    $networkArguments = @()
    if ($ProxyUrl) {
        $proxyAddress = [Uri]$ProxyUrl
        if ($proxyAddress.Scheme -ne 'http' -or $proxyAddress.UserInfo) {
            throw 'ProxyUrl must be an HTTP proxy without embedded credentials.'
        }
        $networkArguments = @(
            "-Dhttp.proxyHost=$($proxyAddress.Host)", "-Dhttp.proxyPort=$($proxyAddress.Port)",
            "-Dhttps.proxyHost=$($proxyAddress.Host)", "-Dhttps.proxyPort=$($proxyAddress.Port)"
        )
    }
    # AGP may fetch the required SDK platform when the existing SDK licenses permit it.
    & .\android\gradlew.bat -p android @Tasks @networkArguments --console=plain '-Pandroid.builder.sdkDownload=true' `
        '-Dorg.gradle.internal.http.connectionTimeout=15000' '-Dorg.gradle.internal.http.socketTimeout=30000'
    if ($LASTEXITCODE -ne 0) { throw 'Android build or checks failed. See the first Gradle error above.' }
    Write-Host 'APK: android/app/build/outputs/apk/debug/app-debug.apk'
    Write-Host 'Build checks do not replace device file-import, share-import, upgrade, and restart tests.'
} finally {
    $env:JAVA_HOME = $previousJavaHome
    $env:ANDROID_HOME = $previousAndroidHome
    $env:ANDROID_SDK_ROOT = $previousAndroidSdkRoot
    Pop-Location
}
