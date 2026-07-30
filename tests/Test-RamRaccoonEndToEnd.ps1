[CmdletBinding()]
param(
    [string]$SkillRoot = (Join-Path $PSScriptRoot "..\skills\ramraccoon"),
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Get-PropertyNames {
    param([object]$Value)

    if (
        $null -eq $Value -or
        $Value -is [string] -or
        $Value.GetType().IsPrimitive -or
        $Value.GetType().IsValueType
    ) {
        return
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        foreach ($item in $Value) {
            Get-PropertyNames -Value $item
        }
        return
    }

    foreach ($property in $Value.PSObject.Properties) {
        $property.Name
        Get-PropertyNames -Value $property.Value
    }
}

$resolvedSkillRoot = (Resolve-Path -LiteralPath $SkillRoot).Path
$snapshotPath = Join-Path $resolvedSkillRoot "scripts\Get-RamRaccoonSnapshot.ps1"
$comparePath = Join-Path $resolvedSkillRoot "scripts\Compare-RamRaccoonSnapshots.ps1"
$skillPath = Join-Path $resolvedSkillRoot "SKILL.md"
$evidencePath = Join-Path $PSScriptRoot "..\evidence\windows-2026-07-30-before.json"

foreach ($requiredPath in @($snapshotPath, $comparePath, $skillPath, $evidencePath)) {
    Assert-True (Test-Path -LiteralPath $requiredPath) "Required file is missing: $requiredPath"
}

$snapshotSource = Get-Content -Raw -LiteralPath $snapshotPath
foreach ($forbidden in @(
    "Stop-Process",
    "taskkill",
    ".Terminate(",
    "Win32_Process.Delete",
    "TerminateProcess",
    "Invoke-WebRequest",
    "Invoke-RestMethod",
    "Start-Process",
    "Remove-Item"
)) {
    Assert-True (-not $snapshotSource.Contains($forbidden)) `
        "Read-only snapshot contains forbidden operation: $forbidden"
}

$raw = & $snapshotPath -Json
$report = $raw | ConvertFrom-Json

Assert-True ($report.SchemaVersion -eq "1.0") "Unexpected schema version."
Assert-True ($report.Safety.ReadOnly -eq $true) "Snapshot is not marked read-only."
Assert-True ($report.Safety.ProcessesTerminated -eq 0) "Snapshot reports a termination."
Assert-True ($report.Safety.CommandLinesEmitted -eq $false) "Command lines were emitted."
Assert-True ($report.Risk.Level -in @("HEALTHY", "ELEVATED", "HIGH", "CRITICAL")) `
    "Unexpected risk level: $($report.Risk.Level)"
Assert-True ($report.Totals.TopLevelAppServers -gt 0) "No Codex app-server was discovered."
Assert-True ($report.Totals.CodexProcessCount -gt 0) "No Codex processes were counted."
Assert-True ($report.Totals.PrivateMemoryGiB -ge 0) "Private memory cannot be negative."

$propertyNames = @(Get-PropertyNames -Value $report)
Assert-True ("CommandLine" -notin $propertyNames) "A command-line property leaked into JSON."
Assert-True (-not $raw.Contains([Environment]::UserName)) `
    "The current Windows username leaked into JSON."

$targetPid = [int]$report.AppServers[0].AppServerPid
$targetBefore = Get-Process -Id $targetPid -ErrorAction Stop
$targetRaw = & $snapshotPath -AppServerPid $targetPid -Json
$targetReport = $targetRaw | ConvertFrom-Json
$targetAfter = Get-Process -Id $targetPid -ErrorAction Stop

Assert-True ($targetReport.Totals.TopLevelAppServers -eq 1) `
    "PID-scoped snapshot did not return exactly one app-server."
Assert-True ([int]$targetReport.AppServers[0].AppServerPid -eq $targetPid) `
    "PID-scoped snapshot returned the wrong app-server."
Assert-True ($targetBefore.Id -eq $targetAfter.Id) `
    "The selected app-server did not survive the read-only snapshot."

$invalidPidRejected = $false
try {
    & $snapshotPath -AppServerPid ([int]::MaxValue) -Json | Out-Null
}
catch {
    $invalidPidRejected = $_.Exception.Message -match "not a running codex.exe app-server"
}
Assert-True $invalidPidRejected "An invalid app-server PID was not rejected."

$independentOs = Get-CimInstance Win32_OperatingSystem
$independentPhysicalGiB = [math]::Round(
    ([int64]$independentOs.TotalVisibleMemorySize * 1KB) / 1GB,
    2
)
Assert-True ([math]::Abs($independentPhysicalGiB - $report.Host.PhysicalTotalGiB) -le 0.1) `
    "Physical-memory total differs from an independent Windows query."

$independentProcesses = @(Get-CimInstance Win32_Process)
$childrenByParent = @{}
foreach ($process in $independentProcesses) {
    $parentId = [int]$process.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parentId)) {
        $childrenByParent[$parentId] = [System.Collections.Generic.List[object]]::new()
    }
    $childrenByParent[$parentId].Add($process)
}

$queue = [System.Collections.Generic.Queue[int]]::new()
$seen = [System.Collections.Generic.HashSet[int]]::new()
$queue.Enqueue($targetPid)
while ($queue.Count -gt 0) {
    $currentPid = $queue.Dequeue()
    if (-not $seen.Add($currentPid)) {
        continue
    }
    if ($childrenByParent.ContainsKey($currentPid)) {
        foreach ($child in $childrenByParent[$currentPid]) {
            $queue.Enqueue([int]$child.ProcessId)
        }
    }
}

$reportedProcessCount = [int]$targetReport.Totals.CodexProcessCount
$independentProcessCount = $seen.Count
$processTolerance = [math]::Max(15, [math]::Ceiling($reportedProcessCount * 0.1))
Assert-True ([math]::Abs($independentProcessCount - $reportedProcessCount) -le $processTolerance) `
    "Codex process count differs materially from an independent tree walk."

$sameSnapshotComparison = & $comparePath `
    -Before $evidencePath `
    -After $evidencePath `
    -Json | ConvertFrom-Json
Assert-True ($sameSnapshotComparison.Outcome -eq "UNCHANGED") `
    "The before/after comparator failed its identity check."

$result = [pscustomobject]@{
    Passed = $true
    Timestamp = (Get-Date).ToString("o")
    SkillRoot = $resolvedSkillRoot
    SnapshotSchema = $report.SchemaVersion
    Risk = $report.Risk.Level
    TargetAppServerPid = $targetPid
    ReportedProcessCount = $reportedProcessCount
    IndependentProcessCount = $independentProcessCount
    ProcessCountTolerance = $processTolerance
    PrivateMemoryGiB = $targetReport.Totals.PrivateMemoryGiB
    WorkingSetGiB = $targetReport.Totals.WorkingSetGiB
    CommitPercent = $targetReport.Host.CommitPercent
    PhysicalTotalGiB = $targetReport.Host.PhysicalTotalGiB
    CodexPackageVersion = $targetReport.Host.CodexPackageVersion
    RepeatedMcpBundleFloor = @(
        $targetReport.AppServers |
            ForEach-Object { $_.McpMarkers.CommonBundleFloor } |
            Where-Object { $null -ne $_ } |
            Measure-Object -Maximum
    ).Maximum
    InvalidPidRejected = $invalidPidRejected
    AppServerSurvived = $true
    CommandLinePropertyAbsent = $true
    UsernameAbsent = $true
    ComparatorIdentityCheck = $sameSnapshotComparison.Outcome
    ProcessesTerminated = $targetReport.Safety.ProcessesTerminated
}

if ($Json) {
    $result | ConvertTo-Json -Depth 5
}
else {
    Write-Output "RAM Raccoon end-to-end: OK"
    $result
}
