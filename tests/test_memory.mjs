import assert from "node:assert/strict";
import test from "node:test";
import { compareSnapshots, lightweightRecoverySnapshot, riskLevel, topMemoryConsumers } from "../skills/ramraccoon/scripts/ramraccoon.mjs";

const GIB = 1024 ** 3;

function snapshot(memory, count, physical, committed, metric = "private bytes") {
  return {
    Host: { PhysicalUsedGiB: physical, CommittedGiB: committed },
    Totals: { MemoryGiB: memory, MemoryMetric: metric, CodexProcessCount: count },
  };
}

test("partial recovery cannot claim unknown memory or processes were released", () => {
  const before = snapshot(12, 240, 28, 90);
  const after = snapshot(null, null, 27, null);
  const result = compareSnapshots(before, after);
  assert.deepEqual(result.CodexMemoryGiB, {
    Metric: "private bytes", Before: 12, After: null, Delta: null, Reclaimed: null,
  });
  assert.deepEqual(result.CodexProcessCount, { Before: 240, After: null, Delta: null });
  assert.deepEqual(result.CommittedGiB, { Before: 90, After: null, Delta: null, Reclaimed: null });
  assert.equal(result.PhysicalUsedGiB.Delta, -1);
});

test("an observed zero is a measurement, not an unknown reading", () => {
  const result = compareSnapshots(snapshot(5, 8, 26, 60), snapshot(0, 0, 25, 50));
  assert.deepEqual(result.CodexMemoryGiB, {
    Metric: "private bytes", Before: 5, After: 0, Delta: -5, Reclaimed: 5,
  });
  assert.deepEqual(result.CodexProcessCount, { Before: 8, After: 0, Delta: -8 });
  assert.deepEqual(result.CommittedGiB, { Before: 60, After: 50, Delta: -10, Reclaimed: 10 });
});

test("memory growth has a positive delta and no claimed reduction", () => {
  const result = compareSnapshots(snapshot(3, 4, 20, 40), snapshot(4.25, 6, 22, 44));
  assert.equal(result.CodexMemoryGiB.Delta, 1.25);
  assert.equal(result.CodexMemoryGiB.Reclaimed, 0);
  assert.equal(result.CommittedGiB.Delta, 4);
  assert.equal(result.CommittedGiB.Reclaimed, 0);
});

test("missing measurements do not become zero in comparisons", () => {
  const result = compareSnapshots({}, snapshot(2, 3, 10, 20));
  for (const change of [result.CodexMemoryGiB, result.PhysicalUsedGiB, result.CommittedGiB]) {
    assert.equal(change.Before, null);
    assert.equal(change.Delta, null);
    assert.equal(change.Reclaimed, null);
  }
  assert.equal(result.CodexProcessCount.Delta, null);
});

test("an explicitly unknown primary metric cannot fall back to another measurement", () => {
  const after = snapshot(null, 1, 20, 40);
  after.Totals.WorkingSetGiB = 2;
  const result = compareSnapshots(snapshot(12, 30, 28, 90), after);
  assert.equal(result.CodexMemoryGiB.After, null);
  assert.equal(result.CodexMemoryGiB.Reclaimed, null);
});

test("legacy private-memory snapshots remain comparable", () => {
  const before = { Totals: { PrivateMemoryGiB: 6, WorkingSetGiB: 1 } };
  const after = { Totals: { PrivateMemoryGiB: 2, WorkingSetGiB: 1.5 } };
  const result = compareSnapshots(before, after);
  assert.equal(result.CodexMemoryGiB.Delta, -4);
  assert.equal(result.CodexMemoryGiB.Reclaimed, 4);
});

test("different memory metrics cannot produce a reclaimed-memory claim", () => {
  const result = compareSnapshots(
    snapshot(12, 30, 28, 90, "private bytes"),
    snapshot(3, 10, 20, null, "summed RSS"),
  );
  assert.equal(result.CodexMemoryGiB.Before, 12);
  assert.equal(result.CodexMemoryGiB.After, 3);
  assert.equal(result.CodexMemoryGiB.Delta, null);
  assert.equal(result.CodexMemoryGiB.Reclaimed, null);
});

test("Windows consumers rank private commit separately from resident memory", () => {
  const rows = [
    { pid: 1, name: "browser.exe", privateBytes: 2 * GIB, rssBytes: 3 * GIB },
    { pid: 2, name: "svchost.exe", privateBytes: 14 * GIB, rssBytes: GIB / 8 },
  ];
  const consumers = topMemoryConsumers(rows, "win32");
  assert.deepEqual(consumers.map((row) => row.Pid), [2, 1]);
  assert.equal(consumers[0].PrivateMemoryGiB, 14);
  assert.equal(consumers[0].WorkingSetGiB, 0.13);
  assert.deepEqual(rows.map((row) => row.pid), [1, 2]);
});

test("Unix consumers rank RSS without inventing private memory", () => {
  const rows = [
    { pid: 1, name: "browser", privateBytes: null, rssBytes: 3 * GIB },
    { pid: 2, name: "node", privateBytes: null, rssBytes: GIB / 8 },
  ];
  const consumers = topMemoryConsumers(rows, "linux");
  assert.deepEqual(consumers.map((row) => row.Pid), [1, 2]);
  assert.equal(consumers[0].MemoryGiB, 3);
  assert.equal(consumers[0].PrivateMemoryGiB, null);
});

test("the bounded consumer report excludes idle PID zero and private arguments", () => {
  const rows = Array.from({ length: 13 }, (_, pid) => ({
    pid, name: "node.exe", privateBytes: (14 - pid) * GIB, rssBytes: GIB,
    args: "--api-token=PRIVATE-ARGUMENT-SENTINEL",
    environment: { SECRET: "PRIVATE-ENVIRONMENT-SENTINEL" },
  }));
  const consumers = topMemoryConsumers(rows, "win32");
  assert.deepEqual(consumers.map((row) => row.Pid), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const encoded = JSON.stringify(consumers);
  assert.equal(encoded.includes("PRIVATE-ARGUMENT-SENTINEL"), false);
  assert.equal(encoded.includes("PRIVATE-ENVIRONMENT-SENTINEL"), false);
});

test("host pressure does not require a Codex process to cross a threshold", () => {
  for (const [percent, expected] of [[79.9, "HEALTHY"], [80, "ELEVATED"], [90, "HIGH"], [95, "CRITICAL"]]) {
    assert.equal(riskLevel(percent, 50, 0, 0), expected);
    assert.equal(riskLevel(null, percent, 0, 0), expected);
  }
  assert.equal(riskLevel(null, null, 0, 0), "HEALTHY");
});

test("a restricted process scan cannot claim that missing processes were freed", () => {
  const before = snapshot(12, 100, 28, 50);
  const after = snapshot(3, 20, 25, 48);
  after.Totals.ProcessScanComplete = false;
  const comparison = compareSnapshots(before, after);
  assert.equal(comparison.CodexMemoryGiB.Delta, null);
  assert.equal(comparison.CodexMemoryGiB.Reclaimed, null);
  assert.equal(comparison.CodexProcessCount.Delta, null);
  assert.equal(comparison.PhysicalUsedGiB.Delta, -3);
});

test("switching OS or app-server selection scope is not memory recovery", () => {
  const before = snapshot(12, 100, 28, 50);
  const after = snapshot(3, 20, 25, 48);
  before.Host.Platform = "linux";
  after.Host.Platform = "darwin";
  const crossPlatform = compareSnapshots(before, after);
  assert.equal(crossPlatform.CodexMemoryGiB.Reclaimed, null);
  assert.equal(crossPlatform.PhysicalUsedGiB.Reclaimed, null);
  after.Host.Platform = "linux";
  before.Scope = "all visible app-servers";
  after.Scope = "selected app-server";
  const crossScope = compareSnapshots(before, after);
  assert.equal(crossScope.CodexMemoryGiB.Reclaimed, null);
  assert.equal(crossScope.CodexProcessCount.Delta, null);
  assert.equal(crossScope.PhysicalUsedGiB.Delta, -3);
});

test("protected surviving descendants cannot become claimed reclaimed memory", () => {
  const before = snapshot(12, 240, 28, 90);
  const after = lightweightRecoverySnapshot(before, { StillRunning: 0, ExcludedStillRunning: 1 });
  const comparison = compareSnapshots(before, after);
  assert.equal(comparison.CodexMemoryGiB.Reclaimed, null);
  assert.equal(comparison.CodexProcessCount.Delta, null);
});
