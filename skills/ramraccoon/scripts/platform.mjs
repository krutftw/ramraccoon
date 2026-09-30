import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

let cachedPowerShell;

export function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
}

export function powershellExecutable() {
  if (cachedPowerShell) return cachedPowerShell;
  for (const candidate of ["pwsh.exe", "powershell.exe"]) {
    try {
      run(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
      cachedPowerShell = candidate;
      return candidate;
    } catch {
      // Windows PowerShell remains usable when PowerShell 7 is not installed.
    }
  }
  throw new Error("Install PowerShell or make powershell.exe available on PATH for Windows collection.");
}

export function platformSupport(platform = process.platform) {
  return {
    Platform: platform,
    Architecture: process.arch,
    MachineArchitecture: os.machine(),
    NodeVersion: process.versions.node,
    SnapshotSupported: ["win32", "darwin", "linux"].includes(platform),
    CompareSupported: true,
    Scope: "The machine or guest running this command, and processes visible to its current user.",
  };
}

function requireSupportedPlatform() {
  if (!platformSupport().SnapshotSupported) {
    throw new Error(`Local memory collection is not supported on ${process.platform}. Use Windows, macOS, or Linux with Node 20+. Browser/mobile sandboxes do not expose these host APIs. Comparing saved reports does not require host collection.`);
  }
}

function readOptional(file, warnings) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) {
      warnings.push(`An optional operating-system memory reading was unavailable (${error.code || "read error"}).`);
    }
    return null;
  }
}

export function parseMeminfo(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+(\d+)\s+kB$/);
    if (match) result.set(match[1], Number(match[2]) * 1024);
  }
  return result;
}

const decodeMountPath = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));

export function resolveCgroupMounts(membershipText, mountText) {
  const memberships = membershipText.trim().split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(\d+):([^:]*):(\/.*)$/);
    if (!match) return [];
    const version = match[2] === "" ? 2 : match[2].split(",").includes("memory") ? 1 : null;
    return version ? [{ version, member: match[3] }] : [];
  });
  const result = [];
  for (const line of mountText.trim().split(/\r?\n/)) {
    const [before, after] = line.split(" - ");
    if (!after) continue;
    const fields = before.split(" ");
    const [type, , options] = after.split(" ");
    const version = type === "cgroup2" ? 2 : type === "cgroup" && options?.split(",").includes("memory") ? 1 : null;
    if (!version) continue;
    const root = decodeMountPath(fields[3] || "");
    const mount = decodeMountPath(fields[4] || "");
    for (const membership of memberships.filter((item) => item.version === version)) {
      if (membership.member.split("/").includes("..")) continue;
      if (root !== "/" && membership.member !== "/" && membership.member !== root && !membership.member.startsWith(`${root}/`)) continue;
      const relative = membership.member === "/" ? "" : root === "/" ? membership.member.slice(1) : membership.member.slice(root.length).replace(/^\//, "");
      result.push({ version, mount, directory: path.posix.join(mount, relative) });
    }
  }
  return result;
}

export function collectCgroupMemory(memberships, mounts, readText) {
  const constraints = [];
  for (const candidate of resolveCgroupMounts(memberships, mounts)) {
    let directory = candidate.directory;
    while (directory === candidate.mount || directory.startsWith(`${candidate.mount}/`)) {
      const limitName = candidate.version === 2 ? "memory.max" : "memory.limit_in_bytes";
      const usageName = candidate.version === 2 ? "memory.current" : "memory.usage_in_bytes";
      const rawLimit = readText(path.posix.join(directory, limitName))?.trim();
      const rawUsage = readText(path.posix.join(directory, usageName))?.trim();
      if (/^\d+$/.test(rawLimit || "") && /^\d+$/.test(rawUsage || "")) {
        const limit = BigInt(rawLimit);
        const used = Number(rawUsage);
        // v1 uses a page-aligned LONG_MAX sentinel for an unlimited controller.
        if (limit > 0n && limit < 2n ** 60n && Number.isSafeInteger(used)) {
          const limitBytes = Number(limit);
          constraints.push({
            version: candidate.version,
            limitBytes,
            usedBytes: used,
            availableBytes: Math.max(0, limitBytes - used),
            percent: used / limitBytes * 100,
          });
        }
      }
      if (directory === candidate.mount) break;
      directory = path.posix.dirname(directory);
    }
  }
  if (!constraints.length) return null;
  return {
    limitBytes: Math.min(...constraints.map((item) => item.limitBytes)),
    availableBytes: Math.min(...constraints.map((item) => item.availableBytes)),
    percent: Math.max(...constraints.map((item) => item.percent)),
    constraints,
  };
}

export function parseMacMemory(vmStat, totalBytes) {
  const pageSize = Number(vmStat.match(/page size of (\d+) bytes/i)?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) throw new Error("vm_stat did not report its page size.");
  const pages = new Map();
  for (const line of vmStat.split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+(\d+)\./);
    if (match) pages.set(match[1], Number(match[2]));
  }
  if (!pages.has("Pages free")) throw new Error("vm_stat did not report free pages.");
  // Purgeable pages overlap other VM categories; never add them a second time.
  const available = (pages.get("Pages free") + (pages.get("Pages inactive") || 0) + (pages.get("Pages speculative") || 0)) * pageSize;
  return Math.min(totalBytes, available);
}

export function parseSwapUsage(text) {
  const bytes = (name) => {
    const match = text.match(new RegExp(`${name}\\s*=\\s*([\\d.]+)([BKMGT])`, "i"));
    return match ? Number(match[1]) * 1024 ** "BKMGT".indexOf(match[2].toUpperCase()) : null;
  };
  return { totalBytes: bytes("total"), freeBytes: bytes("free") };
}

function windowsHostMemory() {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$os=Get-CimInstance Win32_OperatingSystem",
    "$perf=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction SilentlyContinue",
    "[pscustomobject]@{",
    " os=[string]$os.Caption; osVersion=[string]$os.Version",
    " totalBytes=[int64]$os.TotalVisibleMemorySize*1KB; freeBytes=[int64]$os.FreePhysicalMemory*1KB",
    " committedBytes=if($perf){[int64]$perf.CommittedBytes}else{$null}",
    " commitLimitBytes=if($perf){[int64]$perf.CommitLimit}else{$null}",
    "} | ConvertTo-Json -Compress",
  ].join("\n");
  const memory = JSON.parse(run(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", command]));
  return {
    ...memory,
    commitLimitEnforced: true,
    availabilityKind: "OS available memory",
    environment: "Windows host or guest",
    warnings: memory.committedBytes == null ? ["Windows commit counters are unavailable; commit pressure is unknown."] : [],
  };
}

function linuxHostMemory() {
  const warnings = [];
  const values = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
  const totalBytes = values.get("MemTotal");
  if (!totalBytes) throw new Error("Linux /proc/meminfo did not report total memory.");
  const rawMode = readOptional("/proc/sys/vm/overcommit_memory", warnings)?.trim();
  const overcommitMode = /^[012]$/.test(rawMode || "") ? Number(rawMode) : null;
  const memberships = readOptional("/proc/self/cgroup", warnings);
  const mounts = readOptional("/proc/self/mountinfo", warnings);
  const cgroup = memberships != null && mounts != null
    ? collectCgroupMemory(memberships, mounts, (file) => readOptional(file, warnings))
    : null;
  let freeBytes = values.get("MemAvailable");
  if (freeBytes == null) {
    freeBytes = values.get("MemFree");
    warnings.push("MemAvailable is unavailable; free pages alone underestimate reclaimable Linux memory.");
  }
  if (freeBytes == null) throw new Error("Linux /proc/meminfo did not report available or free memory.");
  if (overcommitMode == null) warnings.push("Linux overcommit policy is unavailable; commit pressure is not classified.");
  if (memberships == null || mounts == null) warnings.push("Cgroup limits could not be inspected; guest/process limits may be lower than host memory.");
  return {
    os: `${os.type()} ${os.release()}`,
    osVersion: os.release(),
    totalBytes,
    freeBytes,
    committedBytes: values.get("Committed_AS") ?? null,
    commitLimitBytes: values.get("CommitLimit") ?? null,
    commitLimitEnforced: overcommitMode == null ? null : overcommitMode === 2,
    overcommitMode,
    swapTotalBytes: values.get("SwapTotal") ?? null,
    swapFreeBytes: values.get("SwapFree") ?? null,
    availabilityKind: values.has("MemAvailable") ? "OS available memory" : "free pages only",
    environment: /microsoft/i.test(os.release()) ? "WSL guest" : existsSync("/.dockerenv") || existsSync("/run/.containerenv") ? "Linux container" : "Linux host or guest",
    cgroup,
    warnings,
  };
}

function macHostMemory() {
  const totalBytes = Number(run("sysctl", ["-n", "hw.memsize"]).trim());
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) throw new Error("macOS did not report total memory.");
  const freeBytes = parseMacMemory(run("vm_stat", []), totalBytes);
  const warnings = ["macOS available memory is a VM-page estimate, not an allocation guarantee."];
  let swap = { totalBytes: null, freeBytes: null };
  try {
    swap = parseSwapUsage(run("sysctl", ["-n", "vm.swapusage"]));
  } catch {
    warnings.push("macOS swap counters are unavailable.");
  }
  let pressure = null;
  try {
    pressure = ({ 1: "HEALTHY", 2: "HIGH", 4: "CRITICAL" })[run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).trim()] || null;
  } catch {
    // Older/restricted kernels may not expose the memory-pressure level.
  }
  return {
    os: `${os.type()} ${os.release()}`,
    osVersion: os.release(),
    totalBytes,
    freeBytes,
    committedBytes: null,
    commitLimitBytes: null,
    commitLimitEnforced: null,
    swapTotalBytes: swap.totalBytes,
    swapFreeBytes: swap.freeBytes,
    availabilityKind: "VM-page estimate",
    environment: "macOS host or guest",
    memoryPressure: pressure,
    warnings,
  };
}

export function hostMemory() {
  requireSupportedPlatform();
  if (process.platform === "win32") return windowsHostMemory();
  if (process.platform === "linux") return linuxHostMemory();
  return macHostMemory();
}

export function parseLinuxProcess(stat, status, commandLine, bootId) {
  const open = stat.indexOf("(");
  const close = stat.lastIndexOf(")");
  if (open < 1 || close < open) throw new Error("Malformed Linux process stat.");
  const pid = Number(stat.slice(0, open).trim());
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  const argv = commandLine.split("\0").filter(Boolean);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(fields[19] || "")) throw new Error("Linux process identity is unavailable.");
  return {
    pid,
    ppid: Number(fields[1]),
    name: stat.slice(open + 1, close),
    args: argv.join(" "),
    argv,
    startedAt: null,
    startIdentity: `${bootId}:${fields[19]}`,
    rssBytes: rss ? Number(rss[1]) * 1024 : 0,
    privateBytes: null,
    state: fields[0],
  };
}

function linuxProcesses() {
  const rows = [];
  const warnings = [];
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  let restricted = 0;
  for (const directory of readdirSync("/proc")) {
    if (!/^\d+$/.test(directory)) continue;
    try {
      const root = `/proc/${directory}`;
      const row = parseLinuxProcess(
        readFileSync(`${root}/stat`, "utf8"),
        readFileSync(`${root}/status`, "utf8"),
        readFileSync(`${root}/cmdline`, "utf8"),
        bootId,
      );
      if (!["Z", "X"].includes(row.state)) rows.push(row);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes(error.code)) continue;
      if (["EACCES", "EPERM"].includes(error.code)) restricted += 1;
      else throw error;
    }
  }
  if (restricted) warnings.push(`${restricted} process records were inaccessible; process totals are incomplete and recovery is disabled.`);
  return { rows, warnings };
}

export function parseMacProcesses(metadata, commands) {
  const argsByPid = new Map();
  for (const line of commands.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (match) argsByPid.set(Number(match[1]), match[2]);
  }
  const rows = [];
  for (const line of metadata.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$/);
    if (!match) throw new Error("macOS ps returned an unrecognized process record; refusing an incomplete scan.");
    const started = new Date(match[4]);
    if (!Number.isFinite(started.getTime())) throw new Error("macOS process start time could not be parsed.");
    const pid = Number(match[1]);
    const executable = match[5];
    const args = argsByPid.get(pid) || "";
    rows.push({
      pid, ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024,
      privateBytes: null, startedAt: started.toISOString(), startIdentity: started.toISOString(),
      name: path.posix.basename(executable), args, executable,
    });
  }
  return rows;
}

function macProcesses() {
  const metadata = run("ps", ["-ww", "-axo", "pid=,ppid=,rss=,lstart=,comm="]);
  const commands = run("ps", ["-ww", "-axo", "pid=,args="]);
  return { rows: parseMacProcesses(metadata, commands), warnings: [] };
}

function windowsProcesses() {
  const command = [
    "$ErrorActionPreference='Stop'",
    "$rows=@(Get-CimInstance Win32_Process | ForEach-Object {",
    " $started=if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}",
    " [pscustomobject]@{",
    "  pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name",
    "  args=[string]$_.CommandLine; startedAt=$started; startIdentity=$started",
    "  rssBytes=[int64]$_.WorkingSetSize; privateBytes=[int64]$_.PrivatePageCount",
    " }",
    "})",
    "ConvertTo-Json -InputObject $rows -Compress -Depth 3",
  ].join("\n");
  return {
    rows: JSON.parse(run(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", command])),
    warnings: [],
  };
}

export function processTable() {
  requireSupportedPlatform();
  if (process.platform === "win32") return windowsProcesses();
  if (process.platform === "linux") return linuxProcesses();
  return macProcesses();
}
