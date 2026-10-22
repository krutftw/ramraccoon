import { spawn } from "node:child_process";

const mode = process.argv[2];
const chain = process.argv[4] === "chain";
const keepAlive = setInterval(() => {}, 1000);
let child;
const running = () => child && child.exitCode === null && child.signalCode === null;
function stop() {
  clearInterval(keepAlive);
  // Let a connected child stop its own children first, such as the chain's leaf.
  if (running() && child.connected) {
    child.send("stop");
    setTimeout(() => {
      if (running()) child.kill();
      process.exit(0);
    }, 500);
    return;
  }
  if (running()) child.kill();
  process.exit(0);
}
// A failed test cannot leave a fixture resident indefinitely; the limit is
// longer than the slowest test that relies on the fixture staying alive, and
// an interrupted test runner stops its fixtures within seconds.
setTimeout(stop, 15 * 60000).unref();
const runner = Number(process.env.RAMRACCOON_TEST_RUNNER_PID);
if (runner) {
  setInterval(() => {
    try {
      process.kill(runner, 0);
    } catch (error) {
      if (error.code === "ESRCH") stop();
    }
  }, 2000).unref();
}
process.on("message", (message) => {
  if (message === "stop") stop();
  // Release the middle process so its detached leaf leaves the app-server tree.
  if (message === "release") child?.send("release");
});

if (mode === "ramraccoon-test-app-server-child") {
  const memory = Buffer.alloc(32 * 1024 * 1024);
  for (let index = 0; index < memory.length; index += 4096) memory[index] = 1;
  setInterval(() => memory[0], 1000);
  process.send?.({ ready: true });
} else if (mode === "ramraccoon-test-middle") {
  child = spawn(process.execPath, [process.argv[1], "ramraccoon-test-app-server-child"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  child.once("message", () => {
    process.send({ leafPid: child.pid });
    child.disconnect();
    child.unref();
  });
  process.removeAllListeners("message");
  process.on("message", (message) => {
    if (message === "release") process.exit(0);
    if (message === "stop") stop();
  });
} else if (mode === "ramraccoon-test-app-server") {
  const childMode = chain ? "ramraccoon-test-middle" : "ramraccoon-test-app-server-child";
  // Detached, so only recovery itself, not a job object closing with this
  // process, can stop the child.
  child = spawn(process.execPath, [process.argv[1], childMode], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  child.once("message", (message) => {
    process.stdout.write(`${JSON.stringify({ pid: process.pid, childPid: child.pid, leafPid: message.leafPid })}\n`);
  });
  child.once("error", (error) => { console.error(error.message); stop(); });
} else {
  throw new Error("Unknown fixture mode.");
}
