import { spawn } from "node:child_process";

const mode = process.argv[2];
if (mode === "ramraccoon-test-app-server-child") {
  const memory = Buffer.alloc(32 * 1024 * 1024);
  for (let index = 0; index < memory.length; index += 4096) memory[index] = 1;
  setInterval(() => memory[0], 1000);
} else if (mode === "ramraccoon-test-app-server") {
  spawn(process.execPath, [process.argv[1], "ramraccoon-test-app-server-child"], {
    stdio: "ignore",
  });
  console.log("READY");
  setInterval(() => {}, 1000);
} else {
  throw new Error("Unknown fixture mode.");
}
