---
name: ramraccoon
description: Audit whether Codex child agents are still needed, safely interrupt obsolete agents, inspect Windows Codex app-server memory and duplicated MCP process growth, and prepare restart checkpoints. Use when the user asks for housekeeping, agent cleanup, whether agents need to keep running, high RAM or commit usage, duplicated MCP processes, long-running session maintenance, or a safe Codex restart.
---

# RAM Raccoon

Keep useful task state alive while trimming unnecessary live work.

## Safety contract

- Never interrupt the root agent or current session.
- Never kill an OS process, MCP server, terminal, or app-server.
- Never treat age, name, or idle CPU alone as proof that a process is stale.
- Never expose full process command lines; they may contain private paths or arguments.
- Treat `interrupt_agent` as work control, not runtime cleanup. It may leave the agent and its MCP processes resident.
- Use a documented close or unload operation only when it is actually available. Never invent one.
- When ownership or necessity is uncertain, keep the agent and explain the uncertainty.

## Choose the mode

Infer the smallest mode that satisfies the request:

- **Agent audit**: answer “Do I still need these agents running?”
- **Runtime status**: inspect Windows memory and the Codex app-server process tree.
- **Housekeeping**: perform the agent audit, interrupt clearly obsolete child agents when the user asked to clean up, then inspect runtime status.
- **Prepare restart**: audit agents, produce a resume checkpoint, and recommend a controlled restart when pressure is high.

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

If the only available operation is `interrupt_agent`, state plainly that it stops work but may not release memory. Do not claim cleanup until the OS snapshot confirms it.

## Inspect the Windows runtime

On Windows, run the bundled script relative to this `SKILL.md`:

```powershell
& "<skill-directory>\scripts\Get-RamRaccoonSnapshot.ps1" -Json
```

The script is read-only. It finds top-level Codex app-servers, walks descendants from one bounded CIM snapshot, groups process families without printing command lines, estimates repeated MCP bundle markers, and reports physical and committed memory pressure.

Interpret pressure as:

- **HEALTHY**: no threshold crossed.
- **ELEVATED**: investigate growth and avoid unnecessary delegation.
- **HIGH**: stop new delegation and prepare a checkpoint.
- **CRITICAL**: checkpoint immediately and restart Codex when active work can safely stop.

Do not promise that interrupting agents will lower RAM. Re-run the snapshot and compare verified process/private-byte counts.

## Measure before and after

When the user asks for proof, capture the read-only JSON before any approved
restart or other action. After the action and resume, capture a second snapshot
and run:

```powershell
& "<skill-directory>\scripts\Compare-RamRaccoonSnapshots.ps1" `
    -Before "<before.json>" `
    -After "<after.json>" `
    -Json
```

Report the raw before value, raw after value, and signed delta. A lower value
afterward is evidence of a reduction, but do not attribute causation to an agent
interruption or restart unless the timing and actions support that conclusion.
Never invent an “amount saved” when an after snapshot does not exist.

## Prepare a restart checkpoint

When a restart is needed, provide a compact checkpoint containing:

- current objective;
- completed work and evidence;
- remaining work;
- active external commands or services that must survive;
- relevant workspace and uncommitted-change state;
- exact first instruction for resuming.

Do not restart Codex, terminate processes, archive tasks, or delete state without explicit user approval. The current session cannot unload itself while it is executing this skill.

## Report

Use this compact shape:

```text
RAM Raccoon: <HEALTHY|ELEVATED|HIGH|CRITICAL>

Agents
- <agent>: <KEEP|INTERRUPT|CLOSE|UNCERTAIN> — <reason>

Runtime
- Commit: <used>/<limit> (<percent>)
- Codex tree: <processes>, <private GiB>
- Repeated MCP bundle floor: <count or unknown>

Actions
- <verified action or "read-only audit">

Next
- <smallest safe next step>
```

Keep the distinction between logical agent state and OS process residency explicit.
