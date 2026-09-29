# Install (or roll back) a verified sizhe233/oh-my-pi fork build on Windows x64.
# Works in Windows PowerShell 5.1 and PowerShell 7. Requires an authenticated `gh` CLI
# unless -ArtifactDir points at an already-downloaded artifact (folder or the ZIP from the run page).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File fork-install-windows.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File fork-install-windows.ps1 -RunId 123 -Proxy http://127.0.0.1:7890
#   powershell -NoProfile -ExecutionPolicy Bypass -File fork-install-windows.ps1 -Rollback
#
# Without -RunId it installs the newest successful Windows build of `main`.
param(
    [string]$RunId,
    [string]$Sha,
    [string]$ArtifactDir,
    [string]$InstallDir,
    [string]$Proxy,
    [switch]$Force,
    [switch]$SkipExtension,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$Repo = 'sizhe233/oh-my-pi'
$Workflow = 'fork-build-windows-manual.yml'
$RelayPort = 9224
$ShimNames = @('omp', 'omp.cmd', 'omp.ps1', 'omp.bat', 'omp.bunx')

function Invoke-Checked {
    param([string]$What, [scriptblock]$Block)
    $output = & $Block
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)" }
    return $output
}

# The launcher PowerShell/cmd resolve for `omp`, or the default binary location.
function Resolve-TargetExe {
    if ($InstallDir) { return (Join-Path $InstallDir 'omp.exe') }
    $first = Get-Command omp -All -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -in 'Application', 'ExternalScript' } | Select-Object -First 1
    if ($first) { return (Join-Path (Split-Path -Parent $first.Source) 'omp.exe') }
    return (Join-Path $env:LOCALAPPDATA 'omp\omp.exe')
}

# omp processes (other than the relay itself) connected to the relay port are live browser sessions.
function Assert-BrowserIdle {
    $relayPids = @(Get-RelayProcesses | ForEach-Object { $_.ProcessId })
    $clients = @()
    try {
        $clients = @(Get-NetTCPConnection -RemotePort $RelayPort -State Established -ErrorAction Stop | ForEach-Object { $_.OwningProcess } | Sort-Object -Unique)
    } catch {
        Write-Warning 'Get-NetTCPConnection is unavailable; cannot check for active browser sessions.'
        return
    }
    $busy = @()
    foreach ($clientPid in $clients) {
        if ($relayPids -contains $clientPid) { continue }
        $proc = Get-Process -Id $clientPid -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        if ($proc.ProcessName -match '^(chrome|msedge|brave)$') { continue }
        $busy += "$($proc.ProcessName) (PID $clientPid)"
    }
    if ($busy.Count -gt 0 -and -not $Force) {
        throw "omp sessions are using the browser relay: $($busy -join ', '). Close them or pass -Force."
    }
}

function Get-RelayProcesses {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -match 'browser-relay.*--port' }
}

function Stop-Relay {
    foreach ($relay in @(Get-RelayProcesses)) {
        Write-Host "Stopping browser relay (PID $($relay.ProcessId))"
        Stop-Process -Id $relay.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Get-Artifact {
    if ($ArtifactDir) {
        $item = Get-Item -LiteralPath $ArtifactDir
        if ($item.PSIsContainer) { return $item.FullName }
        # A ZIP downloaded from the GitHub Actions run page.
        $dest = Join-Path $env:LOCALAPPDATA "omp-fork-builds\$([IO.Path]::GetFileNameWithoutExtension($item.Name))"
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
        Expand-Archive -LiteralPath $item.FullName -DestinationPath $dest
        return $dest
    }
    if ($Proxy) { $env:HTTPS_PROXY = $Proxy; $env:HTTP_PROXY = $Proxy }
    if (-not $script:RunId) {
        $latest = (Invoke-Checked 'gh run list' { gh run list -R $Repo --workflow $Workflow --branch main --status success --limit 1 --json databaseId,headSha }) -join "`n" | ConvertFrom-Json
        if (-not $latest) { throw "No successful $Workflow run on main" }
        $script:RunId = [string]$latest[0].databaseId
        $script:Sha = $latest[0].headSha
    }
    if (-not $script:Sha) {
        $script:Sha = ((Invoke-Checked 'gh run view' { gh run view $script:RunId -R $Repo --json headSha -q .headSha }) -join '').Trim()
    }
    $dest = Join-Path $env:LOCALAPPDATA "omp-fork-builds\$($script:Sha)"
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    Write-Host "Downloading run $($script:RunId) ($($script:Sha)) to $dest"
    Invoke-Checked 'gh run download' { gh run download $script:RunId -R $Repo -n "omp-fork-windows-x64-$($script:Sha)" -D $dest } | Out-Null
    return $dest
}

function Find-ArtifactFile([string]$Root, [string]$Name) {
    $found = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter $Name)
    if ($found.Count -ne 1) { throw "Expected exactly one $Name under $Root, found $($found.Count)" }
    return $found[0].FullName
}

# Same checks as the CI smoke job: provenance, smoke result, and every listed SHA-256.
function Assert-Artifact([string]$Root) {
    $provenance = Get-Content -Raw -LiteralPath (Find-ArtifactFile $Root 'build.json') | ConvertFrom-Json
    if ($provenance.target -ne 'win32-x64-baseline') { throw "Unexpected build target: $($provenance.target)" }
    if ($provenance.result -ne 'passed') { throw "Build did not pass the Windows smoke job: $($provenance.result)" }
    if ($script:Sha -and $provenance.sourceSha -ne $script:Sha) { throw "Artifact is for $($provenance.sourceSha), expected $($script:Sha)" }
    $script:Sha = $provenance.sourceSha
    $lines = @(Get-Content -LiteralPath (Find-ArtifactFile $Root 'SHA256SUMS.txt') | Where-Object { $_.Trim() })
    if ($lines.Count -lt 1) { throw 'SHA256SUMS.txt is empty' }
    foreach ($line in $lines) {
        if ($line -cnotmatch '^([0-9a-f]{64})  (\S+)$') { throw "Invalid checksum line: $line" }
        $expected = $Matches[1]
        $name = $Matches[2]
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Find-ArtifactFile $Root $name)).Hash.ToLowerInvariant()
        if ($actual -cne $expected) { throw "SHA-256 mismatch: $name" }
        Write-Host "  verified $name"
    }
}

# npm/bun script launchers outrank omp.exe in PowerShell/Git Bash; move them aside (restorable).
function Hide-Shims([string]$Dir) {
    foreach ($name in $ShimNames) {
        $path = Join-Path $Dir $name
        if (Test-Path -LiteralPath $path) {
            Move-Item -LiteralPath $path -Destination "$path.fork-retired" -Force
            Write-Host "  retired launcher $name"
        }
    }
}

function Restore-Shims([string]$Dir) {
    foreach ($name in $ShimNames) {
        $path = Join-Path $Dir $name
        if (Test-Path -LiteralPath "$path.fork-retired") {
            Move-Item -LiteralPath "$path.fork-retired" -Destination $path -Force
            Write-Host "  restored launcher $name"
        }
    }
}

function Add-UserPath([string]$Dir) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if (($userPath -split ';') -notcontains $Dir) {
        [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ";$Dir").TrimStart(';'), 'User')
        Write-Host "Added $Dir to the user PATH (open a new terminal)"
    }
    if (($env:Path -split ';') -notcontains $Dir) { $env:Path = "$Dir;$env:Path" }
}

function Invoke-Smoke([string]$Exe) {
    Push-Location ([IO.Path]::GetTempPath())
    try {
        $version = (Invoke-Checked 'omp --version' { & $Exe --version }) -join ' '
        Invoke-Checked 'omp --smoke-test' { & $Exe --smoke-test } | Out-Null
    } finally {
        Pop-Location
    }
    Write-Host "  $version, smoke-test ok"
    $resolved = Get-Command omp -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $resolved -or $resolved.Source -ne $Exe) {
        $actual = if ($resolved) { $resolved.Source } else { '<nothing>' }
        Write-Warning "'omp' currently resolves to $actual, not $Exe. Remove or reorder the other PATH entry."
    }
}

function Install-Extension([string]$Exe) {
    if ($SkipExtension) { return }
    Invoke-Checked 'omp browser-relay install' { & $Exe browser-relay install } | Out-Null
    Write-Host 'Extension files updated. Reload "OMP Browser Relay" in chrome://extensions (click its reload arrow).'
}

# Clear a previous backup slot. A backup can still be a running image (renamable, not deletable).
function Move-Aside([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        Remove-Item -LiteralPath $Path -Force
    } catch {
        Move-Item -LiteralPath $Path -Destination "$Path.$(Get-Date -Format yyyyMMddHHmmss)" -Force
    }
}

$target = Resolve-TargetExe
$targetDir = Split-Path -Parent $target
$backup = "$target.fork-prev"
Assert-BrowserIdle

if ($Rollback) {
    if (-not (Test-Path -LiteralPath $backup)) { throw "No backup at $backup" }
    Stop-Relay
    if (Test-Path -LiteralPath $target) { Move-Aside "$target.fork-bad"; Move-Item -LiteralPath $target -Destination "$target.fork-bad" -Force }
    Move-Item -LiteralPath $backup -Destination $target -Force
    Restore-Shims $targetDir
    Write-Host "Rolled back $target"
    Invoke-Smoke $target
    Install-Extension $target
    Write-Host 'Restart running omp sessions to pick up the rolled-back version.'
    return
}

$root = Get-Artifact
Write-Host "Verifying $root"
Assert-Artifact $root
$exe = Find-ArtifactFile $root 'omp-windows-x64.exe'

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
Stop-Relay
$staged = "$target.new"
Copy-Item -LiteralPath $exe -Destination $staged -Force
# Renaming a running .exe is allowed on Windows; deleting it is not.
if (Test-Path -LiteralPath $target) {
    Move-Aside $backup
    Move-Item -LiteralPath $target -Destination $backup -Force
}
Move-Item -LiteralPath $staged -Destination $target -Force
Hide-Shims $targetDir
Add-UserPath $targetDir
Write-Host "Installed $($script:Sha) to $target (previous: $backup)"
Invoke-Smoke $target
Install-Extension $target
Write-Host 'Restart running omp sessions to pick up the new version.'
