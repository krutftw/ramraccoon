# Security

## Reporting

Please report a vulnerability through GitHub private vulnerability reporting when available. Do not include live process command lines, tokens, private paths, or task content in a public issue.

## Safety model

RAM Raccoon audits and snapshots read-only by default. The collectors:

- read local process and memory metadata;
- emits aggregate process-family counts;
- suppresses full command lines;
- make no network request;
- terminate no process.

The agent workflow may recommend or invoke Codex's documented child-agent interruption operation when the user requested cleanup. Interruption is not presented as proof that an MCP runtime was unloaded.

Explicit recovery is a separate destructive operation. It:

- requires a saved resume checkpoint and the user's approval;
- requires `--yes` and exactly one top-level Codex app-server target;
- re-checks the exact PID, executable role, and process start identity;
- terminates only that verified app-server and its descendants;
- excludes Windows console-host and terminal-host processes;
- records the target, termination result, and measured before/after values;
- never modifies or deletes the persisted task transcript.

Recovery disconnects the current task and stops every process owned by that
runtime, including terminals and MCP servers. Do not run it while an external
service under the task must survive.

Age, idle CPU, duplicate names, and memory size are never sufficient ownership
proof. If verification fails, recovery refuses to act.
