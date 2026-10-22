import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processTable } from "../skills/ramraccoon/scripts/platform.mjs";
import { sameProcessIdentity } from "../skills/ramraccoon/scripts/ramraccoon.mjs";

export const cli = fileURLToPath(new URL("../skills/ramraccoon/scripts/ramraccoon.mjs", import.meta.url));
// Fixtures watch the test runner and stop when it is gone.
export const environment = { ...process.env, RAMRACCOON_TEST_MODE: "1", RAMRACCOON_TEST_RUNNER_PID: String(process.pid) };
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// One CLI call can take several process scans of up to 120 s each on a busy host.
export const CLI_TIMEOUT = 360000;

// A chain fixture adds a middle process that can exit and leave a detached leaf.
export async function startFixture({ chain = false, readyTimeoutMs = 120000 } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ramraccoon fixture "));
  const fixture = path.join(directory, "fake-app-server.mjs");
  copyFileSync(fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url)), fixture);
  const secret = `private-argument-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const child = spawn(process.execPath, [fixture, "ramraccoon-test-app-server", secret, ...(chain ? ["chain"] : [])], {
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  try {
    const ready = await new Promise((resolve, reject) => {
      let output = "";
      let errors = "";
      const timeout = setTimeout(() => reject(new Error(`Fixture readiness timed out: ${errors}`)), readyTimeoutMs);
      child.stderr.on("data", (data) => { errors = (errors + data).slice(-4096); });
      child.stdout.on("data", (data) => {
        output += data;
        if (output.includes("\n")) {
          clearTimeout(timeout);
          try { resolve(JSON.parse(output.split("\n")[0])); } catch (error) { reject(error); }
        }
      });
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(`Fixture exited before readiness: ${errors}`)); });
    });
    const rows = processTable().rows;
    const identities = new Map([ready.pid, ready.childPid, ready.leafPid].filter(Boolean).map((pid) => {
      const row = rows.find((candidate) => candidate.pid === pid);
      if (!row) throw new Error("A newly created fixture disappeared before its identity was captured.");
      return [pid, row.startIdentity || row.startedAt];
    }));
    return { child, directory, secret, ...ready, identities };
  } catch (error) {
    if (child.connected) child.send("stop");
    else child.kill();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

// Cleanup never throws, so one failed scan cannot hide the test's own error
// or leave later fixtures and their temporary directories behind.
export async function stopFixture(fixture) {
  try {
    if (fixture.child.connected) fixture.child.send("stop");
    await pause(750);
    const rows = processTable().rows;
    for (const [pid, identity] of fixture.identities) {
      const row = rows.find((candidate) => candidate.pid === pid);
      if (sameProcessIdentity(row, identity)) {
        try { process.kill(pid, "SIGTERM"); } catch { /* It exited meanwhile. */ }
      }
    }
    await pause(150);
  } catch {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null) fixture.child.kill();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}
