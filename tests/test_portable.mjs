import assert from "node:assert/strict";
import test from "node:test";

process.env.RAMRACCOON_TEST_MODE = "1";
const {
  compareSnapshots,
  descendants,
  isAppServer,
  riskLevel,
  topLevelAppServers,
} = await import("../skills/ramraccoon/scripts/ramraccoon.mjs");

const rows = [
  { pid: 10, ppid: 1, name: "codex", args: "codex app-server", startedAt: "a" },
  { pid: 11, ppid: 10, name: "node", args: "node mcp-server", startedAt: "b" },
  { pid: 12, ppid: 11, name: "codex", args: "codex app-server --stdio", startedAt: "c" },
  { pid: 20, ppid: 1, name: "codex", args: "codex exec", startedAt: "d" },
];

test("finds only top-level app-servers", () => {
  assert.equal(isAppServer(rows[0]), true);
  assert.equal(isAppServer(rows[3]), false);
  assert.deepEqual(topLevelAppServers(rows).map((row) => row.pid), [10]);
});

test("walks a bounded process tree", () => {
  assert.deepEqual(descendants(rows, 10).map((row) => row.pid), [10, 11, 12]);
});

test("risk thresholds are deterministic", () => {
  assert.equal(riskLevel(0, 20, 1, 10), "HEALTHY");
  assert.equal(riskLevel(80, 20, 1, 10), "ELEVATED");
  assert.equal(riskLevel(90, 20, 1, 10), "HIGH");
  assert.equal(riskLevel(95, 20, 1, 10), "CRITICAL");
});

test("comparison reports raw values, delta, and reclaimed memory", () => {
  const before = {
    Timestamp: "before",
    Host: { Platform: "linux", Architecture: "arm64", PhysicalUsedGiB: 12 },
    Totals: { CodexProcessCount: 100, MemoryMetric: "summed RSS", MemoryGiB: 8 },
  };
  const after = {
    Timestamp: "after",
    Host: { Platform: "linux", Architecture: "arm64", PhysicalUsedGiB: 6 },
    Totals: { CodexProcessCount: 20, MemoryMetric: "summed RSS", MemoryGiB: 2 },
  };
  const result = compareSnapshots(before, after);
  assert.equal(result.Architecture, "arm64");
  assert.equal(result.CodexMemoryGiB.Delta, -6);
  assert.equal(result.CodexMemoryGiB.Reclaimed, 6);
  assert.equal(result.PhysicalUsedGiB.Reclaimed, 6);
});
