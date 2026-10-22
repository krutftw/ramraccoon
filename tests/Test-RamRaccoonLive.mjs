import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostMemory, processTable } from "../skills/ramraccoon/scripts/platform.mjs";
import { CLI_TIMEOUT, cli, environment, pause, startFixture, stopFixture } from "./fixture-support.mjs";

const fixture = await startFixture();
let windowsCodex = "not applicable";
try {
  // Linux reports the kernel process name, which Node.js renames: MainThread
  // from 23.8, node-MainThread from 25.5.
  const fixtureName = path.basename(processTable().rows.find((row) => row.pid === fixture.pid)?.name || "");
  assert.ok(fixtureName, "The fixture's process name was not readable.");
  const raw = execFileSync(process.execPath, [cli, "snapshot", "--app-server-pid", String(fixture.pid), "--json"], {
    env: environment, encoding: "utf8", timeout: CLI_TIMEOUT, windowsHide: true,
  });
  const report = JSON.parse(raw);
  assert.equal(report.AppServers.length, 1);
  assert.equal(report.AppServers[0].AppServerPid, fixture.pid);
  assert.equal(report.AppServers[0].ProcessFamilies.find((family) => family.Name === fixtureName)?.Count, 2);
  assert.equal(report.AppServers[0].StartIdentity, fixture.identities.get(fixture.pid));
  assert.equal(report.AppServers[0].ContainsCurrentProcess, false);
  // A check launched inside an app-server's tree identifies that runtime as its
  // own, and its own collector processes are not mistaken for MCP servers.
  const hosted = JSON.parse(execFileSync(process.execPath, [
    "-e",
    "process.stdout.write(require('node:child_process').execFileSync(process.execPath, [process.argv[1], 'snapshot', '--app-server-pid', String(process.pid), '--json'], { windowsHide: true }))",
    cli, "ramraccoon-test-app-server",
  ], { env: environment, encoding: "utf8", timeout: CLI_TIMEOUT, windowsHide: true }));
  assert.equal(hosted.AppServers[0].ContainsCurrentProcess, true);
  assert.deepEqual(hosted.AppServers[0].McpMarkers, {
    NodeRepl: 0, ChromeDevToolsNodeProcesses: 0, Playwright: 0, Context7: 0, Sentry: 0, CommonBundleFloor: null,
  });
  assert.equal(raw.includes(fixture.secret), false);
  // JSON escapes Windows backslashes, so check the escaped form as well.
  for (const leaked of [fixture.directory, JSON.stringify(fixture.directory).slice(1, -1)]) assert.equal(raw.includes(leaked), false);
  process.kill(fixture.pid, 0);
  process.kill(fixture.childPid, 0);
  assert.ok(Math.abs(report.Host.PhysicalTotalGiB - os.totalmem() / 1024 ** 3) < 0.1);
  assert.ok(report.Host.PhysicalAvailableGiB >= 0 && report.Host.PhysicalAvailableGiB <= report.Host.PhysicalTotalGiB);

  if (process.platform === "win32") {
    // A real, non-test-mode codex.exe app-server is classified from its command
    // line. A scoped check does not require it to be top-level, so this also
    // works beneath the Codex app-server of a task running the tests.
    const directory = mkdtempSync(path.join(os.tmpdir(), "ramraccoon codex "));
    let server;
    try {
      copyFileSync(process.execPath, path.join(directory, "codex.exe"));
      writeFileSync(path.join(directory, "app-server"), "setInterval(() => {}, 1 << 30);\n");
      server = spawn(path.join(directory, "codex.exe"), ["app-server", "--listen", "stdio://"], { cwd: directory, stdio: "ignore", windowsHide: true });
      await new Promise((resolve, reject) => {
        server.once("spawn", resolve);
        server.once("error", reject);
      });
      await pause(1000);
      const plain = { ...process.env, RAMRACCOON_TEST_MODE: "" };
      const real = JSON.parse(execFileSync(process.execPath, [cli, "snapshot", "--app-server-pid", String(server.pid), "--json"], {
        env: plain, encoding: "utf8", timeout: CLI_TIMEOUT, windowsHide: true,
      }));
      assert.equal(real.AppServers[0]?.AppServerPid, server.pid, "The codex.exe app-server was not detected.");
      assert.equal(real.AppServers[0].McpMarkers.CommonBundleFloor, null);
      windowsCodex = "detected from its command line";
    } finally {
      if (server?.pid && server.exitCode === null && server.signalCode === null) {
        const exited = new Promise((resolve) => server.once("exit", resolve));
        server.kill();
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }

  // doctor exits 2 when not ready. Partial is expected only when this test's
  // own reading of the host shows limited visibility.
  const limited = hostMemory().processViewSandboxed === true || processTable().warnings.length > 0;
  const doctorRun = spawnSync(process.execPath, [cli, "doctor", "--json"], { env: environment, encoding: "utf8", timeout: CLI_TIMEOUT, windowsHide: true });
  const doctor = JSON.parse(doctorRun.stdout);
  assert.equal(doctor.Status, limited ? "partial" : "ready", doctorRun.stderr);
  console.log(JSON.stringify({
    Result: "PASSED", Platform: process.platform, Architecture: process.arch,
    NodeVersion: process.versions.node, FixtureProcesses: 2,
    FixtureSurvivedSnapshot: true, PrivateArgumentsEmitted: false,
    MemoryMetric: report.Totals.MemoryMetric, DoctorStatus: doctor.Status,
    WindowsCodexAppServer: windowsCodex,
  }, null, 2));
} finally {
  await stopFixture(fixture);
}
