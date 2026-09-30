import assert from "node:assert/strict";
import test from "node:test";
import { classifyHostMemory, sameProcessIdentity } from "../skills/ramraccoon/scripts/ramraccoon.mjs";
import { collectCgroupMemory, parseLinuxProcess, parseMacMemory, parseMacProcesses, parseMeminfo, parseSwapUsage, platformSupport, resolveCgroupMounts } from "../skills/ramraccoon/scripts/platform.mjs";

const GIB = 1024 ** 3;
const host = { totalBytes: 16 * GIB, freeBytes: 8 * GIB, committedBytes: 24 * GIB, commitLimitBytes: 8 * GIB };

test("Linux heuristic and always-overcommit accounting cannot trigger commit exhaustion", () => {
  assert.equal(classifyHostMemory({ ...host, commitLimitEnforced: false }), "HEALTHY");
  assert.equal(classifyHostMemory({ ...host, commitLimitEnforced: null }), "HEALTHY");
  assert.equal(classifyHostMemory({ ...host, commitLimitEnforced: true }), "CRITICAL");
});

test("a cgroup can be exhausted while the underlying host has free RAM", () => {
  assert.equal(classifyHostMemory({ ...host, commitLimitEnforced: false, cgroup: { percent: 97 } }), "CRITICAL");
});

test("reported macOS kernel pressure takes precedence over VM-page estimates", () => {
  assert.equal(classifyHostMemory({ ...host, freeBytes: GIB / 10, memoryPressure: "HEALTHY" }), "HEALTHY");
  assert.equal(classifyHostMemory({ ...host, memoryPressure: "HIGH" }), "HIGH");
});

test("zero Linux availability and swap are retained as actual readings", () => {
  const values = parseMeminfo("MemTotal: 1024 kB\nMemAvailable: 0 kB\nMemFree: 128 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n");
  assert.equal(values.get("MemAvailable"), 0);
  assert.equal(values.get("MemTotal"), 1024 * 1024);
  assert.equal(values.get("SwapTotal"), 0);
});

const mountV2 = "36 25 0:32 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw";

test("cgroup v2 checks ancestors even when the leaf is unlimited", () => {
  const files = new Map([
    ["/sys/fs/cgroup/group/app/memory.max", "max"],
    ["/sys/fs/cgroup/group/app/memory.current", String(GIB / 4)],
    ["/sys/fs/cgroup/group/memory.max", String(GIB)],
    ["/sys/fs/cgroup/group/memory.current", String(GIB * 0.9375)],
  ]);
  const group = collectCgroupMemory("0::/group/app", mountV2, (file) => files.get(file) ?? null);
  assert.equal(group.limitBytes, GIB);
  assert.equal(group.availableBytes, GIB / 16);
  assert.equal(group.percent, 93.75);
});

test("cgroup headroom and peak pressure account for different limiting ancestors", () => {
  const files = new Map([
    ["/sys/fs/cgroup/a/b/memory.max", String(GIB)],
    ["/sys/fs/cgroup/a/b/memory.current", String(GIB / 2)],
    ["/sys/fs/cgroup/a/memory.max", String(100 * GIB)],
    ["/sys/fs/cgroup/a/memory.current", String(99 * GIB)],
  ]);
  const group = collectCgroupMemory("0::/a/b", mountV2, (file) => files.get(file) ?? null);
  assert.equal(group.availableBytes, GIB / 2);
  assert.equal(group.percent, 99);
});

test("hybrid cgroups retain a v1 memory controller and its unlimited sentinel", () => {
  const mounts = `${mountV2}\n40 25 0:36 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory`;
  const files = new Map([
    ["/sys/fs/cgroup/memory/job/memory.limit_in_bytes", String(2 * GIB)],
    ["/sys/fs/cgroup/memory/job/memory.usage_in_bytes", String(GIB)],
    ["/sys/fs/cgroup/memory/memory.limit_in_bytes", "9223372036854771712"],
    ["/sys/fs/cgroup/memory/memory.usage_in_bytes", String(8 * GIB)],
  ]);
  const group = collectCgroupMemory("0::/job\n5:memory:/job", mounts, (file) => files.get(file) ?? null);
  assert.equal(group.constraints[0].version, 1);
  assert.equal(group.limitBytes, 2 * GIB);
  assert.equal(group.availableBytes, GIB);
});

test("cgroup mount roots and escaped mount paths stay inside the visible hierarchy", () => {
  const mounts = "40 25 0:36 /tenant /sys/fs/cgroup\\040memory rw - cgroup cgroup rw,memory";
  assert.deepEqual(resolveCgroupMounts("5:memory:/tenant/job", mounts), [
    { version: 1, mount: "/sys/fs/cgroup memory", directory: "/sys/fs/cgroup memory/job" },
  ]);
  assert.deepEqual(resolveCgroupMounts("5:memory:/different/job", mounts), []);
});

test("unlimited or unavailable cgroups do not fabricate a memory limit", () => {
  assert.equal(collectCgroupMemory("0::/", mountV2, () => null), null);
  assert.equal(collectCgroupMemory("0::/", mountV2, (file) => file.endsWith("memory.max") ? "max" : "100"), null);
});

test("macOS ARM page sizes are respected without adding overlapping purgeable pages", () => {
  const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.\nPages speculative: 5.\nPages purgeable: 19.\n";
  assert.equal(parseMacMemory(vm, GIB), 35 * 16384);
  assert.equal(parseMacMemory(vm.replace("16384", "4096"), GIB), 35 * 4096);
  assert.throws(() => parseMacMemory("Pages free: 10.", GIB));
});

test("macOS swap supports large units without inventing missing counters", () => {
  assert.deepEqual(parseSwapUsage("total = 1.00T used = 512.00G free = 512.00G"), { totalBytes: 1024 * GIB, freeBytes: 512 * GIB });
  assert.deepEqual(parseSwapUsage("unavailable"), { totalBytes: null, freeBytes: null });
});

test("macOS process names containing spaces do not consume command arguments", () => {
  const rows = parseMacProcesses(
    " 12 1 2048 Wed Sep 30 08:30:00 2026 /Applications/Codex Beta.app/Contents/MacOS/codex\n",
    " 12 /Applications/Codex Beta.app/Contents/MacOS/codex app-server --stdio\n",
  );
  assert.equal(rows[0].name, "codex");
  assert.equal(rows[0].rssBytes, 2 * 1024 * 1024);
  assert.equal(rows[0].executable, "/Applications/Codex Beta.app/Contents/MacOS/codex");
});

test("unparseable macOS process records fail closed instead of disappearing", () => {
  assert.throws(() => parseMacProcesses("12 1 2048 date-not-parseable codex", "12 codex app-server"));
});

function linuxStat(pid, start, name = "codex") {
  const fields = Array(22).fill("0");
  fields[0] = "S";
  fields[1] = "1";
  fields[19] = String(start);
  return `${pid} (${name}) ${fields.join(" ")}`;
}

test("Linux birth identity survives names with parentheses and preserves argv boundaries", () => {
  const row = parseLinuxProcess(linuxStat(12, 12345, "node (worker)"), "VmRSS:\t1024 kB\n", "/usr/bin/node\0--title\0app-server prompt\0", "boot-a");
  assert.equal(row.name, "node (worker)");
  assert.equal(row.startIdentity, "boot-a:12345");
  assert.equal(row.rssBytes, 1024 * 1024);
  assert.deepEqual(row.argv, ["/usr/bin/node", "--title", "app-server prompt"]);
});

test("PID reuse and host reboot invalidate a previously recorded identity", () => {
  const before = parseLinuxProcess(linuxStat(12, 100), "VmRSS: 0 kB", "codex\0app-server\0", "boot-a");
  const reused = parseLinuxProcess(linuxStat(12, 101), "VmRSS: 0 kB", "codex\0app-server\0", "boot-a");
  const rebooted = parseLinuxProcess(linuxStat(12, 100), "VmRSS: 0 kB", "codex\0app-server\0", "boot-b");
  assert.equal(sameProcessIdentity(before, before.startIdentity), true);
  assert.equal(sameProcessIdentity(reused, before.startIdentity), false);
  assert.equal(sameProcessIdentity(rebooted, before.startIdentity), false);
  assert.equal(sameProcessIdentity({ pid: 12 }, null), false);
});

test("unsupported device runtimes remain explicit while saved-report comparison stays available", () => {
  for (const platform of ["android", "freebsd", "openbsd", "sunos", "aix"]) {
    const support = platformSupport(platform);
    assert.equal(support.SnapshotSupported, false);
    assert.equal(support.CompareSupported, true);
  }
});

test("a cgroup namespace root resolves to its mounted subtree", () => {
  const mounts = "40 25 0:36 /tenant/job /sys/fs/cgroup rw - cgroup2 cgroup rw";
  assert.deepEqual(resolveCgroupMounts("0::/", mounts), [
    { version: 2, mount: "/sys/fs/cgroup", directory: "/sys/fs/cgroup" },
  ]);
});
