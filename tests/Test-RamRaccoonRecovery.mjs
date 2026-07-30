import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "skills", "ramraccoon", "scripts", "ramraccoon.mjs");
const fixture = path.join(import.meta.dirname, "fixtures", "fake-app-server.mjs");
const output = mkdtempSync(path.join(os.tmpdir(), "ramraccoon-recovery-"));
const id = "controlled-recovery";
const environment = { ...process.env, RAMRACCOON_TEST_MODE: "1" };

let targetPid;
if (process.platform === "win32") {
  const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
  const commandLine = [
    quote(process.execPath),
    quote(fixture),
    "ramraccoon-test-app-server",
  ].join(" ");
  const escaped = commandLine.replaceAll("'", "''");
  targetPid = Number(
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${escaped}'}; [int]$r.ProcessId`,
      ],
      { encoding: "utf8", windowsHide: true },
    ).trim(),
  );
} else {
  const target = spawn(
    process.execPath,
    [fixture, "ramraccoon-test-app-server"],
    {
      detached: true,
      env: environment,
      stdio: "ignore",
    },
  );
  target.unref();
  targetPid = target.pid;
}
await new Promise((resolve) => setTimeout(resolve, 1500));

const scheduled = JSON.parse(execFileSync(
  process.execPath,
  [
    cli,
    "recover",
    "--app-server-pid",
    String(targetPid),
    "--output-dir",
    output,
    "--id",
    id,
    "--delay-seconds",
    "5",
    "--settle-seconds",
    "1",
    "--yes",
  ],
  {
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
  },
));

const reportPath = path.join(output, `${id}-recovery.json`);
const deadline = Date.now() + 90000;
while (Date.now() < deadline) {
  const current = JSON.parse(readFileSync(reportPath, "utf8"));
  if (["completed", "partial", "failed"].includes(current.Status)) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!scheduled.WorkerPid) throw new Error("Recovery worker was not scheduled.");

const report = JSON.parse(
  readFileSync(reportPath, "utf8"),
);
if (report.Status !== "completed") {
  throw new Error(`Recovery status was ${report.Status}: ${report.Error || "unknown"}`);
}
if (report.Termination.Attempted < 2 || report.Termination.StillRunning !== 0) {
  throw new Error(`Unexpected termination evidence: ${JSON.stringify(report.Termination)}`);
}
if (report.Comparison.CodexMemoryGiB.Reclaimed <= 0) {
  throw new Error("Controlled process tree did not report reclaimed memory.");
}

console.log(
  `RAM Raccoon controlled recovery: OK (${report.Comparison.CodexMemoryGiB.Reclaimed} GiB reclaimed)`,
);
