import { spawn } from "node:child_process";

const mode = process.argv[2];
const keepAlive = setInterval(() => {}, 1000);
let child;
function stop() {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
  clearInterval(keepAlive);
  process.exit(0);
}
// A failed test cannot leave a fixture resident indefinitely.
setTimeout(stop, 120000).unref();
process.on("message", (message) => { if (message === "stop") stop(); });

if (mode === "ramraccoon-test-app-server-child") {
  const memory = Buffer.alloc(32 * 1024 * 1024);
  for (let index = 0; index < memory.length; index += 4096) memory[index] = 1;
  setInterval(() => memory[0], 1000);
  process.send?.({ ready: true });
} else if (mode === "ramraccoon-test-app-server") {
  child = spawn(process.execPath, [process.argv[1], "ramraccoon-test-app-server-child"], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
  child.once("message", () => {
    process.stdout.write(`${JSON.stringify({ pid: process.pid, childPid: child.pid })}\n`);
  });
  child.once("error", (error) => { console.error(error.message); stop(); });
} else {
  throw new Error("Unknown fixture mode.");
}
