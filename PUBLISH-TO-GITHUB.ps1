param(
    [ValidateSet('private','public')]
    [string]$Visibility = 'private',
    [switch]$ConfirmAudioRights
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repo = 'TraurigerEngel/AngelTime'
$tag = 'v0.4.22'
$project = $PSScriptRoot
$sourceZip = Join-Path (Split-Path $project -Parent) 'AngelTime_v0.4.22_Source.zip'

function Run-Checked([string]$Name, [string[]]$Arguments) {
    & $Name @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Name $($Arguments -join ' ')" }
}
function Get-Sha256([string]$Path) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '') }
        finally { $stream.Dispose() }
    }
    finally { $algorithm.Dispose() }
}
function Require-Cmd([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { throw "Missing $Name. Install it and rerun." }
}

try {
    Require-Cmd 'git.exe'
    Require-Cmd 'gh.exe'
    Require-Cmd 'node.exe'
    Require-Cmd 'cargo.exe'
    Require-Cmd 'npm.cmd'

    if ($Visibility -eq 'public' -and -not $ConfirmAudioRights) {
        throw 'Public release blocked: verify the redistribution rights for bundled default_alarm.mp3. If rights are confirmed, rerun with -Visibility public -ConfirmAudioRights.'
    }

    Set-Location -LiteralPath $project
    $meta = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($meta.version -ne '0.4.22') { throw "Wrong project version $($meta.version)." }

    $manifest = Join-Path $project 'SHA256SUMS.txt'
    $checked = 0
    foreach ($line in (Get-Content -LiteralPath $manifest -Encoding UTF8)) {
        if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw 'Corrupt SHA256SUMS.txt.' }
        $expected = $Matches[1].ToUpperInvariant()
        $path = Join-Path $project $Matches[2].Replace('/', '\')
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing source file: $path" }
        if ((Get-Sha256 $path) -ne $expected) { throw "Source integrity error: $path" }
        $checked++
    }
    if ($checked -lt 28) { throw "Incomplete source manifest ($checked entries)." }
    if (-not (Test-Path -LiteralPath $sourceZip)) { throw 'Source ZIP missing beside project folder.' }

    & gh.exe auth status --hostname github.com
    if ($LASTEXITCODE -ne 0) { throw 'Sign in: gh auth login -h github.com -w' }
    $login = (& gh.exe api user --jq '.login' | Select-Object -First 1).Trim()
    if ($LASTEXITCODE -ne 0 -or $login -ine 'TraurigerEngel') { throw "GitHub account must be TraurigerEngel; found $login" }

    # Do not push over an existing GitHub repository or a pre-existing local Git history.
    $repoNames = @(& gh.exe repo list $login --limit 1000 --json name --jq '.[].name')
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect GitHub repositories; nothing will be published.' }
    if ($repoNames -contains 'AngelTime') { throw "Repository already exists: $repo. No remote files changed." }
    if (Test-Path -LiteralPath (Join-Path $project '.git')) { throw 'Local .git exists. Stopping to avoid overwriting history.' }

    Write-Host "`n[1/5] Building and testing AngelTime $tag ..." -ForegroundColor Cyan
    Run-Checked 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-File', (Join-Path $project 'BUILD-WINDOWS.ps1'), '-Mode','Portable')
    $exe = Join-Path $project 'dist\AngelTime_v0.4.22_Portable.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Missing built Portable EXE.' }
    $hash = Get-Sha256 $exe
    $shaFile = Join-Path $project 'dist\AngelTime_v0.4.22_Portable.exe.sha256'
    [System.IO.File]::WriteAllText($shaFile, "$hash  AngelTime_v0.4.22_Portable.exe`r`n", [System.Text.Encoding]::ASCII)

    Write-Host '[2/5] Initializing new repository...' -ForegroundColor Cyan
    Run-Checked 'git.exe' @('init','-b','main')
    Run-Checked 'git.exe' @('add','--all')
    Run-Checked 'git.exe' @('-c',"user.name=$login",'-c',"user.email=${login}@users.noreply.github.com",'commit','-m',"Release: AngelTime $tag")

    Write-Host "[3/5] Creating GitHub repository ($Visibility)..." -ForegroundColor Cyan
    if ($Visibility -eq 'private') {
        Run-Checked 'gh.exe' @('repo','create',$repo,'--private','--source','.','--remote','origin','--push')
    } else {
        Run-Checked 'gh.exe' @('repo','create',$repo,'--public','--source','.','--remote','origin','--push')
    }

    Write-Host '[4/5] Pushing the version tag...' -ForegroundColor Cyan
    Run-Checked 'git.exe' @('tag','-a',$tag,'-m',"AngelTime $tag")
    Run-Checked 'git.exe' @('push','origin',$tag)

    Write-Host '[5/5] Publishing GitHub Release...' -ForegroundColor Cyan
    Run-Checked 'gh.exe' @('release','create',$tag,$exe,$shaFile,$sourceZip,
        '--repo',$repo,'--title',"AngelTime $tag - No Blue Selection",'--notes-file',(Join-Path $project 'RELEASE_NOTES.md'))
    Run-Checked 'gh.exe' @('release','view',$tag,'--repo',$repo,'--json','url,assets','--jq','{url:.url,assets:[.assets[].name]}')
    Write-Host "`nPASS: https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
    Write-Host "Portable SHA-256: $hash" -ForegroundColor Green
}
catch {
    Write-Host "`nERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'No forced overwrite was attempted. If a GitHub repository was already created, inspect it before retrying.' -ForegroundColor Yellow
    exit 1
}
