<#
.SYNOPSIS
  Removes the d3drec recorder from a test copy: deletes the recorder d3d8.dll, renames d3d8_chain.dll back to
  d3d8.dll, removes d3drec.ini / Record Hobbit.bat / d3drec_installed.txt. Logs (d3drec_logs\) are kept unless
  -RemoveLogs. Refuses Clean and Reference. Nothing is launched.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File Hobbit-Decomp\d3drec\uninstall.ps1 -Target "...\The Hobbit - D3DRec"
#>
param([Parameter(Mandatory = $true)][string]$Target, [switch]$RemoveLogs)
$ErrorActionPreference = "Stop"
$Target = [IO.Path]::GetFullPath($Target)
$leaf = Split-Path -Leaf $Target.TrimEnd('\')
if ($leaf -ieq "The Hobbit - Clean" -or $leaf -ieq "The Hobbit - Reference") { throw "Refusing to touch '$Target'" }
$d3d8 = Join-Path $Target "d3d8.dll"
$chainDll = Join-Path $Target "d3d8_chain.dll"
if ((Test-Path $d3d8) -and -not ([IO.File]::ReadAllText($d3d8, [Text.Encoding]::ASCII) -match 'D3DRec_Finish')) {
    throw "$d3d8 is not the recorder: nothing removed"
}
if (Test-Path $d3d8) { Remove-Item -LiteralPath $d3d8; Write-Host "  removed recorder d3d8.dll" }
if (Test-Path $chainDll) { Rename-Item -LiteralPath $chainDll -NewName "d3d8.dll"; Write-Host "  d3d8_chain.dll -> d3d8.dll" }
foreach ($f in @("d3drec.ini", "Record Hobbit.bat", "d3drec_installed.txt")) {
    $p = Join-Path $Target $f
    if (Test-Path $p) { Remove-Item -LiteralPath $p; Write-Host "  removed $f" }
}
$logs = Join-Path $Target "d3drec_logs"
if ($RemoveLogs -and (Test-Path $logs)) { Remove-Item -LiteralPath $logs -Recurse; Write-Host "  removed d3drec_logs\" }
elseif (Test-Path $logs) { Write-Host "  kept $logs" }
Write-Host "OK"
