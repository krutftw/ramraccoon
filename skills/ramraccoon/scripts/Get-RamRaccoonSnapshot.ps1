[CmdletBinding()]
param(
    [ValidateRange(0, 2147483647)]
    [int]$AppServerPid = 0,

    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-RiskRank {
    param(
        [double]$CommitPercent,
        [double]$PrivateGiB,
        [int]$ProcessCount
    )

    if ($CommitPercent -ge 95 -or $PrivateGiB -ge 12 -or $ProcessCount -ge 300) {
        return 3
    }
    if ($CommitPercent -ge 90 -or $PrivateGiB -ge 8 -or $ProcessCount -ge 200) {
        return 2
    }
    if ($CommitPercent -ge 80 -or $PrivateGiB -ge 4 -or $ProcessCount -ge 100) {
        return 1
    }
    return 0
}

function Convert-RiskRank {
    param([int]$Rank)

    switch ($Rank) {
        3 { return "CRITICAL" }
        2 { return "HIGH" }
        1 { return "ELEVATED" }
        default { return "HEALTHY" }
    }
}

$allProcesses = @(
    Get-CimInstance Win32_Process |
        Select-Object ProcessId, ParentProcessId, Name, CommandLine, CreationDate
)

$processById = @{}
$childrenByParent = @{}
foreach ($process in $allProcesses) {
    $processId = [int]$process.ProcessId
    $parentId = [int]$process.ParentProcessId
    $processById[$processId] = $process

    if (-not $childrenByParent.ContainsKey($parentId)) {
        $childrenByParent[$parentId] = [System.Collections.Generic.List[object]]::new()
    }
    $childrenByParent[$parentId].Add($process)
}

$allAppServers = @(
    $allProcesses | Where-Object {
        $_.Name -eq "codex.exe" -and $_.CommandLine -match "(^|\s)app-server(\s|$)"
    }
)

if ($AppServerPid -gt 0) {
    $selected = @($allAppServers | Where-Object { [int]$_.ProcessId -eq $AppServerPid })
    if ($selected.Count -eq 0) {
        throw "PID $AppServerPid is not a running codex.exe app-server."
    }
    $topLevelAppServers = $selected
}
else {
    $appServerIds = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($server in $allAppServers) {
        [void]$appServerIds.Add([int]$server.ProcessId)
    }

    $topLevelAppServers = @(
        foreach ($server in $allAppServers) {
            $ancestorId = [int]$server.ParentProcessId
            $visitedAncestors = [System.Collections.Generic.HashSet[int]]::new()
            $hasAppServerAncestor = $false

            while ($ancestorId -gt 0 -and $visitedAncestors.Add($ancestorId)) {
                if ($appServerIds.Contains($ancestorId)) {
                    $hasAppServerAncestor = $true
                    break
                }
                if (-not $processById.ContainsKey($ancestorId)) {
                    break
                }
                $ancestorId = [int]$processById[$ancestorId].ParentProcessId
            }

            if (-not $hasAppServerAncestor) {
                $server
            }
        }
    )
}

$liveProcessById = @{}
foreach ($liveProcess in @(Get-Process -ErrorAction SilentlyContinue)) {
    $liveProcessById[[int]$liveProcess.Id] = $liveProcess
}

$appServerReports = @(
    foreach ($server in $topLevelAppServers) {
        $queue = [System.Collections.Generic.Queue[int]]::new()
        $queue.Enqueue([int]$server.ProcessId)
        $seen = [System.Collections.Generic.HashSet[int]]::new()
        $tree = [System.Collections.Generic.List[object]]::new()

        while ($queue.Count -gt 0) {
            $currentId = $queue.Dequeue()
            if (-not $seen.Add($currentId)) {
                continue
            }

            if ($processById.ContainsKey($currentId)) {
                $tree.Add($processById[$currentId])
            }

            if ($childrenByParent.ContainsKey($currentId)) {
                foreach ($child in $childrenByParent[$currentId]) {
                    $queue.Enqueue([int]$child.ProcessId)
                }
            }
        }

        [int64]$workingSetBytes = 0
        [int64]$privateBytes = 0
        foreach ($treeProcess in $tree) {
            $treeProcessId = [int]$treeProcess.ProcessId
            if (-not $liveProcessById.ContainsKey($treeProcessId)) {
                continue
            }
            try {
                $workingSetBytes += [int64]$liveProcessById[$treeProcessId].WorkingSet64
                $privateBytes += [int64]$liveProcessById[$treeProcessId].PrivateMemorySize64
            }
            catch {
                # A short-lived process may exit between snapshots.
            }
        }

        $nodeReplCount = @($tree | Where-Object { $_.Name -eq "node_repl.exe" }).Count
        $chromeNodeCount = @($tree | Where-Object {
            $_.Name -eq "node.exe" -and $_.CommandLine -match "chrome-devtools-mcp"
        }).Count
        $playwrightCount = @($tree | Where-Object {
            $_.Name -eq "node.exe" -and $_.CommandLine -match "@playwright/mcp|playwright-mcp"
        }).Count
        $context7Count = @($tree | Where-Object {
            $_.Name -eq "node.exe" -and $_.CommandLine -match "@upstash/context7-mcp"
        }).Count
        $sentryCount = @($tree | Where-Object {
            $_.Name -eq "node.exe" -and $_.CommandLine -match "@sentry/mcp-server"
        }).Count

        $bundleMarkers = [System.Collections.Generic.List[int]]::new()
        foreach ($marker in @(
            $nodeReplCount,
            $playwrightCount,
            $context7Count,
            $sentryCount,
            $(if ($chromeNodeCount -ge 3) { [math]::Floor($chromeNodeCount / 3) } else { $chromeNodeCount })
        )) {
            if ($marker -gt 0) {
                $bundleMarkers.Add([int]$marker)
            }
        }

        $commonBundleFloor = $null
        if ($bundleMarkers.Count -ge 2) {
            $commonBundleFloor = [int](($bundleMarkers | Measure-Object -Minimum).Minimum)
        }

        $parentName = $null
        $serverParentId = [int]$server.ParentProcessId
        if ($processById.ContainsKey($serverParentId)) {
            $parentName = $processById[$serverParentId].Name
        }

        $topNames = @(
            $tree |
                Group-Object Name |
                Sort-Object Count -Descending |
                Select-Object -First 8 @{Name = "Name"; Expression = { $_.Name } },
                    @{Name = "Count"; Expression = { $_.Count }}
        )

        [pscustomobject]@{
            AppServerPid = [int]$server.ProcessId
            ParentName = $parentName
            StartedAt = $server.CreationDate
            ProcessCount = $tree.Count
            WorkingSetGiB = [math]::Round($workingSetBytes / 1GB, 2)
            PrivateMemoryGiB = [math]::Round($privateBytes / 1GB, 2)
            ProcessFamilies = $topNames
            McpMarkers = [pscustomobject]@{
                NodeRepl = $nodeReplCount
                ChromeDevToolsNodeProcesses = $chromeNodeCount
                Playwright = $playwrightCount
                Context7 = $context7Count
                Sentry = $sentryCount
                CommonBundleFloor = $commonBundleFloor
            }
        }
    }
)

$operatingSystem = Get-CimInstance Win32_OperatingSystem
$physicalTotalBytes = [int64]$operatingSystem.TotalVisibleMemorySize * 1KB
$physicalFreeBytes = [int64]$operatingSystem.FreePhysicalMemory * 1KB
$physicalUsedBytes = $physicalTotalBytes - $physicalFreeBytes

[int64]$committedBytes = 0
[int64]$commitLimitBytes = 0
try {
    $memoryPerformance = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
    $committedBytes = [int64]$memoryPerformance.CommittedBytes
    $commitLimitBytes = [int64]$memoryPerformance.CommitLimit
}
catch {
    # Some stripped-down Windows environments do not expose this class.
}

$commitPercent = 0.0
if ($commitLimitBytes -gt 0) {
    $commitPercent = [math]::Round(($committedBytes / $commitLimitBytes) * 100, 1)
}

$appPackageVersion = $null
try {
    $appPackage = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $appPackage) {
        $appPackageVersion = $appPackage.Version.ToString()
    }
}
catch {
    # AppX APIs may be unavailable in Server Core or CI.
}

$totalCodexProcesses = [int](($appServerReports | Measure-Object ProcessCount -Sum).Sum)
$totalPrivateGiB = [math]::Round(
    [double](($appServerReports | Measure-Object PrivateMemoryGiB -Sum).Sum),
    2
)
$totalWorkingSetGiB = [math]::Round(
    [double](($appServerReports | Measure-Object WorkingSetGiB -Sum).Sum),
    2
)

$riskRank = Get-RiskRank -CommitPercent $commitPercent `
    -PrivateGiB $totalPrivateGiB `
    -ProcessCount $totalCodexProcesses
$riskLevel = Convert-RiskRank -Rank $riskRank

$riskReasons = [System.Collections.Generic.List[string]]::new()
if ($commitPercent -ge 80) {
    $riskReasons.Add("Windows commit usage is $commitPercent percent.")
}
if ($totalPrivateGiB -ge 4) {
    $riskReasons.Add("Codex app-server trees reserve $totalPrivateGiB GiB of private memory.")
}
if ($totalCodexProcesses -ge 100) {
    $riskReasons.Add("Codex app-server trees contain $totalCodexProcesses processes.")
}
if ($appServerReports.Count -eq 0) {
    $riskReasons.Add("No top-level Codex app-server was found.")
}

$recommendations = [System.Collections.Generic.List[string]]::new()
switch ($riskLevel) {
    "CRITICAL" {
        $recommendations.Add("Do not spawn more agents. Checkpoint active work and restart Codex when safe.")
    }
    "HIGH" {
        $recommendations.Add("Stop unnecessary delegation and prepare a restart checkpoint.")
    }
    "ELEVATED" {
        $recommendations.Add("Audit child agents and monitor whether process/private memory returns to baseline.")
    }
    default {
        $recommendations.Add("No pressure threshold was crossed; keep housekeeping read-only.")
    }
}

$largestBundleFloor = @(
    $appServerReports |
        ForEach-Object { $_.McpMarkers.CommonBundleFloor } |
        Where-Object { $null -ne $_ }
)
if ($largestBundleFloor.Count -gt 0) {
    $bundleFloor = [int](($largestBundleFloor | Measure-Object -Maximum).Maximum)
    if ($bundleFloor -ge 2) {
        $recommendations.Add(
            "At least $bundleFloor repeated MCP bundle markers are present; interruption alone may not unload them."
        )
    }
}

$report = [pscustomobject]@{
    SchemaVersion = "1.0"
    Timestamp = (Get-Date).ToString("o")
    Host = [pscustomobject]@{
        OS = $operatingSystem.Caption
        OSVersion = $operatingSystem.Version
        PhysicalTotalGiB = [math]::Round($physicalTotalBytes / 1GB, 2)
        PhysicalUsedGiB = [math]::Round($physicalUsedBytes / 1GB, 2)
        CommittedGiB = [math]::Round($committedBytes / 1GB, 2)
        CommitLimitGiB = [math]::Round($commitLimitBytes / 1GB, 2)
        CommitPercent = $commitPercent
        CodexPackageVersion = $appPackageVersion
    }
    Risk = [pscustomobject]@{
        Level = $riskLevel
        Reasons = @($riskReasons)
    }
    Totals = [pscustomobject]@{
        TopLevelAppServers = $appServerReports.Count
        CodexProcessCount = $totalCodexProcesses
        WorkingSetGiB = $totalWorkingSetGiB
        PrivateMemoryGiB = $totalPrivateGiB
    }
    AppServers = $appServerReports
    Recommendations = @($recommendations)
    Safety = [pscustomobject]@{
        ReadOnly = $true
        ProcessesTerminated = 0
        CommandLinesEmitted = $false
    }
}

if ($Json) {
    $report | ConvertTo-Json -Depth 8
}
else {
    $report
}
