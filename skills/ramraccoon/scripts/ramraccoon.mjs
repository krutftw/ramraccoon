#!/usr/bin/env node

import {
  execFileSync,
  spawn,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const GIB = 1024 ** 3;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TEST_MODE =
  process.env.RAMRACCOON_TEST_MODE === "1" ||
  process.argv.includes("--internal-test-mode");
let cachedPowerShell = null;

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function gib(bytes) {
  return round(Number(bytes || 0) / GIB);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function powershellExecutable() {
  if (cachedPowerShell) return cachedPowerShell;
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    try {
      run(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
      cachedPowerShell = candidate;
      return cachedPowerShell;
    } catch {
      // Try the Windows PowerShell fallback.
    }
  }
  throw new Error("PowerShell is required for process inspection on Windows.");
}

function windowsProcesses() {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$rows=Get-CimInstance Win32_Process | ForEach-Object {",
    "  $started=$null",
    "  if ($null -ne $_.CreationDate) { $started=$_.CreationDate.ToUniversalTime().ToString('o') }",
    "  [pscustomobject]@{",
    "    pid=[int]$_.ProcessId",
    "    ppid=[int]$_.ParentProcessId",
    "    name=[string]$_.Name",
    "    args=[string]$_.CommandLine",
    "    startedAt=$started",
    "    rssBytes=[int64]$_.WorkingSetSize",
    "    privateBytes=[int64]$_.PrivatePageCount",
    "  }",
    "}",
    "@($rows) | ConvertTo-Json -Compress -Depth 3",
  ].join("\n");

  const parsed = JSON.parse(
    run(powershellExecutable(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ]),
  );
  return Array.isArray(parsed) ? parsed : [parsed];
}

function unixProcesses() {
  const output = run("ps", [
    "-axo",
    "pid=,ppid=,rss=,lstart=,comm=,args=",
  ]);
  const rows = [];
  const pattern = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s*(.*)$/;

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(pattern);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      privateBytes: null,
      startedAt: new Date(match[4]).toISOString(),
      name: path.basename(match[5]),
      args: match[6],
    });
  }
  return rows;
}

function processTable() {
  return process.platform === "win32" ? windowsProcesses() : unixProcesses();
}

function normalizedCommand(row) {
  return `${row.name || ""} ${row.args || ""}`.toLowerCase();
}

function isAppServer(row) {
  if (!row) return false;
  const name = path.basename(row.name || "").toLowerCase();
  const command = normalizedCommand(row);
  const codexExecutable = name === "codex" || name === "codex.exe";
  const appServerArgument = /(^|[\s"'=])app-server(?=$|[\s"'])/.test(command);
  if (codexExecutable && appServerArgument) return true;
  return TEST_MODE && command.includes("ramraccoon-test-app-server");
}

function indexProcesses(rows) {
  const byPid = new Map();
  const children = new Map();
  for (const row of rows) {
    byPid.set(Number(row.pid), row);
    const parent = Number(row.ppid);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }
  return { byPid, children };
}

function topLevelAppServers(rows) {
  const { byPid } = indexProcesses(rows);
  const servers = rows.filter(isAppServer);
  const serverIds = new Set(servers.map((row) => Number(row.pid)));

  return servers.filter((server) => {
    let parent = Number(server.ppid);
    const visited = new Set();
    while (parent > 0 && !visited.has(parent)) {
      visited.add(parent);
      if (serverIds.has(parent)) return false;
      const row = byPid.get(parent);
      if (!row) break;
      parent = Number(row.ppid);
    }
    return true;
  });
}

function descendants(rows, rootPid) {
  const { byPid, children } = indexProcesses(rows);
  const queue = [Number(rootPid)];
  const visited = new Set();
  const result = [];

  while (queue.length) {
    const pid = queue.shift();
    if (visited.has(pid)) continue;
    visited.add(pid);
    const row = byPid.get(pid);
    if (row) result.push(row);
    for (const child of children.get(pid) || []) {
      queue.push(Number(child.pid));
    }
  }
  return result;
}

function processDepths(rows, rootPid) {
  const { children } = indexProcesses(rows);
  const result = [];
  const queue = [{ pid: Number(rootPid), depth: 0 }];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current.pid)) continue;
    visited.add(current.pid);
    result.push(current);
    for (const child of children.get(current.pid) || []) {
      queue.push({ pid: Number(child.pid), depth: current.depth + 1 });
    }
  }
  return result;
}

function markerCounts(tree) {
  const count = (predicate) => tree.filter(predicate).length;
  const nodeRepl = count((row) => /(^|[/\\])node_repl(?:\.exe)?$/i.test(row.name || ""));
  const chrome = count((row) => /chrome-devtools-mcp/i.test(row.args || ""));
  const playwright = count((row) => /@playwright\/mcp|playwright-mcp/i.test(row.args || ""));
  const context7 = count((row) => /@upstash\/context7-mcp/i.test(row.args || ""));
  const sentry = count((row) => /@sentry\/mcp-server/i.test(row.args || ""));
  const candidates = [
    nodeRepl,
    playwright,
    context7,
    sentry,
    chrome >= 3 ? Math.floor(chrome / 3) : chrome,
  ].filter((value) => value > 0);
  return {
    NodeRepl: nodeRepl,
    ChromeDevToolsNodeProcesses: chrome,
    Playwright: playwright,
    Context7: context7,
    Sentry: sentry,
    CommonBundleFloor: candidates.length >= 2 ? Math.min(...candidates) : null,
  };
}

function processFamilies(tree) {
  const counts = new Map();
  for (const row of tree) {
    const name = path.basename(row.name || "unknown");
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts]
    .map(([Name, Count]) => ({ Name, Count }))
    .sort((a, b) => b.Count - a.Count || a.Name.localeCompare(b.Name))
    .slice(0, 8);
}

function windowsHostMemory() {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$os=Get-CimInstance Win32_OperatingSystem",
    "$perf=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction SilentlyContinue",
    "$package=Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1",
    "[pscustomobject]@{",
    " os=[string]$os.Caption",
    " osVersion=[string]$os.Version",
    " totalBytes=[int64]$os.TotalVisibleMemorySize*1KB",
    " freeBytes=[int64]$os.FreePhysicalMemory*1KB",
    " committedBytes=if($perf){[int64]$perf.CommittedBytes}else{$null}",
    " commitLimitBytes=if($perf){[int64]$perf.CommitLimit}else{$null}",
    " packageVersion=if($package){$package.Version.ToString()}else{$null}",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  return JSON.parse(
    run(powershellExecutable(), [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      command,
    ]),
  );
}

function linuxHostMemory() {
  const values = new Map();
  for (const line of readFileSync("/proc/meminfo", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  return {
    os: `${os.type()} ${os.release()}`,
    osVersion: os.release(),
    totalBytes: values.get("MemTotal") || os.totalmem(),
    freeBytes: values.get("MemAvailable") || os.freemem(),
    committedBytes: values.get("Committed_AS") || null,
    commitLimitBytes: values.get("CommitLimit") || null,
    swapTotalBytes: values.get("SwapTotal") || 0,
    swapFreeBytes: values.get("SwapFree") || 0,
    packageVersion: null,
  };
}

function parseByteQuantity(value, unit) {
  const factor = { B: 1, K: 1024, M: 1024 ** 2, G: GIB, T: 1024 ** 4 }[
    String(unit || "B").toUpperCase()
  ];
  return Number(value) * (factor || 1);
}

function macHostMemory() {
  const totalBytes = Number(run("sysctl", ["-n", "hw.memsize"]).trim());
  const vmStat = run("vm_stat", []);
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/i)?.[1] || 4096);
  const pages = {};
  for (const line of vmStat.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+(\d+)\./);
    if (match) pages[match[1]] = Number(match[2]);
  }
  const availablePages =
    (pages["Pages free"] || 0) +
    (pages["Pages inactive"] || 0) +
    (pages["Pages speculative"] || 0) +
    (pages["Pages purgeable"] || 0);

  let swapTotalBytes = 0;
  let swapFreeBytes = 0;
  try {
    const swap = run("sysctl", ["-n", "vm.swapusage"]);
    const total = swap.match(/total\s*=\s*([\d.]+)([BKMG])/i);
    const free = swap.match(/free\s*=\s*([\d.]+)([BKMG])/i);
    if (total) swapTotalBytes = parseByteQuantity(total[1], total[2]);
    if (free) swapFreeBytes = parseByteQuantity(free[1], free[2]);
  } catch {
    // Swap metrics are optional on restricted macOS hosts.
  }

  return {
    os: `${os.type()} ${os.release()}`,
    osVersion: os.release(),
    totalBytes,
    freeBytes: Math.min(totalBytes, availablePages * pageSize),
    committedBytes: null,
    commitLimitBytes: null,
    swapTotalBytes,
    swapFreeBytes,
    packageVersion: null,
  };
}

function hostMemory() {
  if (process.platform === "win32") return windowsHostMemory();
  if (process.platform === "linux") return linuxHostMemory();
  if (process.platform === "darwin") return macHostMemory();
  throw new Error(`Unsupported operating system: ${process.platform}`);
}

function riskLevel(commitPercent, physicalPercent, memoryGiB, processCount) {
  if (
    commitPercent >= 95 ||
    physicalPercent >= 95 ||
    memoryGiB >= 12 ||
    processCount >= 300
  ) return "CRITICAL";
  if (
    commitPercent >= 90 ||
    physicalPercent >= 90 ||
    memoryGiB >= 8 ||
    processCount >= 200
  ) return "HIGH";
  if (
    commitPercent >= 80 ||
    physicalPercent >= 80 ||
    memoryGiB >= 4 ||
    processCount >= 100
  ) return "ELEVATED";
  return "HEALTHY";
}

export function createSnapshot({ appServerPid = 0, requireTopLevel = false } = {}) {
  const rows = processTable();
  const { byPid } = indexProcesses(rows);
  let servers = topLevelAppServers(rows);
  if (Number(appServerPid) > 0) {
    const selected = rows.find((row) => Number(row.pid) === Number(appServerPid));
    if (!selected || !isAppServer(selected)) {
      throw new Error(`PID ${appServerPid} is not a running Codex app-server.`);
    }
    if (
      requireTopLevel &&
      !servers.some((row) => Number(row.pid) === Number(appServerPid))
    ) {
      throw new Error(`PID ${appServerPid} is not a top-level Codex app-server.`);
    }
    servers = [selected];
  }

  const memoryMetric =
    process.platform === "win32" ? "private bytes" : "summed RSS";
  const appServers = servers.map((server) => {
    const tree = descendants(rows, server.pid);
    const rssBytes = tree.reduce((total, row) => total + Number(row.rssBytes || 0), 0);
    const privateBytes =
      process.platform === "win32"
        ? tree.reduce((total, row) => total + Number(row.privateBytes || 0), 0)
        : null;
    const measuredBytes = privateBytes ?? rssBytes;
    return {
      AppServerPid: Number(server.pid),
      ParentName: byPid.get(Number(server.ppid))?.name || null,
      StartedAt: server.startedAt || null,
      ProcessCount: tree.length,
      MemoryMetric: memoryMetric,
      MemoryGiB: gib(measuredBytes),
      WorkingSetGiB: gib(rssBytes),
      PrivateMemoryGiB: privateBytes === null ? null : gib(privateBytes),
      ProcessFamilies: processFamilies(tree),
      McpMarkers: markerCounts(tree),
    };
  });

  const host = hostMemory();
  const physicalUsedBytes = Math.max(0, host.totalBytes - host.freeBytes);
  const physicalPercent =
    host.totalBytes > 0 ? round((physicalUsedBytes / host.totalBytes) * 100, 1) : 0;
  const commitPercent =
    host.commitLimitBytes > 0
      ? round((host.committedBytes / host.commitLimitBytes) * 100, 1)
      : 0;
  const processCount = appServers.reduce((total, item) => total + item.ProcessCount, 0);
  const measuredGiB = round(
    appServers.reduce((total, item) => total + item.MemoryGiB, 0),
  );
  const workingSetGiB = round(
    appServers.reduce((total, item) => total + item.WorkingSetGiB, 0),
  );
  const privateGiB =
    process.platform === "win32"
      ? round(appServers.reduce((total, item) => total + item.PrivateMemoryGiB, 0))
      : null;
  const level = riskLevel(commitPercent, physicalPercent, measuredGiB, processCount);
  const reasons = [];
  if (commitPercent >= 80) reasons.push(`Commit usage is ${commitPercent} percent.`);
  if (physicalPercent >= 80) reasons.push(`Physical memory usage is ${physicalPercent} percent.`);
  if (measuredGiB >= 4) reasons.push(`Codex app-server trees use ${measuredGiB} GiB of ${memoryMetric}.`);
  if (processCount >= 100) reasons.push(`Codex app-server trees contain ${processCount} processes.`);
  if (!appServers.length) reasons.push("No Codex app-server was found.");

  const recommendations = {
    CRITICAL: "Checkpoint active work and run explicit recovery as soon as active work can stop.",
    HIGH: "Stop unnecessary delegation and prepare explicit recovery.",
    ELEVATED: "Audit child agents and measure whether memory returns to baseline.",
    HEALTHY: "No pressure threshold was crossed; keep housekeeping read-only.",
  };

  return {
    SchemaVersion: "2.0",
    Timestamp: new Date().toISOString(),
    Host: {
      Platform: process.platform,
      Architecture: process.arch,
      OS: host.os,
      OSVersion: host.osVersion,
      PhysicalTotalGiB: gib(host.totalBytes),
      PhysicalUsedGiB: gib(physicalUsedBytes),
      PhysicalPercent: physicalPercent,
      CommittedGiB: host.committedBytes == null ? null : gib(host.committedBytes),
      CommitLimitGiB: host.commitLimitBytes == null ? null : gib(host.commitLimitBytes),
      CommitPercent: host.commitLimitBytes == null ? null : commitPercent,
      SwapUsedGiB:
        host.swapTotalBytes == null
          ? null
          : gib(Math.max(0, host.swapTotalBytes - host.swapFreeBytes)),
      CodexPackageVersion: host.packageVersion,
    },
    Risk: { Level: level, Reasons: reasons },
    Totals: {
      TopLevelAppServers: appServers.length,
      CodexProcessCount: processCount,
      MemoryMetric: memoryMetric,
      MemoryGiB: measuredGiB,
      WorkingSetGiB: workingSetGiB,
      PrivateMemoryGiB: privateGiB,
    },
    AppServers: appServers,
    Recommendations: [recommendations[level]],
    Safety: {
      ReadOnly: true,
      ProcessesTerminated: 0,
      CommandLinesEmitted: false,
    },
  };
}

function snapshotMemoryGiB(snapshot) {
  return Number(
    snapshot?.Totals?.MemoryGiB ??
      snapshot?.Totals?.PrivateMemoryGiB ??
      snapshot?.Totals?.WorkingSetGiB ??
      0,
  );
}

function lightweightRecoverySnapshot(before, termination) {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const physicalUsedBytes = Math.max(0, totalBytes - freeBytes);
  const completed = termination.StillRunning === 0;
  return {
    SchemaVersion: "2.0-recovery",
    Timestamp: new Date().toISOString(),
    Scope: "selected app-server identity after termination",
    Host: {
      Platform: process.platform,
      Architecture: process.arch,
      OS: `${os.type()} ${os.release()}`,
      OSVersion: os.release(),
      PhysicalTotalGiB: gib(totalBytes),
      PhysicalUsedGiB: gib(physicalUsedBytes),
      PhysicalPercent:
        totalBytes > 0 ? round((physicalUsedBytes / totalBytes) * 100, 1) : 0,
      CommittedGiB: null,
      CommitLimitGiB: null,
      CommitPercent: null,
      SwapUsedGiB: null,
      CodexPackageVersion: before?.Host?.CodexPackageVersion || null,
    },
    Risk: {
      Level: "UNKNOWN",
      Reasons: [
        "This lightweight sample avoids a full process scan during critical recovery.",
      ],
    },
    Totals: {
      TopLevelAppServers: completed ? 0 : null,
      CodexProcessCount: completed ? 0 : null,
      MemoryMetric: before?.Totals?.MemoryMetric || "unknown",
      MemoryGiB: completed ? 0 : null,
      WorkingSetGiB: completed ? 0 : null,
      PrivateMemoryGiB:
        completed && process.platform === "win32" ? 0 : null,
    },
    AppServers: [],
    Recommendations: [
      "After reopening or resuming Codex, capture a full snapshot for the new baseline.",
    ],
    Safety: {
      ReadOnly: true,
      ProcessesTerminated: 0,
      CommandLinesEmitted: false,
    },
  };
}

export function compareSnapshots(before, after) {
  const beforeMemory = snapshotMemoryGiB(before);
  const afterMemory = snapshotMemoryGiB(after);
  const beforePhysical = Number(before?.Host?.PhysicalUsedGiB || 0);
  const afterPhysical = Number(after?.Host?.PhysicalUsedGiB || 0);
  return {
    SchemaVersion: "1.0",
    BeforeTimestamp: before.Timestamp,
    AfterTimestamp: after.Timestamp,
    Platform: after?.Host?.Platform || before?.Host?.Platform || "unknown",
    Architecture: after?.Host?.Architecture || before?.Host?.Architecture || "unknown",
    CodexProcessCount: {
      Before: Number(before?.Totals?.CodexProcessCount || 0),
      After: Number(after?.Totals?.CodexProcessCount || 0),
      Delta:
        Number(after?.Totals?.CodexProcessCount || 0) -
        Number(before?.Totals?.CodexProcessCount || 0),
    },
    CodexMemoryGiB: {
      Metric: after?.Totals?.MemoryMetric || before?.Totals?.MemoryMetric || "unknown",
      Before: beforeMemory,
      After: afterMemory,
      Delta: round(afterMemory - beforeMemory),
      Reclaimed: round(Math.max(0, beforeMemory - afterMemory)),
    },
    PhysicalUsedGiB: {
      Before: beforePhysical,
      After: afterPhysical,
      Delta: round(afterPhysical - beforePhysical),
      Reclaimed: round(Math.max(0, beforePhysical - afterPhysical)),
    },
  };
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (text && !/[\s"]/u.test(text)) return text;
  let result = '"';
  let slashes = 0;
  for (const character of text) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      result += `${"\\".repeat(slashes * 2 + 1)}"`;
      slashes = 0;
      continue;
    }
    result += `${"\\".repeat(slashes)}${character}`;
    slashes = 0;
  }
  return `${result}${"\\".repeat(slashes * 2)}"`;
}

function spawnRecoveryWorker(workerArguments) {
  if (process.platform !== "win32") {
    const child = spawn(process.execPath, workerArguments, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    child.unref();
    return child.pid;
  }

  // A normal detached child still belongs to the Codex Windows job object and
  // can be terminated with the app-server. WMI creates the worker outside that
  // job so it can finish the after-snapshot and evidence report.
  const commandLine = [process.execPath, ...workerArguments]
    .map(quoteWindowsArgument)
    .join(" ");
  const escaped = commandLine.replaceAll("'", "''");
  const command = [
    `$commandLine='${escaped}'`,
    "$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine}",
    "if([int]$result.ReturnValue -ne 0){throw \"Win32_Process.Create failed: $($result.ReturnValue)\"}",
    "[int]$result.ProcessId",
  ].join("\n");
  const output = run(powershellExecutable(), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ]).trim();
  const pid = Number(output.split(/\r?\n/).at(-1));
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Windows recovery worker did not return a valid PID.");
  }
  return pid;
}

function parseArguments(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (
      ["json", "yes", "foreground", "help", "internal-test-mode"].includes(key)
    ) {
      parsed[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function printSnapshot(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  console.log(`RAM Raccoon: ${report.Risk.Level}`);
  console.log(`Platform: ${report.Host.Platform}/${report.Host.Architecture}`);
  console.log(
    `Physical: ${report.Host.PhysicalUsedGiB}/${report.Host.PhysicalTotalGiB} GiB (${report.Host.PhysicalPercent}%)`,
  );
  console.log(
    `Codex tree: ${report.Totals.CodexProcessCount} processes / ${report.Totals.MemoryGiB} GiB ${report.Totals.MemoryMetric}`,
  );
}

function sameProcessIdentity(actual, expectedStartedAt) {
  if (!actual || !isAppServer(actual)) return false;
  if (!expectedStartedAt || !actual.startedAt) return false;
  return actual.startedAt === expectedStartedAt;
}

function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateVerifiedTree(targetPid, expectedStartedAt, onPlan = () => {}) {
  const rows = processTable();
  const { byPid } = indexProcesses(rows);
  const target = byPid.get(Number(targetPid));
  if (!sameProcessIdentity(target, expectedStartedAt)) {
    throw new Error("Recovery refused: the app-server PID or start identity changed.");
  }
  if (
    !topLevelAppServers(rows).some((row) => Number(row.pid) === Number(targetPid))
  ) {
    throw new Error("Recovery refused: the target is no longer a top-level app-server.");
  }
  const protectedWindowsHosts = new Set([
    "conhost.exe",
    "openconsole.exe",
    "windowsterminal.exe",
    "csrss.exe",
  ]);
  const eligible = processDepths(rows, targetPid)
    .filter((item) => item.pid !== process.pid)
    .filter((item) => {
      if (process.platform !== "win32") return true;
      const name = String(byPid.get(item.pid)?.name || "").toLowerCase();
      return !protectedWindowsHosts.has(name);
    });
  const ordered = [
    ...eligible.filter((item) => item.pid === Number(targetPid)),
    ...eligible
      .filter((item) => item.pid !== Number(targetPid))
      .sort((a, b) => b.depth - a.depth),
  ];
  onPlan(
    ordered.map((item) => ({
      Pid: item.pid,
      Depth: item.depth,
      Name: byPid.get(item.pid)?.name || "unknown",
    })),
  );

  const attempted = [];
  if (process.platform === "win32") {
    const pids = ordered.map((item) => Number(item.pid));
    if (pids.length) {
      const command = [
        "$ErrorActionPreference='Stop'",
        `$ids=@(${pids.join(",")})`,
        "foreach($processId in $ids){",
        "  Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue",
        "}",
      ].join("\n");
      run(powershellExecutable(), [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        command,
      ]);
      attempted.push(...pids);
    }
  } else {
    for (const item of ordered) {
      try {
        process.kill(item.pid, "SIGTERM");
        attempted.push(item.pid);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await sleep(2500);
    for (const item of ordered) {
      if (!isAlive(item.pid)) continue;
      try {
        process.kill(item.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  await sleep(1000);
  const alive = new Set(processTable().map((row) => Number(row.pid)));
  return {
    Attempted: attempted.length,
    StillRunning: attempted.filter((pid) => alive.has(pid)).length,
  };
}

async function recoveryWorker(options) {
  const outputDirectory = path.resolve(options["output-dir"]);
  const id = options.id;
  const reportPath = path.join(outputDirectory, `${id}-recovery.json`);
  const beforePath = path.join(outputDirectory, `${id}-before.json`);
  const afterPath = path.join(outputDirectory, `${id}-after.json`);
  let state = JSON.parse(readFileSync(reportPath, "utf8"));

  try {
    await sleep(Number(options["delay-seconds"]) * 1000);
    state.Status = "terminating";
    state.TerminationStartedAt = new Date().toISOString();
    writeJsonAtomic(reportPath, state);

    const termination = await terminateVerifiedTree(
      Number(options["app-server-pid"]),
      options["started-at"],
      (plan) => {
        state.TerminationPlan = plan;
        writeJsonAtomic(reportPath, state);
      },
    );
    state.Termination = termination;
    state.Status = "settling";
    writeJsonAtomic(reportPath, state);

    await sleep(Number(options["settle-seconds"]) * 1000);
    state.Status = "collecting_after";
    writeJsonAtomic(reportPath, state);
    const before = JSON.parse(readFileSync(beforePath, "utf8"));
    const after = lightweightRecoverySnapshot(before, termination);
    state.Status = "writing_after";
    writeJsonAtomic(reportPath, state);
    writeJsonAtomic(afterPath, after);
    state = {
      ...state,
      Status: termination.StillRunning === 0 ? "completed" : "partial",
      CompletedAt: new Date().toISOString(),
      AfterSnapshot: afterPath,
      Comparison: compareSnapshots(before, after),
    };
    writeJsonAtomic(reportPath, state);
    return state;
  } catch (error) {
    state = {
      ...state,
      Status: "failed",
      FailedAt: new Date().toISOString(),
      Error: error instanceof Error ? error.message : String(error),
    };
    writeJsonAtomic(reportPath, state);
    throw error;
  }
}

async function startRecovery(options) {
  if (!options.yes) {
    throw new Error(
      "Recovery changes process state. Re-run only after checkpointing, with --yes.",
    );
  }
  if (options.foreground && !TEST_MODE) {
    throw new Error("--foreground is reserved for the controlled test suite.");
  }

  const requestedPid = Number(options["app-server-pid"] || 0);
  const before = createSnapshot({
    appServerPid: requestedPid,
    requireTopLevel: true,
  });
  if (before.AppServers.length !== 1) {
    throw new Error(
      "Recovery requires exactly one target. Pass --app-server-pid from the snapshot.",
    );
  }
  const target = before.AppServers[0];
  const outputDirectory = path.resolve(
    options["output-dir"] || path.join(process.cwd(), ".ramraccoon"),
  );
  const id =
    options.id ||
    `recovery-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const beforePath = path.join(outputDirectory, `${id}-before.json`);
  const afterPath = path.join(outputDirectory, `${id}-after.json`);
  const reportPath = path.join(outputDirectory, `${id}-recovery.json`);
  const delaySeconds = Math.max(5, Number(options["delay-seconds"] || 15));
  const settleSeconds = Math.max(1, Number(options["settle-seconds"] || 15));

  mkdirSync(outputDirectory, { recursive: true });
  writeJsonAtomic(beforePath, before);
  const state = {
    SchemaVersion: "1.0",
    RecoveryId: id,
    Status: "scheduled",
    ScheduledAt: new Date().toISOString(),
    Platform: process.platform,
    Architecture: process.arch,
    Target: {
      AppServerPid: target.AppServerPid,
      StartedAt: target.StartedAt,
      ProcessCount: target.ProcessCount,
      MemoryMetric: target.MemoryMetric,
      MemoryGiB: target.MemoryGiB,
    },
    BeforeSnapshot: beforePath,
    AfterSnapshot: afterPath,
    CheckpointRequired: true,
    Resume: options["thread-id"]
      ? `codex resume ${options["thread-id"]}`
      : "Reopen the task in the Codex app, or run codex resume <session-id>.",
  };
  writeJsonAtomic(reportPath, state);

  const workerOptions = {
    _: ["__recover-worker"],
    "app-server-pid": String(target.AppServerPid),
    "started-at": target.StartedAt,
    "output-dir": outputDirectory,
    id,
    "delay-seconds": String(delaySeconds),
    "settle-seconds": String(settleSeconds),
  };

  if (options.foreground) {
    return recoveryWorker(workerOptions);
  }

  const workerArguments = [
    SCRIPT_PATH,
    "__recover-worker",
    "--app-server-pid",
    String(target.AppServerPid),
    "--started-at",
    target.StartedAt,
    "--output-dir",
    outputDirectory,
    "--id",
    id,
    "--delay-seconds",
    String(delaySeconds),
    "--settle-seconds",
    String(settleSeconds),
  ];
  if (TEST_MODE) workerArguments.push("--internal-test-mode");
  const workerPid = spawnRecoveryWorker(workerArguments);
  return {
    ...state,
    WorkerPid: workerPid,
    ReportPath: reportPath,
    Message: `Recovery is scheduled in ${delaySeconds} seconds. This task will disconnect while the verified app-server tree restarts.`,
  };
}

function usage() {
  return `RAM Raccoon

Usage:
  node ramraccoon.mjs snapshot [--app-server-pid PID] [--json] [--output FILE]
  node ramraccoon.mjs compare --before FILE --after FILE [--json]
  node ramraccoon.mjs recover --app-server-pid PID --output-dir DIR [--thread-id ID] --yes

Recovery is destructive to the selected live runtime. Checkpoint first. The
worker re-verifies the exact PID and start identity, terminates only that
app-server process tree, then writes a measured before/after report.
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const command = options._[0];
  if (!command || options.help) {
    process.stdout.write(usage());
    return;
  }

  if (command === "snapshot") {
    const report = createSnapshot({
      appServerPid: Number(options["app-server-pid"] || 0),
    });
    if (options.output) writeJsonAtomic(path.resolve(options.output), report);
    printSnapshot(report, options.json);
    return;
  }

  if (command === "compare") {
    if (!options.before || !options.after) {
      throw new Error("compare requires --before and --after.");
    }
    for (const file of [options.before, options.after]) {
      if (!existsSync(file)) throw new Error(`Snapshot does not exist: ${file}`);
    }
    const result = compareSnapshots(
      JSON.parse(readFileSync(options.before, "utf8")),
      JSON.parse(readFileSync(options.after, "utf8")),
    );
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      console.log(
        `Codex memory: ${result.CodexMemoryGiB.Before} -> ${result.CodexMemoryGiB.After} GiB (${result.CodexMemoryGiB.Delta >= 0 ? "+" : ""}${result.CodexMemoryGiB.Delta})`,
      );
      console.log(`Measured reclaimed: ${result.CodexMemoryGiB.Reclaimed} GiB`);
    }
    return;
  }

  if (command === "recover") {
    const result = await startRecovery(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === "__recover-worker") {
    await recoveryWorker(options);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(`RAM Raccoon error: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  descendants,
  isAppServer,
  riskLevel,
  topLevelAppServers,
};
