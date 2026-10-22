import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hostMemory, powershellExecutable, run } from "../skills/ramraccoon/scripts/platform.mjs";
import { CLI_TIMEOUT, cli, environment, pause, startFixture, stopFixture } from "./fixture-support.mjs";

const workers = [];

function scheduleRecovery(fixture, id) {
  const scheduled = JSON.parse(execFileSync(process.execPath, [
    cli, "recover", "--app-server-pid", String(fixture.pid),
    "--output-dir", fixture.directory, "--id", id,
    "--delay-seconds", "5", "--settle-seconds", "1", "--yes",
  ], { env: environment, encoding: "utf8", windowsHide: true, timeout: CLI_TIMEOUT }));
  workers.push(scheduled.WorkerPid);
  return scheduled;
}

const readReport = (fixture, id) => JSON.parse(readFileSync(path.join(fixture.directory, `${id}-recovery.json`), "utf8"));

async function finishedReport(fixture, id) {
  // The delay, the settle interval, and two or three process scans of up to
  // 120 s each, some with a second collector call, on a busy host.
  const deadline = Date.now() + 600000;
  let report;
  while (Date.now() < deadline) {
    report = readReport(fixture, id);
    if (["completed", "partial", "failed"].includes(report.Status)) break;
    await pause(250);
  }
  return report;
}

const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// Recovery is refused inside a sandbox's private process view by design.
if (hostMemory().processViewSandboxed) {
  console.log(JSON.stringify({ Result: "SKIPPED", Reason: "Recovery is refused inside a sandbox; run this test outside it." }, null, 2));
  process.exit(0);
}

const fixtures = [];
try {
  const fixture = await startFixture();
  fixtures.push(fixture);
  const sentinel = await startFixture();
  fixtures.push(sentinel);
  const scheduled = scheduleRecovery(fixture, "controlled-recovery");
  let hiddenConsoleCheck = "not applicable";
  if (process.platform === "win32") {
    // A delegated terminal such as Windows Terminal hosts the window elsewhere,
    // so the window-handle check is conclusive only under the classic console.
    const delegation = run(powershellExecutable(), [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-ItemProperty 'HKCU:\\Console\\%%Startup' -ErrorAction SilentlyContinue).DelegationConsole",
    ]).trim();
    hiddenConsoleCheck = delegation === "{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}"
      ? "conclusive (classic console host)"
      : "inconclusive (console delegated to another terminal)";
    await pause(1000);
    const visible = run(powershellExecutable(), [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${scheduled.WorkerPid}).MainWindowHandle -ne [IntPtr]::Zero`,
    ]).trim();
    assert.equal(visible, "False", "The recovery worker opened a visible console window; closing it would kill the worker mid-recovery.");
  }
  const report = await finishedReport(fixture, "controlled-recovery");
  assert.equal(scheduled.Target.AppServerPid, fixture.pid);
  assert.equal(report.Status, "completed", report.Error || `Recovery ended in ${report.Status}`);
  assert.deepEqual(report.TerminationPlan.map((item) => item.Pid).sort((a, b) => a - b), [fixture.pid, fixture.childPid].sort((a, b) => a - b));
  assert.equal(report.Termination.StillRunning, 0);
  assert.equal(report.Termination.DetachedStillRunning, 0);
  assert.equal(report.Termination.SpawnedStillRunning, 0);
  assert.ok(report.Comparison.CodexMemoryGiB.Reclaimed > 0);
  assert.equal(report.Comparison.PhysicalUsedGiB.Reclaimed, null);
  assert.equal(report.Comparison.CommittedGiB.Reclaimed, null);
  // An unrelated, concurrently running fixture must survive the selected recovery.
  process.kill(sentinel.pid, 0);
  process.kill(sentinel.childPid, 0);

  // A process that leaves the tree during the delay is never stopped, so its
  // memory cannot be reported as reclaimed.
  const chain = await startFixture({ chain: true });
  fixtures.push(chain);
  scheduleRecovery(chain, "detached-survivor");
  chain.child.send("release");
  const detached = await finishedReport(chain, "detached-survivor");
  assert.equal(detached.Status, "partial", detached.Error || `Recovery ended in ${detached.Status}`);
  assert.equal(detached.Termination.DetachedStillRunning, 1);
  assert.equal(detached.Comparison.CodexMemoryGiB.Reclaimed, null);
  process.kill(chain.leafPid, 0);

  // A job the scheduler marked failed is abandoned: the worker stands down
  // after its delay without stopping anything.
  const abandoned = await startFixture();
  fixtures.push(abandoned);
  scheduleRecovery(abandoned, "abandoned");
  const failed = { ...readReport(abandoned, "abandoned"), Status: "failed", Error: "marked failed by the test" };
  writeFileSync(path.join(abandoned.directory, "abandoned-recovery.json"), JSON.stringify(failed));
  const standDown = Date.now() + 60000;
  while (running(workers.at(-1)) && Date.now() < standDown) await pause(250);
  assert.equal(running(workers.at(-1)), false, "The worker did not stand down.");
  assert.equal(readReport(abandoned, "abandoned").Status, "failed");
  process.kill(abandoned.pid, 0);
  process.kill(abandoned.childPid, 0);

  console.log(JSON.stringify({
    Result: "PASSED", Platform: process.platform, Architecture: process.arch,
    NodeVersion: process.versions.node, TargetType: "controlled fixture, not a Codex runtime",
    SelectedProcesses: 2, UnrelatedFixtureSurvived: true,
    RemainingTargetProcesses: report.Termination.StillRunning,
    ObservedTargetReductionGiB: report.Comparison.CodexMemoryGiB.Reclaimed,
    DetachedSurvivorReportedPartial: true,
    AbandonedJobLeftTargetRunning: true,
    HiddenConsoleCheck: hiddenConsoleCheck,
    FullPostResumeBaselineRequired: true,
  }, null, 2));
} finally {
  // A worker still running would recreate a deleted fixture directory.
  const deadline = Date.now() + 600000;
  while (workers.some(running) && Date.now() < deadline) await pause(500);
  for (const fixture of fixtures) await stopFixture(fixture);
}
