[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$Before,

    [Parameter(Mandatory)]
    [string]$After,

    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-RamRaccoonSnapshot {
    param([Parameter(Mandatory)][string]$Path)

    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $snapshot = Get-Content -Raw -LiteralPath $resolvedPath | ConvertFrom-Json

    if ($snapshot.SchemaVersion -ne "1.0") {
        throw "Unsupported RAM Raccoon schema in ${resolvedPath}: $($snapshot.SchemaVersion)"
    }
    if ($snapshot.Safety.ReadOnly -ne $true) {
        throw "Snapshot does not declare read-only collection: $resolvedPath"
    }
    if ($snapshot.Safety.ProcessesTerminated -ne 0) {
        throw "Snapshot reports process termination: $resolvedPath"
    }

    return $snapshot
}

function Get-BundleFloor {
    param([Parameter(Mandatory)][object]$Snapshot)

    $values = @(
        $Snapshot.AppServers |
            ForEach-Object { $_.McpMarkers.CommonBundleFloor } |
            Where-Object { $null -ne $_ }
    )
    if ($values.Count -eq 0) {
        return $null
    }
    return [int](($values | Measure-Object -Maximum).Maximum)
}

function Get-Change {
    param(
        [double]$BeforeValue,
        [double]$AfterValue
    )

    return [math]::Round($AfterValue - $BeforeValue, 2)
}

$beforeSnapshot = Read-RamRaccoonSnapshot -Path $Before
$afterSnapshot = Read-RamRaccoonSnapshot -Path $After

$processChange = Get-Change `
    -BeforeValue $beforeSnapshot.Totals.CodexProcessCount `
    -AfterValue $afterSnapshot.Totals.CodexProcessCount
$privateChange = Get-Change `
    -BeforeValue $beforeSnapshot.Totals.PrivateMemoryGiB `
    -AfterValue $afterSnapshot.Totals.PrivateMemoryGiB
$workingSetChange = Get-Change `
    -BeforeValue $beforeSnapshot.Totals.WorkingSetGiB `
    -AfterValue $afterSnapshot.Totals.WorkingSetGiB
$commitChange = Get-Change `
    -BeforeValue $beforeSnapshot.Host.CommitPercent `
    -AfterValue $afterSnapshot.Host.CommitPercent

$beforeBundleFloor = Get-BundleFloor -Snapshot $beforeSnapshot
$afterBundleFloor = Get-BundleFloor -Snapshot $afterSnapshot
$bundleChange = $null
if ($null -ne $beforeBundleFloor -and $null -ne $afterBundleFloor) {
    $bundleChange = $afterBundleFloor - $beforeBundleFloor
}

$numericChanges = @(
    $processChange,
    $privateChange,
    $workingSetChange,
    $commitChange
)
if ($null -ne $bundleChange) {
    $numericChanges += $bundleChange
}

$improvements = @($numericChanges | Where-Object { $_ -lt 0 }).Count
$regressions = @($numericChanges | Where-Object { $_ -gt 0 }).Count
$outcome = if ($improvements -gt 0 -and $regressions -eq 0) {
    "IMPROVED"
}
elseif ($improvements -eq 0 -and $regressions -eq 0) {
    "UNCHANGED"
}
elseif ($improvements -gt 0 -and $regressions -gt 0) {
    "MIXED"
}
else {
    "REGRESSED"
}

$comparison = [pscustomobject]@{
    SchemaVersion = "1.0"
    Outcome = $outcome
    Meaning = "Negative deltas mean the after snapshot is lower."
    Before = [pscustomobject]@{
        Timestamp = $beforeSnapshot.Timestamp
        Risk = $beforeSnapshot.Risk.Level
        CommitPercent = $beforeSnapshot.Host.CommitPercent
        CodexProcessCount = $beforeSnapshot.Totals.CodexProcessCount
        WorkingSetGiB = $beforeSnapshot.Totals.WorkingSetGiB
        PrivateMemoryGiB = $beforeSnapshot.Totals.PrivateMemoryGiB
        RepeatedMcpBundleFloor = $beforeBundleFloor
    }
    After = [pscustomobject]@{
        Timestamp = $afterSnapshot.Timestamp
        Risk = $afterSnapshot.Risk.Level
        CommitPercent = $afterSnapshot.Host.CommitPercent
        CodexProcessCount = $afterSnapshot.Totals.CodexProcessCount
        WorkingSetGiB = $afterSnapshot.Totals.WorkingSetGiB
        PrivateMemoryGiB = $afterSnapshot.Totals.PrivateMemoryGiB
        RepeatedMcpBundleFloor = $afterBundleFloor
    }
    Delta = [pscustomobject]@{
        CommitPercentagePoints = $commitChange
        CodexProcessCount = [int]$processChange
        WorkingSetGiB = $workingSetChange
        PrivateMemoryGiB = $privateChange
        RepeatedMcpBundleFloor = $bundleChange
    }
}

if ($Json) {
    $comparison | ConvertTo-Json -Depth 6
}
else {
    $comparison
}
