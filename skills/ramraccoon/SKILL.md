---
name: ramraccoon
description: Audit whether Codex child agents are still needed, close or interrupt obsolete agents, inspect Codex app-server memory on Windows macOS and Linux, and recover RAM through an explicit checkpointed runtime restart. Use when the user asks for housekeeping, agent cleanup, whether agents need to keep running, high RAM or swap usage, duplicated MCP processes, long-running session maintenance, or measurable memory recovery.
---

# RAM Raccoon

Keep useful task state alive while trimming unnecessary live work.

## Safety contract

- Never interrupt the root agent or current session.
- Keep ordinary audits and snapshots read-only.
- Never treat age, name, or idle CPU alone as proof that a process is stale.
- Never expose full process command lines; they may contain private paths or arguments.
- Treat `interrupt_agent` as work control, not runtime cleanup. It may leave the agent and its MCP processes resident.
- Use a documented close or unload operation only when it is actually available. Never invent one.
- When ownership or necessity is uncertain, keep the agent and explain the uncertainty.
- Run OS-level recovery only after the user explicitly approves the disconnect and a resume checkpoint exists.
- Recovery may target only one re-verified top-level Codex `app-server` PID and its descendants. Never target the desktop host, unrelated Codex runtimes, or processes selected only by name or age.

## Choose the mode

Infer the smallest mode that satisfies the request:

- **Agent audit**: answer “Do I still need these agents running?”
- **Runtime status**: inspect memory and the Codex app-server process tree.
- **Housekeeping**: perform the agent audit, interrupt clearly obsolete child agents when the user asked to clean up, then inspect runtime status.
- **Prepare recovery**: audit agents, close or interrupt obsolete work, and produce a resume checkpoint.
- **Recover**: after explicit approval, terminate one verified app-server tree, preserve the task transcript, and measure the result.

Do not add an MCP server for this workflow. RAM Raccoon must remain a short-lived skill and script.

## Audit child agents first

1. Call `collaboration.list_agents` for the current agent tree.
2. Compare every non-root agent with the user’s current objective, remaining plan, and delivered results.
3. Ask these questions for each agent:
   - What unfinished deliverable still requires this agent?
   - Is it actively producing unique work?
   - Has its result already been delivered or superseded?
   - Would interruption lose unsaved external work?
   - Is another agent doing the same job?
4. Classify each agent:
   - **KEEP**: active, unique, and still required.
   - **INTERRUPT**: running work is complete, superseded, duplicated, or no longer on the critical path.
   - **CLOSE**: completed result is collected and a real documented close/unload tool is available.
   - **UNCERTAIN**: evidence is insufficient; keep it.
5. Show the decision table before or alongside actions.

An ordinary “audit” request is read-only. “Run housekeeping,” “clean up,” or “stop unused agents” authorizes interruption of clearly unnecessary non-root agents. Re-list agents after any action and report the verified state.

If the only available operation is `interrupt_agent`, state plainly that it
stops work but may not release memory. Prefer `close_agent` for completed
subagents when the tool is genuinely available, but do not rely on it as proof
that leaked MCP processes exited.

## Inspect the runtime

Use the portable collector relative to this `SKILL.md`:

```text
node <skill-directory>/scripts/ramraccoon.mjs snapshot --json
```

It supports Windows, macOS, and Linux on Node 20 or newer, including x64 and
ARM64. The collector is read-only. It finds top-level Codex app-servers, walks
descendants from one bounded process snapshot, groups process families without
printing command lines, estimates repeated MCP bundle markers, and reports
physical memory plus commit or swap metrics when the OS exposes them.

- Windows reports private bytes and working set.
- macOS and Linux report summed RSS and label it explicitly; summed RSS may
  double-count shared pages.
- The legacy `Get-RamRaccoonSnapshot.ps1` remains available on Windows.

Interpret pressure as:

- **HEALTHY**: no threshold crossed.
- **ELEVATED**: investigate growth and avoid unnecessary delegation.
- **HIGH**: stop new delegation and prepare a checkpoint.
- **CRITICAL**: checkpoint immediately and restart Codex when active work can safely stop.

Do not promise that interrupting agents will lower RAM. Re-run the snapshot and compare verified process/private-byte counts.

## Measure before and after

When the user asks for proof, capture the read-only JSON before any action.
After the action and resume, capture a second full snapshot and run:

```text
node <skill-directory>/scripts/ramraccoon.mjs compare \
  --before <before.json> --after <after.json> --json
```

Report the raw before value, raw after value, and signed delta. A lower value
afterward is evidence of a reduction, but do not attribute causation to an agent
interruption or restart unless the timing and actions support that conclusion.
Never invent an “amount saved” when an after snapshot does not exist.

## Prepare a recovery checkpoint

When a restart is needed, provide a compact checkpoint containing:

- current objective;
- completed work and evidence;
- remaining work;
- active external commands or services that must survive;
- relevant workspace and uncommitted-change state;
- exact first instruction for resuming.

Do not recover while an external command or service must remain alive under the
selected app-server. The recovery worker terminates that whole runtime tree.

## Recover RAM

Only a user request such as “recover now,” “restart it,” or an affirmative
answer to the proposed checkpoint authorizes this step. “Audit,” “check,” or
“housekeeping” alone does not.

1. Re-run the snapshot immediately before recovery.
2. Select exactly one top-level app-server PID from `AppServers`.
3. Show the checkpoint, target PID, target process count, measured memory, and
   explain that the current task will disconnect.
4. After approval, run:

```text
node <skill-directory>/scripts/ramraccoon.mjs recover \
  --app-server-pid <PID> \
  --output-dir <checkpoint-directory> \
  --thread-id <current-thread-id> \
  --yes
```

The command captures a full before-snapshot, waits 15 seconds for the turn to
finish, re-verifies the PID and exact process start identity, and terminates
only that app-server tree. On Windows it launches the worker outside the Codex
job object so the worker survives the disconnect. It writes a lightweight
immediate after-sample without starting another expensive full scan under
critical pressure.

After the user reopens the task or runs `codex resume <thread-id>`, capture a
normal full snapshot. Compare that full post-resume snapshot with the recorded
`*-before.json`. Treat the worker report as termination evidence and the
post-resume full comparison as the durable new baseline.

If recovery reports `partial` or `failed`, do not broaden the target or kill
unrelated processes. Report the exact status and stop.

## Report

Use this compact shape:

```text
RAM Raccoon: <HEALTHY|ELEVATED|HIGH|CRITICAL>

Agents
- <agent>: <KEEP|INTERRUPT|CLOSE|UNCERTAIN> — <reason>

Runtime
- Memory pressure: <physical percent; commit percent when available>
- Codex tree: <processes>, <GiB and metric>
- Repeated MCP bundle floor: <count or unknown>

Actions
- <verified action or "read-only audit"; include recovery report when applicable>

Next
- <smallest safe next step>
```

Keep the distinction between logical agent state and OS process residency explicit.
