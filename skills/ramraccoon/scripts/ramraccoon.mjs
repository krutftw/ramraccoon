#!/usr/bin/env node

import {
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { asciiJson, hostMemory, platformSupport, powershellExecutable, processTable, quotePowerShellLiteral, run, TEST_MODE } from "./platform.mjs";

const GIB = 1024 ** 3;
const VERSION = "0.4.2";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

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

function commandArguments(row) {
  if (Array.isArray(row.argv)) return row.argv;
  const command = String(row.args || "").trim();
  const tokens = (text) => (text.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [])
    .map((item) => item.replace(/^["']|["']$/g, ""));
  if (row.executable && command.startsWith(`${row.executable} `)) {
    return [row.executable, ...tokens(command.slice(row.executable.length))];
  }
  return tokens(command);
}

const isTestFixture = (row) => TEST_MODE && commandArguments(row).includes("ramraccoon-test-app-server");

function isAppServer(row) {
  if (!row) return false;
  const argv = commandArguments(row);
  if (isTestFixture(row)) return true;
  const name = path.win32.basename(path.posix.basename(row.name || "")).toLowerCase();
  if (name !== "codex" && name !== "codex.exe") return false;
  const valueOptions = new Set(["-c", "--config", "--enable", "--disable", "-p", "--profile", "-C", "--cd"]);
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (valueOptions.has(option)) {
      if (++index >= argv.length) return false;
      continue;
    }
    if (option.startsWith("--") && valueOptions.has(option.split("=")[0]) && option.includes("=")) continue;
    if (option === "--strict-config") continue;
    // Only the actual subcommand identifies a server, never a prompt or config value.
    if (option !== "app-server") return false;
    // `app-server` takes options only. A following word is a helper subcommand
    // such as `daemon` or `generate-ts`, or, where macOS ps joined argv with
    // spaces, a prompt that begins with "app-server". Later tokens can be option
    // values that contain spaces.
    return argv.length === index + 1 || argv[index + 1].startsWith("-");
  }
  return false;
}

// Windows keeps an exited parent's PID in ParentProcessId and later reuses
// that PID, so a process that started before its recorded parent is an orphan.
// Other platforms reparent orphans, and macOS start times are ambiguous local
// times during a daylight-saving change, so only Windows rows are checked.
function startedBeforeParent(row, parent) {
  if (!row?.parentMayBeStale || !parent?.parentMayBeStale) return false;
  const started = Date.parse(row?.startedAt);
  const parentStarted = Date.parse(parent?.startedAt);
  return Number.isFinite(started) && Number.isFinite(parentStarted) && started < parentStarted;
}

function indexProcesses(rows) {
  const byPid = new Map();
  const children = new Map();
  for (const row of rows) byPid.set(Number(row.pid), row);
  for (const row of rows) {
    const parent = Number(row.ppid);
    if (startedBeforeParent(row, byPid.get(parent))) continue;
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
    let child = server;
    const visited = new Set();
    while (Number(child.ppid) > 0 && !visited.has(Number(child.ppid))) {
      visited.add(Number(child.ppid));
      const parent = byPid.get(Number(child.ppid));
      if (!parent || startedBeforeParent(child, parent)) break;
      // Tests run from a Codex task sit beneath a real app-server; a fixture
      // is nested only beneath another fixture.
      if (serverIds.has(Number(parent.pid)) && isTestFixture(parent) === isTestFixture(server)) return false;
      child = parent;
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

function topMemoryConsumers(rows, platform = process.platform) {
  const windows = platform === "win32";
  const measuredBytes = (row) => Number((windows ? row.privateBytes : row.rssBytes) || 0);
  return rows
    .filter((row) => Number(row.pid) > 0)
    .sort((a, b) => measuredBytes(b) - measuredBytes(a) || Number(a.pid) - Number(b.pid))
    .slice(0, 10)
    .map((row) => ({
      Pid: Number(row.pid),
      Name: path.basename(row.name || "unknown"),
      StartedAt: row.startedAt || null,
      MemoryMetric: windows ? "private bytes" : "RSS",
      MemoryGiB: gib(measuredBytes(row)),
      WorkingSetGiB: gib(row.rssBytes),
      PrivateMemoryGiB: windows ? gib(row.privateBytes) : null,
      Services: null,
    }));
}

function windowsServices() {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$services=@(Get-CimInstance Win32_Service -Filter 'ProcessId > 0' | Select-Object ProcessId,Name,DisplayName)",
    asciiJson("ConvertTo-Json -Compress -InputObject $services"),
  ].join("\n");
  try {
    const services = JSON.parse(
      run(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", command]),
    );
    const byPid = new Map();
    for (const service of services) {
      const pid = Number(service.ProcessId);
      if (!byPid.has(pid)) byPid.set(pid, []);
      byPid.get(pid).push({ Name: service.Name, DisplayName: service.DisplayName });
    }
    return byPid;
  } catch {
    return null;
  }
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

const severity = ["HEALTHY", "ELEVATED", "HIGH", "CRITICAL"];
const higherRisk = (...levels) => severity[Math.max(...levels.map((level) => severity.indexOf(level)))];

function classifySnapshotRisk(hostLevel, observedCodexLevel, processScanComplete) {
  const codexLevel = !processScanComplete && observedCodexLevel === "HEALTHY" ? "UNKNOWN" : observedCodexLevel;
  const knownLevel = higherRisk(hostLevel, codexLevel);
  return { level: knownLevel === "HEALTHY" && codexLevel === "UNKNOWN" ? "UNKNOWN" : knownLevel, codexLevel };
}

function classifyHostMemory(host) {
  const physicalPercent = host.totalBytes > 0 ? (host.totalBytes - host.freeBytes) / host.totalBytes * 100 : null;
  const commitPercent = host.commitLimitEnforced === true && host.commitLimitBytes > 0 && host.committedBytes != null
    ? host.committedBytes / host.commitLimitBytes * 100 : null;
  const physicalRisk = host.memoryPressure || riskLevel(null, physicalPercent, 0, 0);
  return higherRisk(physicalRisk, riskLevel(commitPercent, null, 0, 0), riskLevel(null, host.cgroup?.percent, 0, 0));
}

// Reasons follow classifyHostMemory: unrounded values, and an OS pressure
// signal takes precedence over the physical estimate.
function hostRiskReasons(host) {
  const physicalPercent = host.totalBytes > 0 ? (host.totalBytes - host.freeBytes) / host.totalBytes * 100 : null;
  const commitPercent = host.commitLimitEnforced === true && host.commitLimitBytes > 0 && host.committedBytes != null
    ? host.committedBytes / host.commitLimitBytes * 100 : null;
  const reasons = [];
  if (commitPercent >= 80) reasons.push(`Enforced commit usage is ${round(commitPercent, 1)} percent.`);
  if (physicalPercent >= 80) {
    reasons.push(host.memoryPressure
      ? `The ${host.availabilityKind} is ${round(physicalPercent, 1)} percent used; the operating system's ${host.memoryPressure} pressure level takes precedence.`
      : `Physical memory usage is ${round(physicalPercent, 1)} percent (${host.availabilityKind}).`);
  }
  if (host.cgroup?.percent >= 80) reasons.push(`A visible cgroup memory limit is ${round(host.cgroup.percent, 1)} percent used.`);
  if (host.memoryPressure && host.memoryPressure !== "HEALTHY") reasons.push(`The operating system reports ${host.memoryPressure} memory pressure.`);
  return reasons;
}

export function createSnapshot(options) {
  return collectSnapshot(options).report;
}

function collectSnapshot({ appServerPid = 0, requireTopLevel = false } = {}) {
  if (!Number.isSafeInteger(appServerPid) || appServerPid < 0) throw new Error("appServerPid must be a non-negative integer.");
  const { rows, warnings: processWarnings } = processTable();
  const host = hostMemory();
  // A sandbox's private process view hides everything outside it, so its scan
  // cannot support comparisons or recovery.
  const sandboxed = host.processViewSandboxed === true;
  const scanComplete = processWarnings.length === 0 && !sandboxed;
  const { byPid } = indexProcesses(rows);
  let servers = topLevelAppServers(rows);
  if (Number(appServerPid) > 0) {
    const selected = rows.find((row) => Number(row.pid) === Number(appServerPid));
    if (!selected && sandboxed) {
      throw new Error(`PID ${appServerPid} is not visible from inside this sandbox; run the check outside it.`);
    }
    if (!scanComplete && (!selected || !isAppServer(selected))) {
      throw new Error(`PID ${appServerPid} could not be verified as a Codex app-server because the process scan is incomplete: ${processWarnings.join(" ")}`);
    }
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
  const trees = new Map();
  const appServers = servers.map((server) => {
    const tree = descendants(rows, server.pid);
    trees.set(Number(server.pid), tree);
    const rssBytes = tree.reduce((total, row) => total + Number(row.rssBytes || 0), 0);
    const privateBytes =
      process.platform === "win32"
        ? tree.reduce((total, row) => total + Number(row.privateBytes || 0), 0)
        : null;
    const measuredBytes = privateBytes ?? rssBytes;
    const parent = byPid.get(Number(server.ppid));
    return {
      AppServerPid: Number(server.pid),
      ParentName: parent && !startedBeforeParent(server, parent) ? parent.name || null : null,
      // Identifies the runtime that launched this check, normally the agent's own task.
      ContainsCurrentProcess: tree.some((row) => Number(row.pid) === process.pid),
      StartedAt: server.startedAt || null,
      StartIdentity: server.startIdentity || server.startedAt || null,
      ProcessCount: tree.length,
      MemoryMetric: memoryMetric,
      MemoryGiB: gib(measuredBytes),
      WorkingSetGiB: gib(rssBytes),
      PrivateMemoryGiB: privateBytes === null ? null : gib(privateBytes),
      ProcessFamilies: processFamilies(tree),
      McpMarkers: markerCounts(tree),
    };
  });

  const physicalUsedBytes = Math.max(0, host.totalBytes - host.freeBytes);
  const physicalPercent =
    host.totalBytes > 0 ? round((physicalUsedBytes / host.totalBytes) * 100, 1) : 0;
  const commitPercent =
    host.commitLimitBytes > 0 && host.committedBytes != null
      ? round((host.committedBytes / host.commitLimitBytes) * 100, 1)
      : null;
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
  const hostLevel = classifyHostMemory(host);
  const { level, codexLevel } = classifySnapshotRisk(
    hostLevel,
    riskLevel(null, null, measuredGiB, processCount),
    scanComplete,
  );
  const reasons = hostRiskReasons(host);
  if (measuredGiB >= 4) reasons.push(`Codex app-server trees use ${measuredGiB} GiB of ${memoryMetric}.`);
  if (processCount >= 100) reasons.push(`Codex app-server trees contain ${processCount} processes.`);
  if (!appServers.length) {
    reasons.push(sandboxed ? "No Codex app-server is visible from inside this sandbox."
      : !scanComplete ? "No Codex app-server was identified; the process scan is incomplete, so one may be hidden."
        : "No Codex app-server was found.");
  }

  const recommendations = [];
  if (sandboxed) {
    recommendations.push("Run the check outside the sandbox; processes outside it, including any Codex app-server, are invisible from here.");
  } else if (hostLevel !== "HEALTHY") {
    recommendations.push(
      "Inspect the top system consumers before choosing a recovery target; host pressure alone does not identify Codex as the cause.",
    );
    // An incomplete scan cannot show that no app-server exists.
    if (!appServers.length && scanComplete) {
      recommendations.push("No Codex app-server was found; no supported app-server recovery target is available.");
    }
  }
  if (codexLevel === "HIGH" || codexLevel === "CRITICAL") {
    recommendations.push(
      "Stop unnecessary delegation and checkpoint active work. Consider recovery of one verified Codex tree only after explicit approval.",
    );
  } else if (codexLevel === "ELEVATED") {
    recommendations.push("Audit child agents and measure whether their memory returns to baseline.");
  }
  if (level === "HEALTHY") {
    recommendations.push("No pressure threshold was crossed; keep housekeeping read-only.");
  } else if (level === "UNKNOWN" || (!scanComplete && !sandboxed)) {
    recommendations.push("Some processes could not be inspected, so Codex usage is unknown. Report the missing visibility instead of treating this as healthy.");
  }

  const topProcesses = topMemoryConsumers(rows);
  const collectionWarnings = [...processWarnings, ...host.warnings];
  if (process.platform === "win32") {
    const services = windowsServices();
    if (services === null) {
      collectionWarnings.push("Windows service lookup was unavailable; service ownership is unknown.");
    } else {
      for (const row of topProcesses) row.Services = services.get(row.Pid) || [];
    }
  }

  const report = {
    SchemaVersion: "3.0",
    Timestamp: new Date().toISOString(),
    Scope: appServerPid > 0 ? "selected app-server" : "all visible app-servers",
    Host: {
      Platform: process.platform,
      Architecture: process.arch,
      MachineArchitecture: os.machine(),
      Environment: host.environment,
      ProcessScope: "visible operating-system processes",
      ProcessViewSandboxed: sandboxed,
      PhysicalAvailabilityKind: host.availabilityKind,
      OS: host.os,
      OSVersion: host.osVersion,
      PhysicalTotalGiB: gib(host.totalBytes),
      PhysicalUsedGiB: gib(physicalUsedBytes),
      PhysicalAvailableGiB: gib(host.freeBytes),
      PhysicalPercent: physicalPercent,
      CommittedGiB: host.committedBytes == null ? null : gib(host.committedBytes),
      CommitLimitGiB: host.commitLimitBytes == null ? null : gib(host.commitLimitBytes),
      CommitAvailableGiB:
        host.commitLimitEnforced !== true || commitPercent == null ? null : gib(Math.max(0, host.commitLimitBytes - host.committedBytes)),
      CommitPercent: commitPercent,
      CommitLimitEnforced: host.commitLimitEnforced,
      OvercommitMode: host.overcommitMode ?? null,
      OperatingSystemMemoryPressure: host.memoryPressure ?? null,
      Cgroup: host.cgroup ? {
        MemoryLimitGiB: gib(host.cgroup.limitBytes),
        AvailableGiB: gib(host.cgroup.availableBytes),
        Percent: round(host.cgroup.percent, 1),
        Constraints: host.cgroup.constraints.map((item) => ({
          Version: item.version,
          LimitGiB: gib(item.limitBytes),
          UsedGiB: gib(item.usedBytes),
          AvailableGiB: gib(item.availableBytes),
          Percent: round(item.percent, 1),
        })),
      } : null,
      SwapUsedGiB:
        host.swapTotalBytes == null
          ? null
          : gib(Math.max(0, host.swapTotalBytes - host.swapFreeBytes)),
    },
    Risk: { Level: level, HostLevel: hostLevel, CodexLevel: codexLevel, Reasons: reasons },
    Totals: {
      ProcessScanComplete: scanComplete,
      TopLevelAppServers: appServers.length,
      CodexProcessCount: processCount,
      MemoryMetric: memoryMetric,
      MemoryGiB: measuredGiB,
      WorkingSetGiB: workingSetGiB,
      PrivateMemoryGiB: privateGiB,
    },
    AppServers: appServers,
    TopProcesses: topProcesses,
    CollectionWarnings: collectionWarnings,
    Recommendations: recommendations,
    Safety: {
      ReadOnly: true,
      ProcessesTerminated: 0,
      CommandLinesEmitted: false,
    },
  };
  return { report, trees };
}

function snapshotMemoryGiB(snapshot) {
  const totals = snapshot?.Totals;
  if (!totals) return null;
  return Object.hasOwn(totals, "MemoryGiB")
    ? totals.MemoryGiB
    : totals.PrivateMemoryGiB ?? totals.WorkingSetGiB ?? null;
}

function measurementChange(before, after) {
  const known = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const beforeValue = known(before) ? before : null;
  const afterValue = known(after) ? after : null;
  return {
    Before: beforeValue,
    After: afterValue,
    Delta: beforeValue === null || afterValue === null ? null : round(afterValue - beforeValue),
  };
}

function memoryChange(before, after) {
  const change = measurementChange(before, after);
  return {
    ...change,
    Reclaimed: change.Delta === null ? null : Math.max(0, -change.Delta),
  };
}

function lightweightRecoverySnapshot(before, termination) {
  const totalBytes = os.totalmem();
  const completed = termination.StillRunning === 0 && termination.ExcludedStillRunning === 0 &&
    !termination.DetachedStillRunning && !termination.SpawnedStillRunning;
  return {
    SchemaVersion: "3.0-recovery",
    Timestamp: new Date().toISOString(),
    Scope: "selected app-server",
    Host: {
      Platform: process.platform,
      Architecture: process.arch,
      OS: `${os.type()} ${os.release()}`,
      OSVersion: os.release(),
      PhysicalTotalGiB: gib(totalBytes),
      PhysicalUsedGiB: null,
      PhysicalAvailableGiB: null,
      PhysicalPercent: null,
      CommittedGiB: null,
      CommitLimitGiB: null,
      CommitPercent: null,
      SwapUsedGiB: null,
    },
    Risk: {
      Level: "UNKNOWN",
      Reasons: [
        "This lightweight sample records which target identities remain after termination; it takes no host memory readings.",
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
    // This sample follows a termination, so it must not claim to be read-only.
    Safety: {
      ReadOnly: false,
      ProcessesSignalled: termination.Attempted ?? null,
      ProcessesTerminated: termination.Terminated ?? null,
      CommandLinesEmitted: false,
    },
  };
}

export function compareSnapshots(before, after) {
  const beforeMetric = before?.Totals?.MemoryMetric || null;
  const afterMetric = after?.Totals?.MemoryMetric || null;
  const memory = memoryChange(snapshotMemoryGiB(before), snapshotMemoryGiB(after));
  const complete = before?.Totals?.ProcessScanComplete !== false && after?.Totals?.ProcessScanComplete !== false;
  // Schema 1.0 reports came from the Windows-only PowerShell releases and record no platform.
  const platformOf = (snapshot) => snapshot?.Host?.Platform || (snapshot?.SchemaVersion === "1.0" ? "win32" : null);
  const sameHostKind = !platformOf(before) || !platformOf(after) || platformOf(before) === platformOf(after);
  const sameScope = !before.Scope || !after.Scope || before.Scope === after.Scope;
  // Swapped files would turn growth into a claimed reduction.
  const beforeTime = Date.parse(before?.Timestamp);
  const afterTime = Date.parse(after?.Timestamp);
  const inOrder = !Number.isFinite(beforeTime) || !Number.isFinite(afterTime) || afterTime >= beforeTime;
  const comparable = complete && sameHostKind && sameScope && inOrder && (!beforeMetric || !afterMetric || beforeMetric === afterMetric);
  const counts = measurementChange(before?.Totals?.CodexProcessCount, after?.Totals?.CodexProcessCount);
  if (!complete || !sameHostKind || !sameScope || !inOrder) counts.Delta = null;
  if (!comparable) {
    memory.Delta = null;
    memory.Reclaimed = null;
  }
  const physical = memoryChange(before?.Host?.PhysicalUsedGiB, after?.Host?.PhysicalUsedGiB);
  const committed = memoryChange(before?.Host?.CommittedGiB, after?.Host?.CommittedGiB);
  if (!sameHostKind || !inOrder) {
    for (const change of [physical, committed]) {
      change.Delta = null;
      change.Reclaimed = null;
    }
  }
  return {
    SchemaVersion: "1.1",
    BeforeTimestamp: before.Timestamp,
    AfterTimestamp: after.Timestamp,
    Platform: after?.Host?.Platform || before?.Host?.Platform || "unknown",
    Architecture: after?.Host?.Architecture || before?.Host?.Architecture || "unknown",
    CodexProcessCount: counts,
    CodexMemoryGiB: {
      Metric: comparable ? afterMetric || beforeMetric || "unknown" : "incomparable",
      ...memory,
    },
    PhysicalUsedGiB: physical,
    CommittedGiB: committed,
  };
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    // A partly written file, for example on a full disk, must not be left behind.
    rmSync(temporary, { force: true });
    throw error;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(temporary, file);
      return;
    } catch (error) {
      // Windows refuses to replace a file that a reader or scanner briefly holds open.
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 40) {
        rmSync(temporary, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function readSnapshotFile(file) {
  if (!existsSync(file)) throw new Error(`Snapshot does not exist: ${file}`);
  const bytes = readFileSync(file);
  // Windows PowerShell 5.1 saves `>` output as UTF-16LE, and its UTF-8 files start with a BOM.
  const text = bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString("utf16le")
    : bytes.toString("utf8").replace(/^\uFEFF/, "");
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error(`Snapshot is not valid JSON: ${file}`);
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error(`Snapshot is not a RAM Raccoon report: ${file}`);
  }
  return report;
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

async function spawnRecoveryWorker(workerArguments) {
  if (process.platform !== "win32") {
    const child = spawn(process.execPath, workerArguments, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: process.env,
    });
    // Spawn failures arrive asynchronously; confirm the worker exists before reporting it scheduled.
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return child.pid;
  }

  // A normal detached child still belongs to the Codex Windows job object and
  // can be terminated with the app-server. WMI creates the worker outside that
  // job so it can finish the after-snapshot and evidence report. Its console
  // must stay hidden: closing a visible one kills the worker mid-recovery.
  const commandLine = [process.execPath, ...workerArguments]
    .map(quoteWindowsArgument)
    .join(" ");
  const command = [
    `$commandLine=${quotePowerShellLiteral(commandLine)}`,
    "$startup=New-CimInstance -ClassName Win32_ProcessStartup -Namespace root/cimv2 -ClientOnly -Property @{ShowWindow=[uint16]0}",
    "$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$commandLine; ProcessStartupInformation=$startup}",
    // A distinct exit code says no worker was created; error text would also
    // match this script, which Node echoes in every failure message.
    "if([int]$result.ReturnValue -ne 0){exit 3}",
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

function positivePid(value) {
  if (!/^[1-9]\d*$/.test(String(value || "")) || !Number.isSafeInteger(Number(value))) {
    throw new Error("--app-server-pid requires an explicit positive integer PID.");
  }
  return Number(value);
}

function parseArguments(argv) {
  const parsed = { _: [] };
  const booleans = new Set(["json", "yes", "foreground", "help", "version", "internal-test-mode"]);
  const values = new Set(["app-server-pid", "output", "before", "after", "output-dir", "thread-id", "id", "delay-seconds", "settle-seconds", "start-identity"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] === "-h" ? "--help" : argv[index] === "-v" ? "--version" : argv[index];
    if (!value.startsWith("-")) {
      parsed._.push(value);
      continue;
    }
    if (!value.startsWith("--")) throw new Error(`Unknown option: ${value}`);
    const equals = value.indexOf("=");
    const key = value.slice(2, equals < 0 ? undefined : equals);
    if (!booleans.has(key) && !values.has(key)) throw new Error(`Unknown option: --${key}`);
    if (Object.hasOwn(parsed, key)) throw new Error(`Duplicate option: --${key}`);
    if (booleans.has(key)) {
      if (equals >= 0) throw new Error(`--${key} does not accept a value.`);
      parsed[key] = true;
      continue;
    }
    const next = equals < 0 ? argv[++index] : value.slice(equals + 1);
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    parsed[key] = next;
  }
  if (parsed._.length > 1) throw new Error("Only one subcommand is accepted; unexpected positional argument.");
  const allowed = {
    doctor: ["json"],
    snapshot: ["app-server-pid", "output", "json"],
    compare: ["before", "after", "json"],
    recover: ["app-server-pid", "output-dir", "thread-id", "yes", "id", "delay-seconds", "settle-seconds", "foreground"],
    "__recover-worker": ["app-server-pid", "output-dir", "id", "delay-seconds", "settle-seconds", "start-identity", "internal-test-mode"],
  };
  const command = parsed._[0];
  if (command && !allowed[command]) throw new Error(`Unknown command: ${command}`);
  for (const key of Object.keys(parsed)) {
    if (["_", "help", "version"].includes(key)) continue;
    if (!allowed[command]?.includes(key)) throw new Error(`--${key} is not valid for ${command || "the root command"}.`);
  }
  if (parsed["app-server-pid"] !== undefined) positivePid(parsed["app-server-pid"]);
  for (const [key, minimum] of [["delay-seconds", 5], ["settle-seconds", 1]]) {
    if (parsed[key] !== undefined && (!Number.isFinite(Number(parsed[key])) || Number(parsed[key]) < minimum || Number(parsed[key]) > 3600)) {
      throw new Error(`--${key} must be between ${minimum} and 3600 seconds.`);
    }
  }
  if (parsed.id !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(parsed.id)) {
    throw new Error("--id must be a filename-safe recovery identifier.");
  }
  return parsed;
}

function doctor() {
  const support = platformSupport();
  if (!support.SnapshotSupported) return { ...support, Status: "unsupported", RecoverySupported: false };
  try {
    const snapshot = createSnapshot();
    // An incomplete scan, including a sandbox's private process view, cannot support recovery.
    const visible = snapshot.Totals.ProcessScanComplete;
    return {
      ...support,
      Status: visible ? "ready" : "partial",
      RecoverySupported: visible,
      RecoveryRequiresApproval: true,
      AppServerTargets: snapshot.AppServers.length,
      Host: snapshot.Host,
      Warnings: snapshot.CollectionWarnings,
    };
  } catch (error) {
    return { ...support, Status: "unavailable", RecoverySupported: false, Error: error.message };
  }
}

function printSnapshot(report, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  console.log(`RAM Raccoon: ${report.Risk.Level}`);
  console.log(`Platform: ${report.Host.Platform}/${report.Host.Architecture}`);
  console.log(`Scope: ${report.Host.Environment}; ${report.Host.ProcessScope}`);
  console.log(
    `Physical: ${report.Host.PhysicalUsedGiB}/${report.Host.PhysicalTotalGiB} GiB (${report.Host.PhysicalPercent}%)`,
  );
  console.log(`Available RAM: ${report.Host.PhysicalAvailableGiB} GiB (${report.Host.PhysicalAvailabilityKind})`);
  if (report.Host.CommitPercent != null) {
    console.log(
      report.Host.CommitLimitEnforced
        ? `Commit: ${report.Host.CommittedGiB}/${report.Host.CommitLimitGiB} GiB (${report.Host.CommitPercent}%); available ${report.Host.CommitAvailableGiB} GiB`
        : `Commit accounting: ${report.Host.CommittedGiB}/${report.Host.CommitLimitGiB} GiB (${report.Host.CommitLimitEnforced === false ? "limit not enforced" : "enforcement unknown"}; not used as an exhaustion threshold)`,
    );
  } else {
    console.log("Commit: unavailable");
  }
  if (report.Host.Cgroup) {
    console.log(`Cgroup: smallest visible limit ${report.Host.Cgroup.MemoryLimitGiB} GiB; headroom ${report.Host.Cgroup.AvailableGiB} GiB; peak constraint usage ${report.Host.Cgroup.Percent}%`);
  }
  console.log(`Pressure: host ${report.Risk.HostLevel}; Codex app-server ${report.Risk.CodexLevel}`);
  console.log(
    `Codex app-server trees: ${report.Totals.CodexProcessCount} processes / ${report.Totals.MemoryGiB} GiB ${report.Totals.MemoryMetric}`,
  );
  console.log(report.Host.Platform === "win32"
    ? "Top system consumers (private bytes are not resident RAM):"
    : "Top system consumers (RSS; shared pages can be counted more than once):");
  for (const row of report.TopProcesses) {
    const services = row.Services?.map((service) => `${service.Name} (${service.DisplayName})`).join(", ");
    const resident = row.MemoryMetric === "RSS" ? "" : `; ${row.WorkingSetGiB} GiB resident`;
    console.log(
      `  ${row.Pid} ${row.Name}: ${row.MemoryGiB} GiB ${row.MemoryMetric}${resident}${services ? `; ${services}` : ""}`,
    );
  }
  for (const warning of report.CollectionWarnings) console.log(`Warning: ${warning}`);
  for (const recommendation of report.Recommendations) console.log(`Next: ${recommendation}`);
}

function sameProcessIdentity(actual, expectedIdentity) {
  return Boolean(actual && expectedIdentity && (actual.startIdentity || actual.startedAt) === expectedIdentity);
}


// Every orphan in a PID namespace is reparented to its init, and stopping it
// ends the whole namespace, so a namespace init is never a scoped recovery
// target, whether seen as PID 1 inside or through NSpid from outside.
function refuseNamespaceInit(pid, row) {
  if (Number(pid) === 1 || row?.namespaceInit) {
    throw new Error("Recovery refused: the target is a process-namespace init, such as a container entrypoint; stopping it ends every process in the namespace. Restart the container or sandbox instead.");
  }
}

async function terminateVerifiedTree(targetPid, expectedIdentity, onPlan = () => {}, beforeTree = [], settleMilliseconds = 1000) {
  refuseNamespaceInit(targetPid);
  const { rows, warnings } = processTable();
  if (warnings.length) throw new Error("Recovery refused: the process scan is incomplete.");
  const { byPid } = indexProcesses(rows);
  const target = byPid.get(Number(targetPid));
  if (!isAppServer(target) || !sameProcessIdentity(target, expectedIdentity)) {
    throw new Error("Recovery refused: the app-server PID or start identity changed.");
  }
  refuseNamespaceInit(targetPid, target);
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
  const family = processDepths(rows, targetPid);
  const eligible = family
    .filter((item) => item.pid !== process.pid)
    .filter((item) => {
      if (process.platform !== "win32") return true;
      const name = String(byPid.get(item.pid)?.name || "").toLowerCase();
      return !protectedWindowsHosts.has(name);
    });
  const root = eligible.filter((item) => item.pid === Number(targetPid));
  const rest = eligible
    .filter((item) => item.pid !== Number(targetPid))
    .sort((a, b) => b.depth - a.depth);
  // POSIX signals the root first so it can stop its children gracefully. On
  // Windows termination is immediate: children in a kill-on-close job object,
  // as libuv uses for non-detached children, would die with the root and free
  // their PIDs for reuse while the loop still signals them. Stop the root last.
  const ordered = process.platform === "win32" ? [...rest, ...root] : [...root, ...rest];
  if (ordered.some((item) => !(byPid.get(item.pid)?.startIdentity || byPid.get(item.pid)?.startedAt))) {
    throw new Error("Recovery refused: a descendant has no verifiable start identity.");
  }
  onPlan(
    ordered.map((item) => ({
      Pid: item.pid,
      Depth: item.depth,
      Name: byPid.get(item.pid)?.name || "unknown",
    })),
  );

  // A root this user cannot signal would keep running above stopped children.
  try {
    process.kill(Number(targetPid), 0);
  } catch (error) {
    if (error.code === "EPERM") throw new Error("Recovery refused: this user cannot signal the app-server; nothing was stopped.");
    if (error.code !== "ESRCH") throw error;
  }
  const attempted = [];
  const denied = new Set();
  const signal = (pid, name) => {
    try {
      process.kill(pid, name);
      return true;
    } catch (error) {
      // A process owned by another user refuses the signal; keep stopping the
      // rest of the plan and let the final scan count it as still running.
      if (error.code === "EPERM") denied.add(pid);
      else if (error.code !== "ESRCH") throw error;
      return false;
    }
  };
  // On Windows Node terminates the process outright, as Stop-Process -Force
  // did, without one slow PowerShell call per process on large trees.
  for (const item of ordered) {
    if (signal(item.pid, "SIGTERM")) attempted.push(item.pid);
  }
  const selectedPids = new Set(ordered.map((item) => item.pid));
  const replacement = (row) => {
    if (Number(row.pid) === process.pid || !selectedPids.has(Number(row.ppid))) return false;
    const original = byPid.get(Number(row.pid));
    return !original || !sameProcessIdentity(row, original.startIdentity || original.startedAt);
  };
  // POSIX reparents a child once its parent stops, so children started during
  // the grace period are recorded while their parents are still alive.
  const startedDuringGrace = [];
  if (process.platform !== "win32") {
    await sleep(2500);
    const escalation = processTable();
    if (escalation.warnings.length) throw new Error("Recovery stopped: the follow-up process scan is incomplete.");
    const remaining = indexProcesses(escalation.rows).byPid;
    for (const row of escalation.rows.filter(replacement)) startedDuringGrace.push([Number(row.pid), row.startIdentity || row.startedAt]);
    for (const item of ordered) {
      const original = byPid.get(item.pid);
      if (denied.has(item.pid) || !sameProcessIdentity(remaining.get(item.pid), original.startIdentity || original.startedAt)) continue;
      signal(item.pid, "SIGKILL");
    }
  }
  const signalsFinishedAt = Date.now();
  await sleep(settleMilliseconds);
  const after = processTable();
  if (after.warnings.length) throw new Error("Recovery result is unknown: the final process scan is incomplete.");
  const remaining = indexProcesses(after.rows).byPid;
  const survives = (pid) => {
    const original = byPid.get(pid);
    return sameProcessIdentity(remaining.get(pid), original.startIdentity || original.startedAt);
  };
  let stillRunning = 0;
  let excludedStillRunning = 0;
  for (const item of family) {
    if (!survives(item.pid)) continue;
    if (selectedPids.has(item.pid)) stillRunning += 1;
    else excludedStillRunning += 1;
  }
  // Before-snapshot members whose parent exited during the delay were no longer
  // in the tree, so they were never stopped and their memory was not released.
  const familyPids = new Set(family.map((item) => item.pid));
  const detachedStillRunning = beforeTree
    .filter((member) => !familyPids.has(member.Pid) && sameProcessIdentity(remaining.get(member.Pid), member.StartIdentity))
    .length;
  // A planned process still alive during the loop, such as a Windows root that
  // is stopped last, can start replacement children that were never planned.
  // Children started after the signals belong to a process that reused a PID.
  const spawned = new Set(after.rows.filter((row) => {
    const started = Date.parse(row.startedAt);
    const duringLoop = !Number.isFinite(started) || started <= signalsFinishedAt + 1000;
    return replacement(row) && duringLoop && !startedBeforeParent(row, byPid.get(Number(row.ppid)));
  }).map((row) => Number(row.pid)));
  for (const [pid, identity] of startedDuringGrace) {
    if (sameProcessIdentity(remaining.get(pid), identity)) spawned.add(pid);
  }
  const spawnedStillRunning = spawned.size;
  return {
    Attempted: attempted.length,
    Terminated: attempted.filter((pid) => !survives(pid)).length,
    PermissionDenied: denied.size,
    StillRunning: stillRunning,
    ExcludedStillRunning: excludedStillRunning,
    DetachedStillRunning: detachedStillRunning,
    SpawnedStillRunning: spawnedStillRunning,
  };
}

async function recoveryWorker(options) {
  const outputDirectory = path.resolve(options["output-dir"]);
  const id = options.id;
  const reportPath = path.join(outputDirectory, `${id}-recovery.json`);
  const beforePath = path.join(outputDirectory, `${id}-before.json`);
  const afterPath = path.join(outputDirectory, `${id}-after.json`);
  let state = JSON.parse(readFileSync(reportPath, "utf8"));
  // Only a job that `recover --yes` scheduled for this exact target can run.
  if (state.Status !== "scheduled" || state.Target?.AppServerPid !== Number(options["app-server-pid"]) || state.Target?.StartIdentity !== options["start-identity"]) {
    throw new Error("Recovery worker refused: no matching scheduled recovery.");
  }

  try {
    await sleep(Number(options["delay-seconds"]) * 1000);
    // The scheduling CLI marks the job failed when it cannot confirm this
    // worker started; a worker that did start then stands down.
    const current = JSON.parse(readFileSync(reportPath, "utf8"));
    if (current.Status !== "scheduled" || current.ScheduledAt !== state.ScheduledAt) return current;
    state.Status = "terminating";
    state.TerminationStartedAt = new Date().toISOString();
    writeJsonAtomic(reportPath, state);

    const termination = await terminateVerifiedTree(
      Number(options["app-server-pid"]),
      options["start-identity"],
      (plan) => {
        state.TerminationPlan = plan;
        writeJsonAtomic(reportPath, state);
      },
      state.BeforeTree || [],
      // Survivors are counted after the settle interval, not before it.
      Number(options["settle-seconds"]) * 1000,
    );
    state.Termination = termination;
    state.Status = "collecting_after";
    writeJsonAtomic(reportPath, state);
    const before = JSON.parse(readFileSync(beforePath, "utf8"));
    const after = lightweightRecoverySnapshot(before, termination);
    state.Status = "writing_after";
    writeJsonAtomic(reportPath, state);
    writeJsonAtomic(afterPath, after);
    state = {
      ...state,
      Status: termination.StillRunning === 0 && termination.DetachedStillRunning === 0 && termination.SpawnedStillRunning === 0
        ? "completed" : "partial",
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
      "Recovery terminates the selected app-server tree. Add --yes only after the user has explicitly approved this exact PID and the disconnect, with a resume checkpoint saved.",
    );
  }
  if (options.foreground && !TEST_MODE) {
    throw new Error("--foreground is reserved for the controlled test suite.");
  }

  const requestedPid = positivePid(options["app-server-pid"]);
  refuseNamespaceInit(requestedPid);
  const { report: before, trees } = collectSnapshot({
    appServerPid: requestedPid,
    requireTopLevel: true,
  });
  if (!before.Totals.ProcessScanComplete) throw new Error("Recovery refused: the process scan is incomplete.");
  if (before.AppServers.length !== 1) {
    throw new Error(
      "Recovery requires exactly one target. Pass --app-server-pid from the snapshot.",
    );
  }
  const target = before.AppServers[0];
  if (!target.StartIdentity) throw new Error("Recovery refused: the target has no verifiable start identity.");
  refuseNamespaceInit(requestedPid, trees.get(target.AppServerPid)?.[0]);
  // Refuse before announcing a disconnect that this user could not carry out.
  try {
    process.kill(requestedPid, 0);
  } catch (error) {
    if (error.code === "EPERM") throw new Error("Recovery refused: this user cannot signal the app-server; nothing was scheduled.");
    throw error;
  }
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
      StartIdentity: target.StartIdentity,
      ProcessCount: target.ProcessCount,
      MemoryMetric: target.MemoryMetric,
      MemoryGiB: target.MemoryGiB,
    },
    BeforeSnapshot: beforePath,
    AfterSnapshot: afterPath,
    BeforeTree: (trees.get(target.AppServerPid) || []).map((row) => ({
      Pid: Number(row.pid),
      StartIdentity: row.startIdentity || row.startedAt || null,
    })),
    CheckpointRequired: true,
    Resume: options["thread-id"]
      ? `codex resume ${options["thread-id"]}`
      : "Reopen the task in the Codex app, or run codex resume <session-id>.",
  };
  writeJsonAtomic(reportPath, state);

  const workerOptions = {
    _: ["__recover-worker"],
    "app-server-pid": String(target.AppServerPid),
    "start-identity": target.StartIdentity,
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
    "--start-identity",
    target.StartIdentity,
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
  let workerPid;
  try {
    workerPid = await spawnRecoveryWorker(workerArguments);
  } catch (error) {
    // The report must not stay "scheduled" without a worker. On Windows a
    // worker can exist even though its launch was not confirmed; it re-reads
    // the report after the delay and stands down. A worker that already moved
    // on owns the report.
    const confirmedAbsent = process.platform !== "win32" || error.status === 3;
    const current = JSON.parse(readFileSync(reportPath, "utf8"));
    if (current.Status === "scheduled" && current.ScheduledAt === state.ScheduledAt) {
      writeJsonAtomic(reportPath, {
        ...current,
        Status: "failed",
        FailedAt: new Date().toISOString(),
        Error: confirmedAbsent
          ? `The recovery worker did not start: ${error.message}`
          : `The recovery worker could not be confirmed (${error.message}); a worker that did start stands down without stopping anything.`,
      });
    }
    throw error;
  }
  // The member list stays in the report file; it would flood the caller's output.
  const { BeforeTree, ...summary } = state;
  return {
    ...summary,
    BeforeTreeProcesses: BeforeTree.length,
    WorkerPid: workerPid,
    ReportPath: reportPath,
    Message: `Recovery is scheduled in ${delaySeconds} seconds. This task will disconnect while the verified app-server tree stops; reopen or resume it afterward.`,
  };
}

function usage() {
  return `RAM Raccoon

Usage:
  ramraccoon doctor [--json]
  ramraccoon snapshot [--app-server-pid PID] [--json] [--output FILE]
  ramraccoon compare --before FILE --after FILE [--json]
  ramraccoon recover --app-server-pid PID --output-dir DIR [--thread-id ID] --yes
  ramraccoon --version

Snapshot and doctor are local and read-only. Native collectors: Windows,
macOS, Linux. Run inside WSL/containers to inspect that guest, not its host.
From a checkout: node skills/ramraccoon/scripts/ramraccoon.mjs <command>

Recovery is destructive to the selected live runtime. Checkpoint first. The
worker re-verifies the exact PID and start identity, terminates only that
app-server process tree, then writes termination evidence, not a memory
measurement. After resuming, take a full scoped snapshot and compare it with
the recovery's *-before.json.
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const command = options._[0];
  if (options.version) {
    console.log(VERSION);
    return;
  }
  if (!command || options.help) {
    process.stdout.write(usage());
    return;
  }

  if (command === "doctor") {
    const report = doctor();
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`RAM Raccoon doctor: ${report.Status}`);
      console.log(`${report.Platform}/${report.Architecture}, machine ${report.MachineArchitecture}, Node ${report.NodeVersion}`);
      console.log(report.Scope);
      if (report.Error) console.log(report.Error);
      for (const warning of report.Warnings || []) console.log(`Warning: ${warning}`);
      if (!report.SnapshotSupported) console.log("Use a Windows, macOS, or Linux host. Mobile/browser sandboxes are not native collection targets.");
    }
    if (report.Status !== "ready") process.exitCode = 2;
    return;
  }

  if (command === "snapshot") {
    const report = createSnapshot({
      appServerPid: options["app-server-pid"] === undefined ? 0 : positivePid(options["app-server-pid"]),
    });
    if (options.output) writeJsonAtomic(path.resolve(options.output), report);
    printSnapshot(report, options.json);
    return;
  }

  if (command === "compare") {
    if (!options.before || !options.after) {
      throw new Error("compare requires --before and --after.");
    }
    const result = compareSnapshots(readSnapshotFile(options.before), readSnapshotFile(options.after));
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      for (const [label, change] of [
        ["Codex memory", result.CodexMemoryGiB],
        ["Physical memory", result.PhysicalUsedGiB],
        ["System commit", result.CommittedGiB],
      ]) {
        const delta = change.Delta === null
          ? "unknown"
          : `${change.Delta >= 0 ? "+" : ""}${change.Delta}`;
        console.log(`${label}: ${change.Before ?? "unknown"} -> ${change.After ?? "unknown"} GiB (${delta})`);
      }
      console.log(`Measured Codex reduction: ${result.CodexMemoryGiB.Reclaimed ?? "unknown"} GiB`);
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

const isMain = process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH);
if (isMain) {
  main().catch((error) => {
    console.error(`RAM Raccoon error: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  classifyHostMemory,
  classifySnapshotRisk,
  hostRiskReasons,
  lightweightRecoverySnapshot,
  sameProcessIdentity,
  descendants,
  isAppServer,
  riskLevel,
  topMemoryConsumers,
  topLevelAppServers,
};
