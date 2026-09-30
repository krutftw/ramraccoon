---
name: ramraccoon
description: Check system memory pressure and top consumers, distinguish RAM from Windows commit and Linux container limits, audit Codex child agents, and recover one verified Codex app-server only after an explicitly approved checkpointed restart. Use for high RAM or swap, allocation failures, agent housekeeping, duplicated MCP processes, and measured before/after comparisons on Windows, macOS, or Linux.
---

# RAM Raccoon

Find the measured cause before proposing what to stop. Preserve useful work.

## Safety contract

- Ordinary audits and snapshots are read-only. Never interrupt the root/current session during housekeeping.
- Age, process name, idle CPU, duplicate names, and one large reading are not proof of staleness or a leak.
- Private committed memory is not resident RAM. Label both; never add them together.
- System pressure does not establish that Codex caused it. Inspect top consumers first. Never stop a Windows service as part of Codex recovery.
- Never expose full command lines, secrets, private paths, or task content. Review even sanitized reports before sharing process names and IDs.
- `interrupt_agent` controls work; it may leave sessions and MCP processes resident. Never invent a close/unload API or claim interruption proves memory release.
- Keep agents whose ownership or necessity is uncertain.
- OS recovery is a separate destructive operation. Require a saved resume checkpoint and explicit approval to disconnect one re-verified top-level Codex app-server tree.
- Never broaden recovery to the desktop host, a standalone Codex CLI, another runtime, or processes selected only by name.
- Do not escalate privileges automatically, add a daemon/MCP server, change swap/pagefile settings, or promise support for APIs the OS does not expose.

## Choose the smallest mode

| Request | Action |
|---|---|
| Check RAM, memory pressure, or allocation failures | Start with the read-only runtime snapshot; Codex need not be installed |
| Audit agents | Inventory available logical agents and identify useful work; no interruption |
| Housekeeping / stop unused agents | Audit, interrupt only clearly obsolete non-root agents, then measure |
| Prepare recovery | Save a checkpoint and propose one measured target; no termination |
| Recover now / approved restart | Execute the explicitly approved target and verify the recorded result |

## Runtime snapshot

Use paths relative to this `SKILL.md`; quote paths that contain spaces:

```text
node "<skill-directory>/scripts/ramraccoon.mjs" snapshot --json
```

Without `--json`, the CLI prints headroom, separate host/Codex pressure, top
consumers, service names, and recommendations. Add `--output <file.json>` for
a before/after baseline. Add `--app-server-pid <PID>` to scope the Codex tree;
host readings and top consumers remain system-wide.

If prerequisites or visibility are uncertain:

```text
node "<skill-directory>/scripts/ramraccoon.mjs" doctor --json
```

`doctor` is also read-only. It reports ready, partial, unavailable, or unsupported
and exits nonzero when not ready. Do not convert an unavailable reading to zero.

### Platforms, architectures, and device boundaries

Node 20+ is required; prefer a supported LTS release. The source has native
collectors for Windows, macOS, and Linux. It has no architecture-specific
binary. Do not infer native validation from that fact or from a configured CI
matrix: Windows x64 is locally verified; macOS/Linux/ARM64 native validation
is pending. `doctor` checks capability in the actual execution environment.

- **Windows:** PowerShell 7 or Windows PowerShell plus CIM. Report available physical memory, enforced system commit headroom, private bytes, working set, and service names when readable.
- **Linux:** `/proc` plus readable cgroup v1/v2 limits, including visible ancestors. No `ps` dependency. `Committed_AS / CommitLimit` is enforced pressure only with overcommit mode 2; modes 0/1 are accounting, not Windows-style hard limits.
- **macOS:** `sysctl`, `vm_stat`, and `ps`. Available RAM is explicitly an estimate from free + inactive + speculative pages. Do not add overlapping purgeable pages. Use the kernel pressure signal when available; do not call the estimate an exact OS availability counter.
- **WSL, containers, ChromeOS Linux environments, and remote sessions:** readings belong to the visible guest/process namespace and its readable limits, not automatically the physical host or client device. Run separately in Windows to inspect the WSL host.
- **Phones, browser sandboxes, BSD, or unsupported runtimes:** do not pretend host APIs exist. A mobile/browser remote client can run the tool on a supported remote machine; that does not inspect the phone. Report the actual limitation.

### Interpret the report

- `Host.PhysicalAvailableGiB` and `Host.CommitAvailableGiB` are different headroom measurements. Commit headroom is unavailable when enforcement is unknown or not applicable.
- `Host.PhysicalAvailabilityKind` labels the source/estimate. `Host.Cgroup` describes visible Linux constraints, not permission to manage the host.
- `TopProcesses` contains up to ten consumers ranked by Windows private bytes or macOS/Linux RSS. Several services can share a PID; memory belongs to the process, not independently to each listed service.
- `Services: null` means unknown/not collected; `[]` means no matching running service was found. Neither means safe to stop.
- macOS/Linux tree totals are summed RSS and may double-count shared pages.
- `Risk.HostLevel` describes host/visible-limit pressure; `Risk.CodexLevel` describes the app-server footprint. They are separate. An incomplete scan can leave Codex status `UNKNOWN`.
- `CollectionWarnings` explains missing optional counters or incomplete visibility. `Totals.ProcessScanComplete: false` blocks recovery and prevents claimed Codex reductions from missing processes.
- No app-server does not mean Codex is closed: standalone CLI processes may still appear among top consumers. They are not recovery targets.

| Level | Smallest safe next step |
|---|---|
| HEALTHY | Keep the check read-only; this is not proof of no leak |
| ELEVATED | Inspect measured consumers and avoid unnecessary delegation |
| HIGH | Stop new delegation, preserve active work, identify what is large |
| CRITICAL | Checkpoint immediately; propose recovery only if a measured Codex tree justifies it, then obtain approval |
| UNKNOWN / partial | State the missing evidence; do not infer successful cleanup |

Physical/enforced-limit investigation thresholds are 80/90/95 percent, with
available OS pressure signals interpreted separately. Codex footprint triggers
are 4/8/12 GiB or 100/200/300 processes. These are heuristics, not ownership
proof, leak detection, or authorization to terminate anything.

## Audit logical child agents when relevant

1. Use only an agent-listing API actually exposed by the host. For example, call `collaboration.list_agents` only when available. Without an API, report logical inventory unavailable and continue the OS snapshot; process counts do not reveal task state.
2. Compare each non-root agent with the current objective, remaining work, delivered results, and external work that would be lost.
3. Classify:
   - **KEEP:** unique unfinished work still needed.
   - **INTERRUPT:** clearly obsolete, duplicated, superseded, or already delivered work.
   - **CLOSE:** result collected and a documented close/unload operation is genuinely available.
   - **UNCERTAIN:** insufficient ownership or necessity evidence; preserve it.
4. Show the decisions before or alongside authorized actions. An audit alone is not cleanup approval.
5. Re-list after actions. Report logical state separately from process residency and re-measure before claiming memory changed.

## Measure before and after

Capture a full JSON baseline before the action and another after the action and
resume. Use the same host and selection scope. A restarted selected tree has a
new PID; select that new PID in the after snapshot too.

```text
node "<skill-directory>/scripts/ramraccoon.mjs" compare --before <before.json> --after <after.json> --json
```

Report raw before/after values and signed deltas. Missing readings stay `null`.
Incomplete process scans, incompatible metrics, and known OS/scope mismatches
do not become Codex savings. The comparator cannot authenticate that two files
came from the same machine. A `Reclaimed` value is an observed decrease, not
proof of causation. Never claim savings without a usable after measurement.

## Checkpoint before recovery

Save outside the runtime's volatile state:

- current objective;
- completed work and evidence;
- remaining work;
- external commands/services that must survive;
- workspace and uncommitted-change state;
- exact first instruction for resuming.

Do not recover while a required external service remains under the selected
app-server. The operation may stop its terminals, MCP servers, and services.
The CLI enforces target/approval flags; it cannot judge checkpoint sufficiency.

## Explicit runtime recovery

“Audit,” “check,” or “housekeeping” does not authorize this operation. Only an
explicit request to recover/restart or approval of the displayed checkpoint
and disconnect does.

1. Re-run the snapshot and select exactly one top-level `AppServers` PID.
2. Show the checkpoint, PID, process count, metric-labelled footprint, and disconnect consequences.
3. After approval, substitute the actual PID, evidence directory, and optional thread ID:

```text
node "<skill-directory>/scripts/ramraccoon.mjs" recover --app-server-pid <PID> --output-dir <checkpoint-directory> --thread-id <thread-id> --yes
```

The worker records a full before snapshot, waits 15 seconds, re-verifies the
root's PID/start identity and current descendant tree, and performs scoped
termination. Windows launches the worker outside the selected runtime's job
object. Ordinary housekeeping protects the root; this separate, approved
operation intentionally disconnects it. Persisted transcripts are not edited.

The worker's lightweight after sample establishes whether the recorded target
identities remain, not full post-resume host memory. Physical/commit after
readings are intentionally `null`. Reopen the task or use `codex resume
<thread-id>`, take a full normal scoped snapshot, and compare with
`*-before.json` for the new baseline.

If status is `partial` or `failed`, report it and stop. Do not broaden the kill
target, infer success from signal delivery, or confuse PID reuse with survival.
Process enumeration and termination are not an atomic OS transaction.

## Report compactly

```text
RAM Raccoon: <level; collection limitations if any>

Agents
- <agent>: <KEEP|INTERRUPT|CLOSE|UNCERTAIN> — <evidence, or inventory unavailable>

Runtime
- Scope: <OS, architecture, native/guest/container>
- Memory: <used/total and available; commit or cgroup headroom when applicable>
- Pressure: <host; Codex app-server>
- Top consumers: <PID/name, metric versus resident RAM; Windows services>
- Codex app-server trees: <count and metric-labelled footprint>

Actions
- <read-only audit, verified lifecycle action, or approved recovery result>

Next
- <smallest safe next step>
```

## Development checks

From the source repository: `npm test`, then `npm run test:live` and
`npm run test:recovery`. The last two use disposable fixtures owned by the tests;
never substitute a user's live Codex PID. From an installed skill, use `doctor`
and a read-only `snapshot`; repository tests are not installed with the skill.
