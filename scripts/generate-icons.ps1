$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repoRoot 'public\brand.svg'
[xml]$svg = Get-Content -LiteralPath $source -Raw
$shapes = @($svg.svg.path)
$resources = Join-Path $repoRoot 'android\app\src\main\res'
$utf8 = New-Object Text.UTF8Encoding($false)

# The shared brand uses only absolute M/L/C/Z paths. Refuse unsupported drawing commands
# instead of silently generating a different icon on one platform.
function Read-BrandPath([string]$Data) {
    $tokens = @([regex]::Matches($Data, '[A-Za-z]|-?\d+(?:\.\d+)?') | ForEach-Object { $_.Value })
    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $index = 0
    [single]$x = 0; [single]$y = 0
    while ($index -lt $tokens.Count) {
        $command = $tokens[$index++]
        switch ($command) {
            'M' { $x = [single]$tokens[$index++]; $y = [single]$tokens[$index++]; $path.StartFigure() }
            'L' {
                [single]$nextX = $tokens[$index++]; [single]$nextY = $tokens[$index++]
                $path.AddLine($x, $y, $nextX, $nextY); $x = $nextX; $y = $nextY
            }
            'C' {
                [single]$x1 = $tokens[$index++]; [single]$y1 = $tokens[$index++]
                [single]$x2 = $tokens[$index++]; [single]$y2 = $tokens[$index++]
                [single]$nextX = $tokens[$index++]; [single]$nextY = $tokens[$index++]
                $path.AddBezier($x, $y, $x1, $y1, $x2, $y2, $nextX, $nextY); $x = $nextX; $y = $nextY
            }
            'Z' { $path.CloseFigure() }
            default { $path.Dispose(); throw "Unsupported SVG path command: $command" }
        }
    }
    return ,$path
}

function Render-Brand([int]$Size) {
    $bitmap = New-Object Drawing.Bitmap($Size, $Size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.ScaleTransform($Size / 128.0, $Size / 128.0)
        foreach ($shape in $shapes) {
            $path = Read-BrandPath $shape.d
            try {
                if ($shape.fill -and $shape.fill -ne 'none') {
                    $brush = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml($shape.fill))
                    try { $graphics.FillPath($brush, $path) } finally { $brush.Dispose() }
                }
                if ($shape.stroke) {
                    $pen = New-Object Drawing.Pen([Drawing.ColorTranslator]::FromHtml($shape.stroke), [single]$shape.'stroke-width')
                    $pen.StartCap = $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
                    $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
                    try { $graphics.DrawPath($pen, $path) } finally { $pen.Dispose() }
                }
            } finally { $path.Dispose() }
        }
    } finally { $graphics.Dispose() }
    return ,$bitmap
}

function Write-Vector([string]$Target, [bool]$ForegroundOnly, [bool]$Monochrome = $false) {
    $lines = New-Object 'System.Collections.Generic.List[string]'
    $lines.Add('<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="128" android:viewportHeight="128">')
    foreach ($shape in $shapes) {
        if ($ForegroundOnly -and $shape.'data-layer' -eq 'background') { continue }
        # Android themed icons keep the page outline and trajectory visible in one system color.
        if ($Monochrome -and $shape.fill -eq '#BDD3C4') { continue }
        $attributes = @('android:pathData="' + $shape.d + '"')
        if ($Monochrome) { $attributes += 'android:fillColor="@android:color/transparent" android:strokeColor="#FFFFFF" android:strokeWidth="6" android:strokeLineCap="round" android:strokeLineJoin="round"' }
        elseif ($shape.fill) { $attributes += 'android:fillColor="' + $shape.fill + '"' }
        else { $attributes += 'android:fillColor="@android:color/transparent"' }
        if ($shape.stroke -and -not $Monochrome) {
            $attributes += 'android:strokeColor="' + $shape.stroke + '"'
            $attributes += 'android:strokeWidth="' + $shape.'stroke-width' + '"'
            $attributes += 'android:strokeLineCap="round" android:strokeLineJoin="round"'
        }
        $lines.Add('    <path ' + ($attributes -join ' ') + ' />')
    }
    $lines.Add('</vector>')
    [IO.File]::WriteAllText($Target, ($lines -join "`n") + "`n", $utf8)
}

Write-Vector (Join-Path $resources 'mipmap-anydpi\ic_launcher.xml') $false
Write-Vector (Join-Path $resources 'mipmap-anydpi\ic_launcher_round.xml') $false
Write-Vector (Join-Path $resources 'drawable\ic_salary_foreground.xml') $true
Write-Vector (Join-Path $resources 'drawable\ic_salary_monochrome.xml') $true $true

$frames = foreach ($size in @(16, 24, 32, 48, 64, 128, 256)) {
    $bitmap = Render-Brand $size
    $stream = New-Object IO.MemoryStream
    try {
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        @{ Size = $size; Bytes = $stream.ToArray() }
    } finally { $stream.Dispose(); $bitmap.Dispose() }
}
$target = Join-Path $repoRoot 'windows\Installer\Salary.ico'
$writer = New-Object IO.BinaryWriter([IO.File]::Create($target))
try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
    $offset = 6 + 16 * $frames.Count
    foreach ($frame in $frames) {
        $encodedSize = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
        $writer.Write([byte]$encodedSize); $writer.Write([byte]$encodedSize)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
        $offset += $frame.Bytes.Length
    }
    foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
} finally { $writer.Dispose() }
Write-Host 'Generated Windows ICO and Android vectors from public/brand.svg.'
