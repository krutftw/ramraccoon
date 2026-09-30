import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { cli, environment, startFixture, stopFixture } from "./fixture-support.mjs";

const fixture = await startFixture();
try {
  const raw = execFileSync(process.execPath, [cli, "snapshot", "--app-server-pid", String(fixture.pid), "--json"], {
    env: environment, encoding: "utf8", timeout: 60000, windowsHide: true,
  });
  const report = JSON.parse(raw);
  assert.equal(report.AppServers.length, 1);
  assert.equal(report.AppServers[0].AppServerPid, fixture.pid);
  assert.equal(report.AppServers[0].ProcessFamilies.find((family) => family.Name === path.basename(process.execPath))?.Count, 2);
  assert.equal(report.AppServers[0].StartIdentity, fixture.identities.get(fixture.pid));
  assert.equal(raw.includes(fixture.secret), false);
  assert.equal(raw.includes(fixture.directory), false);
  process.kill(fixture.pid, 0);
  process.kill(fixture.childPid, 0);
  assert.ok(Math.abs(report.Host.PhysicalTotalGiB - os.totalmem() / 1024 ** 3) < 0.1);
  assert.ok(report.Host.PhysicalAvailableGiB >= 0 && report.Host.PhysicalAvailableGiB <= report.Host.PhysicalTotalGiB);
  const doctor = JSON.parse(execFileSync(process.execPath, [cli, "doctor", "--json"], {
    env: environment, encoding: "utf8", timeout: 60000, windowsHide: true,
  }));
  assert.equal(doctor.Status, "ready");
  console.log(JSON.stringify({
    Result: "PASSED", Platform: process.platform, Architecture: process.arch,
    NodeVersion: process.versions.node, FixtureProcesses: 2,
    FixtureSurvivedSnapshot: true, PrivateArgumentsEmitted: false,
    MemoryMetric: report.Totals.MemoryMetric, DoctorStatus: doctor.Status,
  }, null, 2));
} finally {
  await stopFixture(fixture);
}
