import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Test mode lets the repository's fixtures stand in for app-servers. The flag
// carries it into the Windows worker, which does not inherit the environment.
export const TEST_MODE =
  process.env.RAMRACCOON_TEST_MODE === "1" ||
  (process.argv[2] === "__recover-worker" && process.argv.includes("--internal-test-mode"));

let cachedPowerShell;

export function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      windowsHide: true,
      // Collection is most needed when memory pressure makes it slow.
      timeout: 120000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch (error) {
    if (error.code !== "ETIMEDOUT") throw error;
    throw new Error(`${path.basename(command)} did not finish within 120 seconds; the system may be heavily loaded.`);
  }
}

// PowerShell encodes redirected output with the console code page, not UTF-8.
// ASCII-only JSON survives any code page, including ones whose multibyte
// characters contain a backslash byte. Constrained Language mode cannot turn a
// script block into a regex evaluator, so each distinct character is replaced.
export function asciiJson(expression) {
  return [
    `$json=${expression}`,
    "$seen=@{}",
    "foreach($match in [regex]::Matches($json, '[^\\u0000-\\u007F]')){ $code=[int][char]$match.Value; if(-not $seen.ContainsKey($code)){ $seen[$code]=$true; $json=$json.Replace($match.Value, ('\\u{0:x4}' -f $code)) } }",
    "$json",
  ].join("\n");
}

// PowerShell treats typographic single quotes as quote delimiters too.
export function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

// Windows looks up a bare program name in the current directory, and npx puts
// workspace node_modules\.bin folders first on PATH, so a planted pwsh.exe
// could run instead. Only fixed install locations are used.
function powershellCandidates() {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const candidates = [path.win32.join(programFiles, "PowerShell", "7", "pwsh.exe")];
  if (process.env.LOCALAPPDATA) candidates.push(path.win32.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe"));
  candidates.push(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  // A Store install's App Execution Alias is a link that stat() cannot follow.
  const present = (file) => {
    try {
      lstatSync(file);
      return true;
    } catch {
      return false;
    }
  };
  return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index && present(candidate));
}

export function powershellExecutable() {
  if (cachedPowerShell) return cachedPowerShell;
  let lastError;
  for (const candidate of powershellCandidates()) {
    try {
      run(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"]);
      cachedPowerShell = candidate;
      return candidate;
    } catch (error) {
      // Windows PowerShell remains usable when PowerShell 7 is not installed.
      lastError = error;
    }
  }
  if (["EPERM", "EACCES"].includes(lastError?.code)) {
    throw new Error(`PowerShell was found but could not be started (${lastError.code}); a sandbox, such as Codex's Windows sandbox, may block it. Run the check outside the sandbox.`);
  }
  if (lastError?.message.includes("did not finish")) throw lastError;
  throw new Error("Install PowerShell 7 (%ProgramFiles%\\PowerShell\\7 or the Microsoft Store) or restore Windows PowerShell (%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe) for Windows collection.");
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
        // Usage includes page cache the kernel reclaims before an OOM kill;
        // subtract inactive file pages, as docker stats and the kubelet do.
        const inactiveName = candidate.version === 2 ? "inactive_file" : "total_inactive_file";
        const stat = readText(path.posix.join(directory, "memory.stat")) || "";
        const inactive = Number(stat.match(new RegExp(`^${inactiveName} (\\d+)$`, "m"))?.[1] || 0);
        const used = Math.max(0, Number(rawUsage) - inactive);
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
    "$os=Get-CimInstance Win32_OperatingSystem -Property Caption,Version,TotalVisibleMemorySize,FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory",
    "$perf=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction SilentlyContinue",
    // Plain hashtables, unlike [pscustomobject], work in Constrained Language mode.
    "$memory=@{",
    " os=[string]$os.Caption; osVersion=[string]$os.Version",
    " totalBytes=[int64]$os.TotalVisibleMemorySize*1KB; freeBytes=[int64]$os.FreePhysicalMemory*1KB",
    // Without performance counters, the OS virtual-memory totals are the commit limit and headroom.
    " committedBytes=if($perf){[int64]$perf.CommittedBytes}elseif($os.TotalVirtualMemorySize){([int64]$os.TotalVirtualMemorySize-[int64]$os.FreeVirtualMemory)*1KB}else{$null}",
    " commitLimitBytes=if($perf){[int64]$perf.CommitLimit}elseif($os.TotalVirtualMemorySize){[int64]$os.TotalVirtualMemorySize*1KB}else{$null}",
    " commitFromOs=-not $perf",
    "}",
    asciiJson("ConvertTo-Json -InputObject $memory -Compress"),
  ].join("\n");
  const memory = JSON.parse(run(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", command]));
  return {
    ...memory,
    commitLimitEnforced: true,
    availabilityKind: "OS available memory",
    environment: "Windows host or guest",
    warnings: memory.committedBytes == null
      ? ["Windows commit counters are unavailable; commit pressure is unknown."]
      : memory.commitFromOs ? ["Windows performance counters were unavailable; commit was derived from operating-system virtual-memory totals."] : [],
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
  // A nested PID namespace without its own /proc shows the outer namespace's
  // PIDs, which differ from this process's and cannot be signalled from here.
  let procPid = process.pid;
  try {
    procPid = Number(readlinkSync("/proc/self"));
  } catch {
    // Without /proc/self, rely on PID 1 alone.
  }
  const sandboxed = procPid !== process.pid ||
    isSandboxInit(readOptional("/proc/1/comm", warnings), readOptional("/proc/1/cmdline", warnings));
  if (sandboxed) warnings.push("This check runs inside a bubblewrap sandbox, such as Codex's Linux sandbox or Flatpak, with a private process view; app-servers and other processes outside it are invisible. Run it outside the sandbox before drawing Codex or top-consumer conclusions.");
  const baseEnvironment = /microsoft/i.test(os.release()) ? "WSL guest" : existsSync("/.dockerenv") || existsSync("/run/.containerenv") ? "Linux container" : "Linux host or guest";
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
    environment: sandboxed ? `${baseEnvironment} (bubblewrap sandbox)` : baseEnvironment,
    processViewSandboxed: sandboxed,
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

// Bubblewrap gives commands a private PID namespace whose PID 1 is bwrap, or,
// with --as-pid-1 as Codex's Linux sandbox uses, Codex's own reaping helper.
export function isSandboxInit(comm, commandLine) {
  const argv = String(commandLine || "").split("\0").filter(Boolean);
  return String(comm || "").trim() === "bwrap" ||
    path.posix.basename(argv[0] || "") === "codex-linux-sandbox" ||
    argv.includes("--apply-seccomp-then-exec");
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
  // NSpid lists the PID in each nested namespace; a last entry of 1 is a
  // namespace init seen from outside, such as a container entrypoint.
  const namespacePids = status.match(/^NSpid:\s+(.+)$/m)?.[1].trim().split(/\s+/) || [];
  const argv = commandLine.split("\0").filter(Boolean);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+$/.test(fields[19] || "")) throw new Error("Linux process identity is unavailable.");
  return {
    pid,
    ppid: Number(fields[1]),
    namespaceInit: namespacePids.length > 1 && namespacePids.at(-1) === "1",
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
      // ps reports argv[0], which a process title such as npm's rewrites with its
      // arguments; outside an absolute path, keep only the first word.
      name: path.posix.basename(executable.startsWith("/") ? executable : executable.split(/\s+/)[0]), args, executable,
    });
  }
  return rows;
}

function macProcesses() {
  const metadata = run("ps", ["-ww", "-axo", "pid=,ppid=,rss=,lstart=,comm="]);
  const commands = run("ps", ["-ww", "-axo", "pid=,args="]);
  return { rows: parseMacProcesses(metadata, commands), warnings: [] };
}

// The MCP markers that markerCounts in ramraccoon.mjs looks for.
const COMMAND_MARKERS = ["chrome-devtools-mcp", "@playwright/mcp", "playwright-mcp", "@upstash/context7-mcp", "@sentry/mcp-server"];

// Codex rows in this check's own session whose command line came back empty.
// Elevated processes and other accounts in the session, such as Codex's
// Windows sandbox, hide it; other users' sessions are not this user's to classify.
export function codexRowsWithoutCommandLine(rows, ownPid = process.pid) {
  const ownSession = rows.find((row) => Number(row.pid) === ownPid)?.sessionId;
  return rows.filter((row) => /^codex(\.exe)?$/i.test(row.name || "") && !row.args &&
    (ownSession == null || row.sessionId === ownSession));
}

function windowsProcessDetails(pids) {
  const command = [
    "$ErrorActionPreference='Stop'",
    `$rows=@(Get-CimInstance Win32_Process -Filter '${pids.map((pid) => `ProcessId=${Number(pid)}`).join(" OR ")}' | ForEach-Object {`,
    " @{",
    "  pid=[int]$_.ProcessId; args=[string]$_.CommandLine",
    "  startedAt=if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}",
    " }",
    "})",
    asciiJson("ConvertTo-Json -InputObject $rows -Compress -Depth 3"),
  ].join("\n");
  return JSON.parse(run(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", command]));
}

function windowsProcesses() {
  // Only test mode keeps the fixtures' full command lines.
  // Every string a row is matched against is assembled at run time, so no
  // collector's command line, including one running concurrently, matches.
  const assembled = (value) => `(${quotePowerShellLiteral(value.slice(0, 4))}+${quotePowerShellLiteral(value.slice(4))})`;
  const fixture = TEST_MODE ? ` -or $commandLine -like ${assembled("*ramraccoon-test-app-server*")}` : "";
  const command = [
    "$ErrorActionPreference='Stop'",
    `$markers=@(${COMMAND_MARKERS.map(assembled).join(",")})`,
    "$rows=@(Get-CimInstance Win32_Process | ForEach-Object {",
    " $started=if($null -ne $_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null}",
    // Command lines can hold secrets, and PowerShell transcription can record
    // this output. Only Codex classification needs a full command line; other
    // processes carry just the markers they contain. This collector's own
    // command line holds the marker strings, so it carries nothing.
    " $commandLine=if($_.ProcessId -eq $PID){''}else{[string]$_.CommandLine}",
    ` $kept=if($_.Name -match '^codex(\\.exe)?$'${fixture}){$commandLine}else{($markers | Where-Object { $commandLine -like ('*' + $_ + '*') }) -join ' '}`,
    " @{",
    "  pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name; sessionId=[int]$_.SessionId",
    "  args=$kept; startedAt=$started; startIdentity=$started",
    "  rssBytes=[int64]$_.WorkingSetSize; privateBytes=[int64]$_.PrivatePageCount",
    " }",
    "})",
    asciiJson("ConvertTo-Json -InputObject $rows -Compress -Depth 3"),
  ].join("\n");
  // Windows keeps an exited parent's PID as ParentProcessId and later reuses it.
  const rows = JSON.parse(run(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", command]))
    .map((row) => ({ ...row, parentMayBeStale: true }));
  const warnings = [];
  // A low-integrity or app-container view leaves out System, PID 4.
  if (!rows.some((row) => Number(row.pid) === 4)) {
    warnings.push("The Windows process view is filtered (low integrity or an app container); higher-integrity processes, including Codex app-servers, are invisible and recovery is disabled.");
  }
  const suspects = codexRowsWithoutCommandLine(rows);
  let hidden = suspects.length;
  if (suspects.length) {
    try {
      // A process starting or exiting during the scan also has no command line.
      const current = new Map(windowsProcessDetails(suspects.map((row) => row.pid)).map((row) => [Number(row.pid), row]));
      hidden = 0;
      for (const row of suspects) {
        const now = current.get(Number(row.pid));
        if (!now || now.startedAt !== row.startedAt) rows.splice(rows.indexOf(row), 1);
        else if (now.args) row.args = now.args;
        else hidden += 1;
      }
    } catch {
      // Without a second reading, every suspect stays unreadable.
    }
  }
  if (hidden) {
    warnings.push(`${hidden} Codex process command lines in this session were unreadable (an elevated process, or another account such as Codex's Windows sandbox); app-server detection is incomplete and recovery is disabled.`);
  }
  return { rows, warnings };
}

export function processTable() {
  requireSupportedPlatform();
  if (process.platform === "win32") return windowsProcesses();
  if (process.platform === "linux") return linuxProcesses();
  return macProcesses();
}
