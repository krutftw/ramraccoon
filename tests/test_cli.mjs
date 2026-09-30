import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../skills/ramraccoon/scripts/ramraccoon.mjs", import.meta.url));
const invoke = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 30000, windowsHide: true });

test("ambiguous recovery commands fail without creating a recovery job", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ramraccoon-rejected-"));
  try {
    for (const args of [
      ["recover", "--yes"],
      ["recover", "--yes=false", "--app-server-pid", "10"],
      ["recover", "--yes", "--app-server-pid", "0"],
      ["recover", "--yes", "--app-server-pid", "-1"],
      ["recover", "--yes", "--app-server-pid", "1.5"],
      ["recover", "--yes", "--appserver-pid", "10"],
      ["recover", "--yes", "--app-server-pid", "10", "--app-server-pid", "20"],
      ["recover", "--yes", "--app-server-pid", "10", "--delay-seconds", "NaN"],
    ]) {
      const result = invoke([...args, "--output-dir", directory]);
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout} ${result.stderr}`);
      assert.deepEqual(readdirSync(directory), []);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("snapshot typos and invalid selectors cannot silently change selection scope", () => {
  for (const args of [
    ["snapshot", "--app-server-pid", "0"],
    ["snapshot", "--app-server-pid", "not-a-pid"],
    ["snapshot", "--jsno"],
    ["snapshot", "--yes"],
    ["snapshot", "surprise"],
  ]) {
    assert.equal(invoke(args).status, 1, args.join(" "));
  }
});

test("a saved partial report stays unknown through the actual comparison CLI", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ramraccoon-compare-"));
  try {
    const before = path.join(directory, "before.json");
    const after = path.join(directory, "after.json");
    writeFileSync(before, JSON.stringify({ Totals: { MemoryGiB: 12, CodexProcessCount: 240, MemoryMetric: "private bytes" } }));
    writeFileSync(after, JSON.stringify({ Totals: { MemoryGiB: null, CodexProcessCount: null, MemoryMetric: "private bytes" } }));
    const result = invoke(["compare", `--before=${before}`, `--after=${after}`, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const comparison = JSON.parse(result.stdout);
    assert.equal(comparison.CodexMemoryGiB.Reclaimed, null);
    assert.equal(comparison.CodexProcessCount.Delta, null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a symlinked package executable actually runs the requested comparison", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ramraccoon-entrypoint-"));
  try {
    const link = path.join(directory, "ramraccoon.mjs");
    try {
      symlinkSync(cli, link, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) {
        t.skip("This account cannot create file symlinks.");
        return;
      }
      throw error;
    }
    const before = path.join(directory, "before.json");
    const after = path.join(directory, "after.json");
    writeFileSync(before, JSON.stringify({ Totals: { MemoryGiB: 12, MemoryMetric: "summed RSS" } }));
    writeFileSync(after, JSON.stringify({ Totals: { MemoryGiB: 3, MemoryMetric: "summed RSS" } }));
    const result = spawnSync(process.execPath, [link, "compare", "--before", before, "--after", after, "--json"], { encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).CodexMemoryGiB.Delta, -9);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
