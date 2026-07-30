<p align="center">
  <img src="./assets/ramraccoon-hero.svg" alt="RAM Raccoon — keeps runaway agents from trashing your RAM" width="100%">
</p>

<p align="center">
  <a href="./tests"><img alt="Local checks passing" src="https://img.shields.io/badge/checks-local%20pass-E2552D?style=flat-square&labelColor=161514"></a>
  <img alt="Windows macOS Linux" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-5D5853?style=flat-square&labelColor=161514">
  <img alt="x64 ARM64" src="https://img.shields.io/badge/architecture-x64%20%7C%20ARM64-E2552D?style=flat-square&labelColor=161514">
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-F0EADF?style=flat-square&labelColor=161514"></a>
</p>

<p align="center">
  <strong>The housekeeping skill for long-running AI coding sessions.</strong><br>
  It asks the question agent runtimes forget: <em>“Do I still need these agents running?”</em>
</p>

---

Long-running Codex sessions can retain child agents and complete MCP process
stacks long after useful work finishes. RAM Raccoon audits the logical agent
tree, measures the runtime, checkpoints the task, and—only when you approve
it—restarts one verified Codex app-server tree so the operating system can
actually reclaim the memory.

## Quick start

```powershell
npx skills add krutftw/ramraccoon@ramraccoon -g -y
```

Then ask Codex:

```text
Use $ramraccoon to audit my agents and check memory pressure.
```

Or:

```text
Run housekeeping. Keep agents that still have unique work, interrupt obvious
duplicates, and tell me whether Codex needs a safe restart.
```

To reclaim memory after the checkpoint:

```text
Use $ramraccoon to recover RAM now. Show me the exact app-server target and
checkpoint first, then ask before disconnecting this task.
```

RAM Raccoon is a skill with a short-lived local script, not another always-on
MCP server.

## What it does

| Layer | RAM Raccoon asks | Action |
|---|---|---|
| Child agents | Is there unfinished, unique work? | Keep, recommend interrupt, close when genuinely supported, or mark uncertain |
| Codex runtime | How many processes and repeated MCP markers exist? | Read-only Windows, macOS, or Linux snapshot |
| System memory | Is physical/committed memory approaching exhaustion? | Healthy, elevated, high, or critical pressure |
| Recovery | Can work survive a restart? | Checkpoint, re-verify one app-server tree, terminate it, and measure |

```text
RAM Raccoon: CRITICAL

Agents
├─ explorer       KEEP       unique task still running
├─ duplicate-scan INTERRUPT  result superseded
└─ verifier       UNCERTAIN  preserve until ownership is clear

Runtime
├─ Commit         98.8%
├─ Codex tree     345 processes / 17.2 GiB private
└─ MCP bundles    at least 16 repeated markers

Next
└─ checkpoint active work + restart Codex when safe
```

## The safety line

Audits are read-only. Recovery is a separate, explicit operation:

- It never interrupts the root/current agent.
- It never calls an old process “stale” based only on age or name.
- It never prints full process command lines.
- It does not pretend `interrupt_agent` releases MCP memory.
- It requires a checkpoint and explicit approval before disconnecting a task.
- It re-verifies the exact PID and process start identity immediately before
  terminating one top-level app-server tree.
- It never targets the desktop host or an unrelated Codex runtime.

This is a recovery layer around the current lifecycle bug, not an upstream
app-server patch.

## Run it directly

Node 20 or newer is the only runtime dependency. The same source runs on x64
and ARM64:

```text
node ./skills/ramraccoon/scripts/ramraccoon.mjs snapshot --json
```

The snapshot reports Windows private bytes, or explicitly labelled summed RSS
on macOS/Linux. Full process command lines are inspected only in memory for MCP
classification and are never emitted.

Windows also keeps the original PowerShell collector:

```powershell
pwsh -NoProfile -File .\skills\ramraccoon\scripts\Get-RamRaccoonSnapshot.ps1 -Json
```

## Explicit recovery

After saving a checkpoint and confirming that child processes may stop:

```text
node ./skills/ramraccoon/scripts/ramraccoon.mjs recover \
  --app-server-pid <PID> \
  --output-dir ./.ramraccoon \
  --thread-id <THREAD_ID> \
  --yes
```

The command records a before snapshot, delays for the current turn to finish,
re-verifies the target, and terminates that process tree. The transcript remains
on disk. Reopen the task in the app or run `codex resume <THREAD_ID>`, capture a
new full snapshot, and compare:

```text
node ./skills/ramraccoon/scripts/ramraccoon.mjs compare \
  --before ./.ramraccoon/<RECOVERY>-before.json \
  --after ./after-resume.json \
  --json
```

## Evidence, not promises

A clean install from the public repository was discovered by Codex and executed
against a real long-running Windows session:

| Observed on 30 July 2026 | Result |
|---|---:|
| Windows commit | **96.3%** |
| Codex process tree | **387 processes** |
| Codex private memory | **25.27 GiB** |
| Repeated MCP bundle floor | **17** |
| Safety result | **0 processes terminated** |

That run correctly classified the machine as `CRITICAL`. It is detection
evidence, not a recovery claim: no restart had been approved.

The recovery engine was also exercised against an isolated Windows process
tree. It re-verified the target, preserved console hosts, terminated two target
application processes, and reduced measured target private memory from
0.07 GiB to zero. This proves the worker can survive the target exit and write
its evidence; it is deliberately labelled as a controlled fixture, not a claim
about real Codex recovery. See the
[sanitized controlled result](./evidence/windows-2026-07-30-controlled-recovery.json).

The same source also completed a no-install Linux x64 snapshot with Node
v24.18.0, including Linux memory collection and privacy checks. No Codex
app-server was running there, so this is collector evidence only. See the
[Linux smoke record](./evidence/linux-2026-07-30-smoke.json).

Read the complete [validation method](./docs/VALIDATION.md) and inspect the
[sanitized source snapshot](./evidence/windows-2026-07-30-before.json). The
[security assessment](./docs/SECURITY-ASSESSMENT.md) documents the source
review, attack-pattern scan, and install-time marketplace results.

Run the same live end-to-end check:

```powershell
pwsh -NoProfile -File .\tests\Test-RamRaccoonEndToEnd.ps1
```

## Why this exists

The behavior is tracked upstream in [openai/codex#25015](https://github.com/openai/codex/issues/25015): logical thread/subagent residency can remain coupled to eagerly started MCP runtimes, causing process and memory growth across long sessions.

RAM Raccoon provides a safe operator workflow while the lifecycle is fixed upstream.

## Status

**v0.3.0**

- [x] Main-session child-agent necessity audit
- [x] Read-only Windows Codex process snapshot
- [x] Portable macOS and Linux snapshot
- [x] x64 and ARM64 architecture reporting
- [x] Commit/private-memory pressure levels
- [x] Repeated MCP bundle markers
- [x] Restart checkpoint contract
- [x] Before/after snapshot comparator
- [x] Explicit PID/start-identity-verified recovery worker
- [x] Controlled process-tree memory-recovery test
- [x] Reproducible public-install and live-runtime validation
- [ ] Real Codex recovery measurement after explicit operator approval
- [ ] Green public CI runs across all six OS/architecture runners
- [ ] App-server-native unload when a supported API exists
- [ ] Historical trend snapshots

## Contributing

Reproductions, process-family signatures, and safety improvements are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md) first.

RAM Raccoon is an independent community project and is not affiliated with or endorsed by OpenAI.

<p align="center">
  <sub>Keep the context. Release the runtime.</sub>
</p>
