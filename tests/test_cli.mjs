import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CLI_TIMEOUT, environment, startFixture, stopFixture } from "./fixture-support.mjs";

const cli = fileURLToPath(new URL("../skills/ramraccoon/scripts/ramraccoon.mjs", import.meta.url));
const invoke = (args, env = process.env, timeout = 30000) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout, windowsHide: true });

test("ambiguous recovery commands fail without creating a recovery job", async () => {
  // Against a live test-mode target, only validation stands between these commands and a job.
  const fixture = await startFixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), "ramraccoon-rejected-"));
  try {
    const pid = String(fixture.pid);
    // A full process scan is slow on a busy Windows host.
    const control = invoke(["snapshot", "--app-server-pid", pid, "--json"], environment, CLI_TIMEOUT);
    assert.equal(control.status, 0, `${control.stderr} ${control.error ?? ""}`);
    for (const args of [
      ["recover", "--yes"],
      ["recover", "--app-server-pid", pid],
      ["recover", "--yes=false", "--app-server-pid", pid],
      ["recover", "--yes", "--app-server-pid", "0"],
      ["recover", "--yes", "--app-server-pid", "-1"],
      ["recover", "--yes", "--app-server-pid", "1.5"],
      ["recover", "--yes", "--appserver-pid", pid],
      ["recover", "--yes", "--app-server-pid", pid, "--app-server-pid", String(fixture.childPid)],
      ["recover", "--yes", "--app-server-pid", pid, "--delay-seconds", "NaN"],
      ["recover", "--yes", "--app-server-pid", pid, "--internal-test-mode"],
    ]) {
      const result = invoke([...args, "--output-dir", directory], environment);
      assert.equal(result.status, 1, `${args.join(" ")}: ${result.stdout} ${result.stderr}`);
      assert.deepEqual(readdirSync(directory), []);
    }
    // Stopping a namespace init ends every process in the namespace.
    const init = invoke(["recover", "--yes", "--app-server-pid", "1", "--output-dir", directory], environment);
    assert.equal(init.status, 1);
    assert.match(init.stderr, /process-namespace init/);
    assert.deepEqual(readdirSync(directory), []);
    // The internal worker runs only a job that `recover --yes` scheduled for this target.
    const identity = fixture.identities.get(fixture.pid);
    for (const [id, report] of [
      ["forged-empty", {}],
      ["forged-failed", { Status: "failed", Target: { AppServerPid: fixture.pid, StartIdentity: identity } }],
      ["forged-completed", { Status: "completed", Target: { AppServerPid: fixture.pid, StartIdentity: identity } }],
      ["forged-identity", { Status: "scheduled", Target: { AppServerPid: fixture.pid, StartIdentity: "not-the-identity" } }],
      ["forged-pid", { Status: "scheduled", Target: { AppServerPid: fixture.childPid, StartIdentity: identity } }],
    ]) {
      writeFileSync(path.join(directory, `${id}-recovery.json`), JSON.stringify(report));
      const forged = invoke([
        "__recover-worker", "--app-server-pid", pid, "--start-identity", identity,
        "--output-dir", directory, "--id", id, "--delay-seconds", "5", "--settle-seconds", "1",
      ], environment);
      assert.equal(forged.status, 1, id);
      assert.match(forged.stderr, /no matching scheduled recovery/, id);
    }
    process.kill(fixture.pid, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    await stopFixture(fixture);
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

test("compare reads snapshots saved by Windows PowerShell redirection or with a UTF-8 BOM", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ramraccoon-encoding-"));
  try {
    const before = path.join(directory, "before.json");
    const after = path.join(directory, "after.json");
    writeFileSync(before, Buffer.from(`\uFEFF${JSON.stringify({ Totals: { MemoryGiB: 12, MemoryMetric: "private bytes" } })}\r\n`, "utf16le"));
    writeFileSync(after, `\uFEFF${JSON.stringify({ Totals: { MemoryGiB: 3, MemoryMetric: "private bytes" } })}`);
    const result = invoke(["compare", "--before", before, "--after", after, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).CodexMemoryGiB.Delta, -9);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compare names the snapshot file it cannot use", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ramraccoon-unreadable-"));
  try {
    const valid = path.join(directory, "valid.json");
    writeFileSync(valid, JSON.stringify({ Totals: { MemoryGiB: 1, MemoryMetric: "summed RSS" } }));
    for (const [name, content] of [["truncated.json", '{"Totals": {'], ["null.json", "null"]]) {
      const file = path.join(directory, name);
      writeFileSync(file, content);
      const result = invoke(["compare", "--before", file, "--after", valid]);
      assert.equal(result.status, 1, name);
      assert.ok(result.stderr.includes(file), result.stderr);
    }
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
