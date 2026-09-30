import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { cli, environment, pause, startFixture, stopFixture } from "./fixture-support.mjs";

const fixture = await startFixture();
const sentinel = await startFixture();
try {
  const id = "controlled-recovery";
  const scheduled = JSON.parse(execFileSync(process.execPath, [
    cli, "recover", "--app-server-pid", String(fixture.pid),
    "--output-dir", fixture.directory, "--id", id,
    "--delay-seconds", "5", "--settle-seconds", "1", "--yes",
  ], { env: environment, encoding: "utf8", windowsHide: true, timeout: 60000 }));
  const reportPath = path.join(fixture.directory, `${id}-recovery.json`);
  const deadline = Date.now() + 90000;
  let report;
  while (Date.now() < deadline) {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (["completed", "partial", "failed"].includes(report.Status)) break;
    await pause(250);
  }
  assert.equal(scheduled.Target.AppServerPid, fixture.pid);
  assert.equal(report.Status, "completed", report.Error || `Recovery ended in ${report.Status}`);
  assert.deepEqual(report.TerminationPlan.map((item) => item.Pid).sort((a, b) => a - b), [fixture.pid, fixture.childPid].sort((a, b) => a - b));
  assert.equal(report.Termination.StillRunning, 0);
  assert.ok(report.Comparison.CodexMemoryGiB.Reclaimed > 0);
  assert.equal(report.Comparison.PhysicalUsedGiB.Reclaimed, null);
  assert.equal(report.Comparison.CommittedGiB.Reclaimed, null);
  // An unrelated, concurrently running fixture must survive the selected recovery.
  process.kill(sentinel.pid, 0);
  process.kill(sentinel.childPid, 0);
  console.log(JSON.stringify({
    Result: "PASSED", Platform: process.platform, Architecture: process.arch,
    NodeVersion: process.versions.node, TargetType: "controlled fixture, not a Codex runtime",
    SelectedProcesses: 2, UnrelatedFixtureSurvived: true,
    RemainingTargetProcesses: report.Termination.StillRunning,
    ObservedTargetReductionGiB: report.Comparison.CodexMemoryGiB.Reclaimed,
    FullPostResumeBaselineRequired: true,
  }, null, 2));
} finally {
  await stopFixture(fixture);
  await stopFixture(sentinel);
}
