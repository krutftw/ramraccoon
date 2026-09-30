import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processTable } from "../skills/ramraccoon/scripts/platform.mjs";
import { sameProcessIdentity } from "../skills/ramraccoon/scripts/ramraccoon.mjs";

export const cli = fileURLToPath(new URL("../skills/ramraccoon/scripts/ramraccoon.mjs", import.meta.url));
export const environment = { ...process.env, RAMRACCOON_TEST_MODE: "1" };
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ramraccoon fixture "));
  const fixture = path.join(directory, "fake-app-server.mjs");
  copyFileSync(fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url)), fixture);
  const secret = `private-argument-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const child = spawn(process.execPath, [fixture, "ramraccoon-test-app-server", secret], {
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  try {
    const ready = await new Promise((resolve, reject) => {
      let output = "";
      let errors = "";
      const timeout = setTimeout(() => reject(new Error(`Fixture readiness timed out: ${errors}`)), 20000);
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
    const identities = new Map([ready.pid, ready.childPid].map((pid) => {
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

export async function stopFixture(fixture) {
  if (fixture.child.connected) fixture.child.send("stop");
  await pause(150);
  const rows = processTable().rows;
  for (const [pid, identity] of fixture.identities) {
    const row = rows.find((candidate) => candidate.pid === pid);
    if (sameProcessIdentity(row, identity)) {
      try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  await pause(150);
  rmSync(fixture.directory, { recursive: true, force: true });
}
