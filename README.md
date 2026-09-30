<p align="center">
  <img src="./assets/ramraccoon-hero.svg" alt="RAM Raccoon — memory diagnostics for long-running coding sessions" width="100%">
</p>

<p align="center">
  <a href="https://github.com/krutftw/ramraccoon/actions/workflows/portable.yml"><img alt="Portable checks — actual CI status" src="https://github.com/krutftw/ramraccoon/actions/workflows/portable.yml/badge.svg"></a>
  <a href="#platforms-and-devices"><img alt="Windows, macOS and Linux collectors" src="https://img.shields.io/badge/collectors-Windows%20%7C%20macOS%20%7C%20Linux-5D5853?style=flat-square"></a>
  <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-E2552D?style=flat-square"></a>
</p>

# RAM Raccoon

**Find what is using memory before deciding what to stop.**

RAM Raccoon is a local CLI and agent skill for system memory diagnostics,
Codex agent housekeeping, and explicitly approved Codex app-server recovery.
System diagnostics work without Codex installed. No background daemon, extra
MCP server, telemetry, runtime downloads, or third-party runtime dependencies.

It answers three different questions:

1. **Is the system short of memory?** Available RAM, Windows commit headroom,
   Linux container limits, and OS-specific pressure signals.
2. **What is using it?** Top process consumers, Windows service names, and
   separately measured Codex app-server trees.
3. **Can a Codex runtime safely be stopped?** A checkpoint, explicit approval,
   an exact target, and before/after evidence—not a blanket process kill.

A large reading is not proof of a leak. High system pressure does not prove
Codex caused it. Interrupting an agent does not prove its MCP processes exited.

## Start with a read-only check

Requires Node.js 20 or newer; a currently supported LTS release is recommended.
Install the CLI directly from this GitHub repository:

```text
npm install --global github:krutftw/ramraccoon
ramraccoon doctor
ramraccoon snapshot
```

No global install:

```text
npx --yes --package=github:krutftw/ramraccoon ramraccoon snapshot
```

Installation uses the network; the collector itself does not. These commands
work in PowerShell, Command Prompt, and POSIX shells. Start without elevation.
`doctor` reports missing prerequisites or restricted process visibility rather
than recommending administrator/root access automatically.

From a source checkout, replace `ramraccoon` with:

```text
node skills/ramraccoon/scripts/ramraccoon.mjs
```

### Install as an agent skill

```text
npx skills add krutftw/ramraccoon -a codex -s ramraccoon -g -y
```

Then ask:

```text
Use $ramraccoon to check memory pressure and show the largest consumers. Do not stop anything.
```

For agent housekeeping:

```text
Use $ramraccoon to audit my child agents. Keep useful work, identify duplicates, and distinguish interrupted work from released memory.
```

The skill uses only lifecycle tools actually available in its host. No agent
inventory API? It reports that limitation and still runs local diagnostics.
The CLI is useful independently of any agent host; automatic runtime recovery
is specifically for Codex `app-server`, not every AI tool or standalone CLI.

## Understand the readings

| Reading | Meaning and boundary |
|---|---|
| Physical available memory | Windows/Linux OS availability; explicitly labelled free + inactive + speculative estimate on macOS |
| Windows private bytes | Private committed memory, **not** resident RAM; working set is shown separately |
| Linux `Committed_AS / CommitLimit` | Accounting, not a hard exhaustion threshold in overcommit modes 0 or 1; used as enforced pressure only in mode 2 |
| Linux cgroup memory | Visible v1/v2 and ancestor constraints; container pressure can be high while the host has free RAM |
| macOS/Linux Codex memory | Summed RSS; shared pages can be counted more than once |
| Host versus Codex pressure | Separate classifications; footprint thresholds are investigation triggers, not permission to terminate |
| Unknown or partial data | Warnings and `null` readings, never invented zeros or successful recovery |

Top consumers are ranked by private bytes on Windows and RSS on macOS/Linux.
Several Windows services may share a process; its memory cannot be attributed
independently to each service. No detected app-server does **not** mean all Codex
processes are closed.

## Platforms and devices

Support depends on the OS running Node and the process namespace it can see,
not whether the device is called a laptop, server, tablet, or development board.

| Environment | Collector behavior | Current v0.4 verification |
|---|---|---|
| Windows x64 | CIM via PowerShell 7 or Windows PowerShell; RAM, commit, services, process trees | Live snapshot, doctor, controlled recovery passed locally |
| Windows ARM64 | Same collector with native ARM64 Node | Native CI target; not yet verified |
| macOS Intel / Apple Silicon | `sysctl`, `vm_stat`, `ps`; labelled availability estimate and optional kernel pressure | Parser regressions passed; native CI pending |
| Linux x64 / ARM64 | `/proc` and cgroups; does not require `ps` | Parser regressions passed; native CI pending |
| WSL | Inspect the Linux guest; run the Windows command separately to inspect Windows | Detection implemented; no current native WSL proof |
| Docker / Kubernetes / Linux development containers | Inspect visible processes and readable cgroup limits, not the entire host | Ancestor/v1/v2 parser tests passed; offline Alpine CI configured |
| ChromeOS Linux environment / ARM Linux boards | Linux collector where Node 20+ and required `/proc` data are available | Device-specific validation not claimed |
| Android, iOS/iPadOS, browser sandboxes, BSD | No supported native system collector | Use a desktop/server runtime; a mobile remote client measures its remote host, not the phone |

Other Node architectures and emulated runtimes are not certified. `doctor`
checks local capability; it is not a substitute for native platform testing.
A restricted process scan blocks recovery rather than treating hidden
processes as gone. Details and reproducible checks:
[validation evidence](https://github.com/krutftw/ramraccoon/blob/main/docs/VALIDATION.md).

**Hosted verification is currently blocked by a GitHub account billing lock.**
The workflow explicitly selects native x64/ARM64 Node and checks the actual
runtime identity. Configuring those jobs is not evidence that they passed.

## Save and compare

```text
ramraccoon snapshot --json --output before.json
ramraccoon snapshot --json --output after.json
ramraccoon compare --before before.json --after after.json --json
```

Capture `after.json` after the action you want to measure. Use the same machine
and selection scope. `--app-server-pid` limits Codex tree measurements; host
memory and top consumers remain system-wide. When comparing a restarted
selected tree, select its new PID for the after snapshot too.

The comparison retains before/after values and signed deltas. Missing readings,
incomplete process scans, incompatible memory metrics, or known OS/scope
mismatches do not become a claimed Codex reduction. `Reclaimed` means an
observed decrease—not proof of causation. Snapshots are not authenticated and
cannot independently prove they came from the same machine.

## Recovery: separate and destructive

Do not use recovery as an automatic response to a warning. First save a resume
checkpoint outside the live runtime: objective, completed work, remaining work,
workspace state, external commands that must survive, and first resume step.
Show the exact target and obtain explicit approval to disconnect it.

Only then, substituting the verified PID and optional thread ID:

```text
ramraccoon recover --app-server-pid <PID> --output-dir .ramraccoon --thread-id <THREAD_ID> --yes
```

The angle-bracket values are placeholders, not literal shell arguments.
Recovery records a full before snapshot, waits 15 seconds, re-checks PID and
start identity, and stops the selected top-level app-server tree. It does not
select targets by age, idle CPU, duplicate names, or memory size. Runtime-owned
terminals, MCP servers, and services may stop. Persisted task transcripts are
not modified. The CLI cannot verify that your checkpoint is sufficient.

The worker writes `*-recovery.json` and a lightweight `*-after.json`. These
prove the recorded termination result, **not full post-resume host memory**.
Reopen the task or use `codex resume <THREAD_ID>`, take a normal scoped snapshot,
and compare it with `*-before.json`. A `partial` or `failed` result is a reason
to investigate, never to broaden the kill target.

Ordinary audits never interrupt the root/current session. Explicit runtime
recovery is the separate operation that intentionally disconnects it.
See [SECURITY.md](./SECURITY.md) for permissions, privacy, and race limitations.

## Development and evidence

```text
npm test
npm run test:live
npm run test:recovery
```

The live checks create their own temporary fixtures. The recovery check stops
only its selected fixture tree and verifies an unrelated fixture survives. It
does not terminate a real Codex runtime. Current local result: **42 regression
tests passed**, Windows x64 live diagnostics passed, controlled target **2 → 0
processes**, unrelated fixture survived. Native macOS/Linux/ARM64 results remain
pending; earlier-release evidence is labelled separately in
[VALIDATION.md](./docs/VALIDATION.md).

## Why this exists

The upstream [Codex lifecycle issue](https://github.com/openai/codex/issues/25015)
describes retained agent/session and MCP resources across Windows, macOS, and
Linux. RAM Raccoon is a diagnostic and explicitly approved recovery layer, not
an upstream fix, a universal RAM cleaner, or a persistent LLM memory service.

Memory interpretation follows the
[Linux overcommit documentation](https://docs.kernel.org/mm/overcommit-accounting.html)
and [cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).
Platform jobs use [GitHub's documented runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

Found incorrect output on your platform? Open an issue with the version, OS,
architecture, native/guest/container scope, sanitized `doctor --json` output,
and expected behavior. Do not post command lines, secrets, or private paths.
See [CONTRIBUTING.md](./CONTRIBUTING.md) and [SECURITY.md](./SECURITY.md).
