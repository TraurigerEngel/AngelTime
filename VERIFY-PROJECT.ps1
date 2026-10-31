$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$manifest = Join-Path $PSScriptRoot 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $manifest)) { throw 'SHA256SUMS.txt не найден.' }
$count = 0
foreach ($line in (Get-Content -LiteralPath $manifest -Encoding UTF8)) {
    if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw "Некорректная строка SHA256: $line" }
    $expected = $matches[1].ToUpperInvariant()
    $relative = $matches[2].Replace('/', '\')
    $full = Join-Path $PSScriptRoot $relative
    if (-not (Test-Path -LiteralPath $full)) { throw "Отсутствует файл: $relative" }
    $actual = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw "SHA256 не совпал: $relative" }
    $count++
}
Write-Host "PASS: SHA256 совпал у $count файлов." -ForegroundColor Green
