param(
    [ValidateSet('Portable','Installer','Dev')]
    [string]$Mode = 'Portable'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$project = $PSScriptRoot
Set-Location -LiteralPath $project

function Test-Command($Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Не найдена команда '$Name'. Установите необходимый инструмент и запустите этот файл снова."
    }
}

function Run($Executable, [string[]]$Arguments) {
    Write-Host "`n>>> $Executable $($Arguments -join ' ')" -ForegroundColor Magenta
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Команда '$Executable' завершилась с кодом $LASTEXITCODE" }
}

try {
    Write-Host 'AngelTime v0.4.28 | Windows 11 | Tauri' -ForegroundColor Cyan
    Test-Command 'node.exe'
    Test-Command 'npm.cmd'
    Test-Command 'cargo.exe'

    $npmBin = Join-Path $project 'node_modules\.bin\tauri.cmd'
    if (-not (Test-Path -LiteralPath $npmBin)) {
        Write-Host 'Первый запуск: установка Tauri CLI (используем локальный кэш npm)' -ForegroundColor Yellow
        Run 'npm.cmd' @('install','--prefer-offline','--no-audit','--no-fund')
    } else {
        Write-Host 'Tauri CLI уже установлен. Повторная загрузка npm-пакетов не требуется.' -ForegroundColor DarkGreen
    }

    Run 'npm.cmd' @('run','check')
    Run 'cargo.exe' @('test','--manifest-path','src-tauri\Cargo.toml')

    if ($Mode -eq 'Dev') {
        Run 'npm.cmd' @('run','dev')
    } elseif ($Mode -eq 'Installer') {
        Run 'npm.cmd' @('run','build')
    } else {
        Run $npmBin @('build','--no-bundle')
    }

    if ($Mode -ne 'Dev') {
        $exe = Join-Path $project 'src-tauri\target\release\angeltime.exe'
        if (-not (Test-Path -LiteralPath $exe)) { throw 'Сборка завершилась, но angeltime.exe не найден.' }
        $dist = Join-Path $project 'dist'
        New-Item -ItemType Directory -Force -Path $dist | Out-Null
        $portable = Join-Path $dist 'AngelTime_v0.4.28_Portable.exe'
        Copy-Item -LiteralPath $exe -Destination $portable -Force
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try {
            $stream = [System.IO.File]::OpenRead($portable)
            try { $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
            finally { $stream.Dispose() }
        }
        finally { $sha256.Dispose() }
        Set-Content -Path (Join-Path $dist 'AngelTime_v0.4.28_Portable.sha256') -Value "$hash  AngelTime_v0.4.28_Portable.exe" -Encoding Ascii
        Write-Host "`nPASS: $portable" -ForegroundColor Green
        Write-Host "SHA-256: $hash" -ForegroundColor Green
        if ($Mode -eq 'Installer') {
            Write-Host 'Установщик: src-tauri\target\release\bundle\nsis\' -ForegroundColor Green
        }
    }
} catch {
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
