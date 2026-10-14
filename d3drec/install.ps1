<#
.SYNOPSIS
  Installs the d3drec D3D8 call recorder into a DEDICATED test copy of The Hobbit (never Clean or Reference).

.DESCRIPTION
  1. Optionally creates the test copy from a source folder (-CreateFrom): big files (>= 4 MB: .000/.DFS archives,
     Bink videos) become NTFS hard links, small files are copied (so anything the game rewrites in its folder cannot
     reach the source folder). Experiment files are skipped: dinput8.dll*, unicorn.dll, hooks_disabled.txt,
     devmode.txt, shadow*, hobbit_decomp*.log, autotest*, recorder*, *.tsv, *.dmp, d3drec*, Play Hobbit.bat.
  2. Renames the folder's d3d8.dll (crosire d3d8to9 wrapper) to d3d8_chain.dll, copies build\d3d8.dll (the recorder)
     in its place and writes d3drec.ini (chain = d3d8_chain.dll, or "system" if the folder had no d3d8.dll).
  3. Writes "Record Hobbit.bat" (start Meridian.exe from its folder) and d3drec_installed.txt (what was changed).
  Undo with uninstall.ps1. Nothing is launched.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File Hobbit-Decomp\d3drec\install.ps1 `
     -Target "C:\Users\ivanm\Downloads\IRA\The.Hobbit.-.Clean\The Hobbit - D3DRec" `
     -CreateFrom "C:\Users\ivanm\Downloads\IRA\The.Hobbit.-.Clean\The Hobbit - Clean"
#>
param(
    [Parameter(Mandatory = $true)][string]$Target,
    [string]$CreateFrom = "",
    [ValidateSet("d3d8to9", "system")][string]$Chain = "d3d8to9",
    [int]$ShotInterval = 60,
    [int]$ShotScale = 2,
    [switch]$Force
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dll = Join-Path $here "build\d3d8.dll"
if (-not (Test-Path $dll)) { throw "build\d3d8.dll not found: run d3drec\build.bat first" }

function Assert-NotProtected([string]$p) {
    $leaf = Split-Path -Leaf $p.TrimEnd('\')
    if ($leaf -ieq "The Hobbit - Clean" -or $leaf -ieq "The Hobbit - Reference") {
        throw "Refusing to modify '$p': Clean and Reference must stay original. Use a dedicated copy (e.g. 'The Hobbit - D3DRec')."
    }
}
$Target = [IO.Path]::GetFullPath($Target)
Assert-NotProtected $Target

$skip = @('^dinput8\.dll', '^unicorn\.dll$', '^hooks_disabled\.txt$', '^devmode\.txt$', '^shadow', '^hobbit_decomp.*\.log$',
          '^autotest', '^recorder', '\.tsv$', '\.dmp$', '^d3drec', '^Play Hobbit\.bat$', '^Record Hobbit\.bat$')
function Test-Skip([string]$rel) {
    foreach ($part in $rel.Split('\')) { foreach ($re in $skip) { if ($part -match $re) { return $true } } }
    return $false
}

if ($CreateFrom) {
    $src = [IO.Path]::GetFullPath($CreateFrom)
    if ($src.TrimEnd('\') -ieq $Target.TrimEnd('\')) { throw "-CreateFrom and -Target are the same folder" }
    if (-not (Test-Path (Join-Path $src "Meridian.exe"))) { throw "no Meridian.exe in $src" }
    if ((Test-Path $Target) -and (Get-ChildItem $Target -Force | Select-Object -First 1)) { throw "$Target exists and is not empty (drop -CreateFrom to install into it)" }
    New-Item -ItemType Directory -Force $Target | Out-Null
    $links = 0; $copies = 0; $skipped = 0
    Get-ChildItem $src -Recurse -File -Force | ForEach-Object {
        $rel = $_.FullName.Substring($src.TrimEnd('\').Length + 1)
        if (Test-Skip $rel) { $skipped++; return }
        $dst = Join-Path $Target $rel
        $dd = Split-Path -Parent $dst
        if (-not (Test-Path $dd)) { New-Item -ItemType Directory -Force $dd | Out-Null }
        if ($_.Length -ge 4MB) {
            cmd /c mklink /H "`"$dst`"" "`"$($_.FullName)`"" | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "mklink /H failed for $rel (same NTFS volume needed)" }
            $links++
        } else { Copy-Item -LiteralPath $_.FullName -Destination $dst; $copies++ }
    }
    Write-Host "created $Target : $links hard links, $copies copies, $skipped experiment files skipped"
}
if (-not (Test-Path (Join-Path $Target "Meridian.exe"))) { throw "no Meridian.exe in $Target" }

$d3d8 = Join-Path $Target "d3d8.dll"
$chainDll = Join-Path $Target "d3d8_chain.dll"
function Test-Recorder([string]$p) { (Test-Path $p) -and ([IO.File]::ReadAllText($p, [Text.Encoding]::ASCII) -match 'D3DRec_Finish') }
$state = @()
if (Test-Recorder $d3d8) {
    if (-not $Force) { throw "the recorder is already installed in $Target (use -Force to update the DLL)" }
    Remove-Item -LiteralPath $d3d8
    $state += "replaced an older recorder DLL"
} elseif (Test-Path $d3d8) {
    if (Test-Path $chainDll) { throw "both d3d8.dll and d3d8_chain.dll exist and d3d8.dll is not the recorder: fix by hand" }
    Rename-Item -LiteralPath $d3d8 -NewName "d3d8_chain.dll"     # renames this folder's link only
    $state += "renamed d3d8.dll -> d3d8_chain.dll"
}
Copy-Item -LiteralPath $dll -Destination $d3d8
$state += "copied recorder $dll -> d3d8.dll"

$chainValue = if ($Chain -eq "system" -or -not (Test-Path $chainDll)) { "system" } else { "d3d8_chain.dll" }
$ini = Join-Path $Target "d3drec.ini"
if (-not (Test-Path $ini) -or $Force) {
@"
; d3drec: D3D8 call recorder (Hobbit-Decomp/docs/D3DREC.md)
[d3drec]
; 0 = pass-through (no log, no overhead)
enabled=1
; d3d8_chain.dll = the folder's original d3d8to9 wrapper (renamed); system = System32\d3d8.dll; or a path
chain=$chainValue
; relative to this folder or absolute
output_dir=d3drec_logs
; back-buffer screenshot every N frames (0 = none), downscaled 1/shot_scale
; shot_method: auto (lockable back buffer, else render-target copy, else sysmem copy) | lockbb | rtcopy | copyrects | off
shot_interval=$ShotInterval
shot_scale=$ShotScale
shot_method=auto
; writer: uncompressed chunk size, backlog before the game waits, hard stop of the file size
chunk_kb=512
queue_mb=256
max_mb=8192
; VB/IB unlocks as changed spans when cheaper (1), LZ4 chunks (1)
diff=1
compress=1
; stop recording after N frames (0 = until exit)
stop_after_frames=0
; flush the log on first-chance fatal exceptions (vectored handler; never handles them)
veh_flush=1
"@ | Set-Content -LiteralPath $ini -Encoding ASCII
    $state += "wrote d3drec.ini (chain=$chainValue)"
}
@"
@echo off
rem Starts The Hobbit from this folder with the D3D8 recorder (logs in d3drec_logs\)
cd /d "%~dp0"
start "" "%~dp0Meridian.exe"
"@ | Set-Content -LiteralPath (Join-Path $Target "Record Hobbit.bat") -Encoding ASCII
$state += "wrote Record Hobbit.bat"
$drive = (Get-Item $Target).PSDrive
if ($drive -and $drive.Free -lt 5GB) { Write-Warning ("only {0:N1} GB free on {1}: a 20-minute log is ~1 GB" -f ($drive.Free / 1GB), $drive.Name) }
"installed $(Get-Date -Format s)`r`n" + ($state -join "`r`n") | Set-Content -LiteralPath (Join-Path $Target "d3drec_installed.txt") -Encoding ASCII
$state | ForEach-Object { Write-Host "  $_" }
Write-Host "OK. Start with '$Target\Record Hobbit.bat'; logs go to $Target\d3drec_logs\"
