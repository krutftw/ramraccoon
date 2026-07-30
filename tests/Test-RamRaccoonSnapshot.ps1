$ErrorActionPreference = "Stop"

$scriptPath = Join-Path $PSScriptRoot `
    "..\skills\ramraccoon\scripts\Get-RamRaccoonSnapshot.ps1"
$json = & $scriptPath -Json
$report = $json | ConvertFrom-Json

if ($report.SchemaVersion -ne "1.0") {
    throw "Unexpected schema version: $($report.SchemaVersion)"
}
if ($report.Safety.ReadOnly -ne $true) {
    throw "Snapshot must declare read-only behavior."
}
if ($report.Safety.ProcessesTerminated -ne 0) {
    throw "Snapshot terminated a process."
}
if ($report.Safety.CommandLinesEmitted -ne $false) {
    throw "Snapshot exposed command lines."
}
if ($report.Risk.Level -notin @("HEALTHY", "ELEVATED", "HIGH", "CRITICAL")) {
    throw "Unexpected risk level: $($report.Risk.Level)"
}
if ($report.Totals.CodexProcessCount -lt 0) {
    throw "Process count cannot be negative."
}

Write-Output "RAM Raccoon Windows snapshot contract: OK"
