import assert from "node:assert/strict";
import test from "node:test";

process.env.RAMRACCOON_TEST_MODE = "1";
const {
  compareSnapshots,
  descendants,
  isAppServer,
  riskLevel,
  topLevelAppServers,
} = await import("../skills/ramraccoon/scripts/ramraccoon.mjs");

const rows = [
  { pid: 10, ppid: 1, name: "codex", args: "codex app-server", startedAt: "a" },
  { pid: 11, ppid: 10, name: "node", args: "node mcp-server", startedAt: "b" },
  { pid: 12, ppid: 11, name: "codex", args: "codex app-server --stdio", startedAt: "c" },
  { pid: 20, ppid: 1, name: "codex", args: "codex exec", startedAt: "d" },
];

test("finds only top-level app-servers", () => {
  assert.equal(isAppServer(rows[0]), true);
  assert.equal(isAppServer(rows[3]), false);
  assert.deepEqual(topLevelAppServers(rows).map((row) => row.pid), [10]);
});

test("walks a bounded process tree", () => {
  assert.deepEqual(descendants(rows, 10).map((row) => row.pid), [10, 11, 12]);
});

test("risk thresholds are deterministic", () => {
  assert.equal(riskLevel(0, 20, 1, 10), "HEALTHY");
  assert.equal(riskLevel(80, 20, 1, 10), "ELEVATED");
  assert.equal(riskLevel(90, 20, 1, 10), "HIGH");
  assert.equal(riskLevel(95, 20, 1, 10), "CRITICAL");
});

test("comparison reports raw values, delta, and reclaimed memory", () => {
  const before = {
    Timestamp: "before",
    Host: { Platform: "linux", Architecture: "arm64", PhysicalUsedGiB: 12 },
    Totals: { CodexProcessCount: 100, MemoryMetric: "summed RSS", MemoryGiB: 8 },
  };
  const after = {
    Timestamp: "after",
    Host: { Platform: "linux", Architecture: "arm64", PhysicalUsedGiB: 6 },
    Totals: { CodexProcessCount: 20, MemoryMetric: "summed RSS", MemoryGiB: 2 },
  };
  const result = compareSnapshots(before, after);
  assert.equal(result.CodexMemoryGiB.Delta, -6);
  assert.equal(result.CodexMemoryGiB.Reclaimed, 6);
  assert.equal(result.PhysicalUsedGiB.Reclaimed, 6);
});

test("an app-server mention in a prompt or configuration is not a server", () => {
  for (const args of [
    "codex exec app-server",
    'codex -c prompt=app-server exec',
    'codex --config=prompt=app-server resume',
    'codex exec "please inspect app-server"',
  ]) {
    assert.equal(isAppServer({ name: "codex", args }), false, args);
  }
  assert.equal(isAppServer({ name: "codex", args: "codex -c features.multi_agent=true app-server --stdio" }), true);
  assert.equal(isAppServer({
    name: "codex.exe", args: '"C:\\Program Files\\Codex\\codex.exe" app-server --stdio',
  }), true);
});

test("Linux argv and macOS executable paths preserve actual subcommand boundaries", () => {
  assert.equal(isAppServer({ name: "codex", argv: ["codex", "exec", "app-server"], args: "" }), false);
  // Helper subcommands of app-server are not servers on any platform.
  assert.equal(isAppServer({ name: "codex", argv: ["codex", "app-server", "daemon", "pid-update-loop"], args: "" }), false);
  assert.equal(isAppServer({ name: "codex.exe", args: "codex.exe app-server generate-ts --out x" }), false);
  assert.equal(isAppServer({ name: "codex", argv: ["codex", "app-server", "--listen", "stdio://"], args: "" }), true);
  // Joined args would split this config value and expose a bare app-server token.
  assert.equal(isAppServer({ name: "codex", argv: ["codex", "-c", "notice=see app-server"], args: "codex -c notice=see app-server" }), false);
  assert.equal(isAppServer({
    name: "codex", executable: "/Applications/Codex Beta.app/codex",
    args: "/Applications/Codex Beta.app/codex app-server --stdio",
  }), true);
  // macOS ps joins argv, so an interactive prompt can start with the subcommand's name.
  const mac = (args) => ({ name: "codex", executable: "/opt/homebrew/bin/codex", args: `/opt/homebrew/bin/codex ${args}` });
  assert.equal(isAppServer(mac("app-server keeps crashing, please fix it")), false);
  assert.equal(isAppServer(mac("app-server --listen stdio://")), true);
  // An option value can contain spaces once the subcommand is followed by an option.
  assert.equal(isAppServer(mac("app-server -c sandbox.path=/Users/me/Library/Application Support/x")), true);
});

test("a recycled Windows parent PID does not adopt older unrelated processes", () => {
  const recycled = [
    { pid: 10, ppid: 1, name: "codex.exe", args: "codex.exe app-server", startedAt: "2026-10-22T01:00:00.0000000Z" },
    { pid: 11, ppid: 10, name: "node.exe", args: "node mcp-server", startedAt: "2026-10-22T01:00:01.0000000Z" },
    // Started by an exited process whose PID was later reused by the app-server.
    { pid: 12, ppid: 10, name: "explorer.exe", args: "explorer.exe", startedAt: "2026-10-21T08:00:00.0000000Z" },
    { pid: 13, ppid: 12, name: "notepad.exe", args: "notepad.exe", startedAt: "2026-10-22T02:00:00.0000000Z" },
    { pid: 20, ppid: 10, name: "codex.exe", args: "codex.exe app-server", startedAt: "2026-10-21T09:00:00.0000000Z" },
  ].map((row) => ({ ...row, parentMayBeStale: true }));
  assert.deepEqual(descendants(recycled, 10).map((row) => row.pid), [10, 11]);
  assert.deepEqual(topLevelAppServers(recycled).map((row) => row.pid), [10, 20]);
  // Platforms that reparent orphans keep their recorded parents, even across
  // an ambiguous daylight-saving hour in macOS local start times.
  const reparenting = recycled.map(({ parentMayBeStale, ...row }) => row);
  assert.deepEqual(descendants(reparenting, 10).map((row) => row.pid), [10, 11, 12, 20, 13]);
});

test("process-tree cycles are bounded and unrelated siblings stay outside the tree", () => {
  const cycle = [
    { pid: 1, ppid: 3 }, { pid: 2, ppid: 1 }, { pid: 3, ppid: 2 }, { pid: 4, ppid: 0 },
  ];
  assert.deepEqual(descendants(cycle, 1).map((row) => row.pid), [1, 2, 3]);
});
