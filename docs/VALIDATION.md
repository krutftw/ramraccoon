# Validation

Configured support, parser coverage, native execution, and real Codex recovery
are different claims. This document keeps them separate.

## Current v0.4 results

v0.4.2 comes from a multi-agent review of v0.4.1: area reviewers, then three
independent verifiers for each finding, repeated until rounds stopped finding
new defects, then the same process over the changes themselves. Each fixed
defect was reproduced first; most have a regression test that fails on v0.4.1.

| Check | Windows 11 Pro 10.0.26100, x64, Node 24.11.1 | WSL2 Ubuntu 22.04.5, x64, Node 24.21.0 | WSL2 Alpine 3.24, x64, Node 24.18.1 |
|---|---|---|---|
| `npm test` | 57 passed | 56 passed, 1 Windows-only skipped | 56 passed, 1 Windows-only skipped |
| `npm run test:live` | Passed; doctor ready; a real `codex.exe app-server` copy of Node detected from its command line | Passed; doctor ready | Passed; doctor ready |
| `npm run test:recovery` | Passed: selected tree stopped, unrelated fixture survived, a detached survivor reported `partial`, an abandoned job left its target running; hidden-console check conclusive (classic console host) | Passed, same scenarios | Passed, same scenarios |
| Sandbox detection | — | — | Codex-style `bwrap --unshare-pid --as-pid-1` with a helper as PID 1: `WSL guest (bubblewrap sandbox)`, scan incomplete, `UNKNOWN` |
| Namespace init seen from outside | — | Detected through `NSpid` | Detected through `NSpid` |
| cgroup v2 limit | — | — | 384 MiB `memory.max` read as 0.38 GiB; after a 300 MiB file read, raw usage was 309 MiB with 300 MiB inactive file cache, reported as 5.9% used (v0.4.1 reported 83.8% and `ELEVATED`) |
| Packed distribution | `npm pack`: 15 files, both runtime modules, skill, metadata, assets; no runtime dependencies | — | — |
| Offline package install | The packed tarball installed with `--offline --ignore-scripts --no-audit --no-fund` into a temporary prefix; `ramraccoon --version` returned 0.4.2 and `doctor --json` returned ready | — | — |
| Clean public installs | PUBLIC_INSTALL_RESULT | — | — |
| Real Codex termination | Not performed or claimed | Not performed or claimed | Not performed or claimed |

The Linux runs used two existing local WSL2 distributions. The repository was
extracted into `/tmp` inside each guest, the tests ran there, and the copies
were removed; the cgroup and sandbox checks created and removed their own
cgroup and namespaces. WSL2 runs a real Linux kernel, but these are guest runs,
not native Linux hardware, macOS, or ARM64 results. The compact record is
[`v0.4.2-local-validation.json`](../evidence/v0.4.2-local-validation.json); the
[v0.4.1](../evidence/windows-v0.4.1-controlled-validation.json) and
[v0.4.0](../evidence/windows-v0.4.0-controlled-validation.json) records are retained.
Tests created their own targets and removed their temporary fixtures; they did
not select a real Codex PID.

Defects fixed in v0.4.2 include: recovery adopting unrelated Windows processes
through recycled parent PIDs; recovery reports counting processes that left
the tree, refused a signal, or were started during termination as reclaimed;
Windows PowerShell 5.1 exceeding its time limit on large trees after the
app-server had stopped; Windows snapshots failing under Japanese and Chinese
code pages and in Constrained Language mode; PowerShell lookup through the
current directory and `node_modules\.bin`; cgroup page cache counted as
pressure; Codex's Linux sandbox and other private process views reported as
healthy; macOS prompts and `app-server` helper subcommands mistaken for servers;
swapped compare inputs reported as reductions; npm 12 refusing the documented
install command; and the Linux live test failing on Node 23.8 and later.

v0.4.1 added checks for three defects found after v0.4.0, each reproduced before
its fix: the Windows recovery worker opened a visible console window, and
closing it would end the worker mid-recovery; `compare` rejected snapshots
saved by Windows PowerShell 5.1 redirection; and an incomplete process scan
with no crossed threshold reported an overall `HEALTHY`. A v0.4.0 regression
reproduced an incorrect claim of 12 GiB reclaimed when protected descendants
still survived; the worker reports excluded survivors separately.

## Recorded recovery images

The README's [before/after image](../assets/recovery-proof.png) and
[narrow-screen version](../assets/recovery-proof-mobile.png) render the
[same sanitized capture](../evidence/windows-v0.4.0-recovery-proof.json).
They are visualizations of recorded CLI evidence, not Task Manager screenshots
or images of a real Codex leak fix.

The capture completed on **30 September 2026 at 08:31 UTC**, using RAM Raccoon
0.4.0 on Windows x64 / Node 24.11.1. The JSON includes the source commit, runtime
file SHA-256 hashes, original measurement timestamps, and unmodified comparison
values. It excludes command lines, paths, credentials, and real process inventory.

This run's selected tree contained **four processes: two Node fixture
applications and two Windows console helpers**. Its measured private committed
memory was **0.08 GiB before**. Recovery targeted only the two applications;
the protected console helpers exited with their owners. The worker reported
zero remaining scoped identities and **0.00 GiB selected-tree footprint**.
An independent post-recovery process scan confirmed all recorded identities
were gone and both unrelated fixture applications were still alive.

The capture reused `tests/fixture-support.mjs` and the actual `recover` CLI, with
the controlled test's five-second delay and one-second settle interval. It also
checked the whole scoped tree by birth identity. An initial capture assumption
that the whole tree always contained only two processes was corrected after a
read-only scan identified the console helpers; no runtime change was required.

The existing test's “2 target application processes” and this image's “4 scoped
processes” describe different, explicitly labelled counts. Console helper
presence can vary; do not hard-code an application count as the full-tree count.
The unrelated fixture was cleaned up only after its survival was verified.

The after value comes from confirmed exit of the recorded identities, not a
full host-memory sample. System physical-memory and system-commit deltas remain
`null`. Private committed memory is not resident RAM; neither image claims
system-wide savings, a real Codex recovery, or native cross-platform validation.
The full post-resume baseline remains required for a real recovery.

## What the regressions establish

- Missing after-readings remain unknown; they do not become 100% recovery.
- Memory growth, valid zero measurements, mixed metrics, partial process scans,
  OS mismatches, and selection-scope mismatches have distinct outcomes.
- An incomplete process scan with no crossed threshold reports `UNKNOWN`, not
  `HEALTHY`.
- `compare` reads snapshots saved as UTF-16LE by Windows PowerShell 5.1
  redirection or with a UTF-8 byte-order mark, and names a snapshot file it
  cannot use.
- Process names or an `app-server` string in a prompt/config value do not alone
  identify a recovery target. Paths with spaces and cyclic ancestry are covered.
- Linux overcommit modes 0/1 do not use `Committed_AS / CommitLimit` as enforced
  exhaustion. Mode 2 does. Cgroup bounds are considered independently.
- Cgroup v1/v2 hybrid mounts, namespace roots, escaped paths, visible ancestor
  bounds, unlimited values, and unknown readings are covered with fixtures.
- macOS page counts honor 4 KiB/16 KiB page size without double-counting purgeable
  pages; process paths containing spaces and unparseable metadata are covered.
- Birth identities distinguish a reused PID from the recorded process.
- Malformed or ambiguous recovery flags do not create recovery jobs.
- The npm symlink entrypoint performs real comparison behavior.

These are behavior tests, not native Linux/macOS/ARM64 certification. They do
not establish real Codex leak recovery, exact attribution of shared RSS, or an
independent security audit.

## Reproduce from source

No dependency installation is required for the source tests:

```text
npm test
npm run test:live
npm run test:recovery
node skills/ramraccoon/scripts/ramraccoon.mjs doctor --json
npm pack --dry-run
```

The recovery test stops only its owned fixture and verifies that a separately
created unrelated fixture survives. Never replace those PIDs with a live user
runtime to obtain a test result. Elevated/root access is not a test prerequisite.

## Hosted platform matrix

`.github/workflows/portable.yml` selects and checks native runtime identity:

| OS / architecture | GitHub runner | Node |
|---|---|---|
| Linux x64 | `ubuntu-24.04` | 22, with additional 20 minimum-runtime and 24 LTS jobs |
| Linux ARM64 | `ubuntu-24.04-arm` | 22 |
| macOS Apple Silicon | `macos-15` | 22 |
| macOS Intel | `macos-15-intel` | 22 |
| Windows x64 | `windows-2025` | 22 |
| Windows ARM64 | `windows-11-arm` | 22 |

Each native job runs behavior regressions, actual scoped diagnostics, controlled
recovery with an unrelated survivor, and `npm pack --dry-run`, which lists the
packed files but asserts nothing about them. The Alpine
job runs with networking disabled, a 384 MiB cgroup memory limit, a read-only
source mount, and a PATH without `ps`. It checks the observed limit and exercises
live diagnostics and controlled recovery. Container startup/image pulling is a
CI action, not a runtime dependency of RAM Raccoon.

Runner labels follow [GitHub's documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
A job's `process.arch` must match the selected architecture; an x64 Node process
on an ARM machine does not count as native ARM validation.

### Current external blocker

The [v0.4.1 push's Actions run](https://github.com/krutftw/ramraccoon/actions/runs/38457601615)
failed before any of its nine jobs started, as did the
[v0.4.0 push's run](https://github.com/krutftw/ramraccoon/actions/runs/36684952519).
Each job carried this annotation:

> The job was not started because your account is locked due to a billing issue.

This is an account-level execution blocker, not a passing test or an observed
code failure. The owner must resolve it before the hosted matrix can provide
native evidence. No billing setting or financial record was changed. Check the
[actual workflow status](https://github.com/krutftw/ramraccoon/actions/workflows/portable.yml)
for subsequent results; do not reinterpret a configured matrix as green.

No Linux container daemon or remote test host was available. For v0.4.2, two
existing WSL2 distributions ran the suites from a temporary copy, as recorded
above; that is local guest evidence, not a passing hosted matrix.

## Device and isolation boundaries

- WSL and containers see the guest/process namespace and readable constraints,
  not automatically all host applications or every hidden cgroup ancestor.
- Windows tablets with Node use the Windows collector. Linux boards and
  ChromeOS Linux development environments use the Linux collector where the
  required OS interfaces are exposed. Device-specific certification is absent.
- macOS/Linux availability and Windows commit are different quantities. Do not
  compare unlike metrics or present Linux overcommit accounting as a Windows
  allocation limit.
- Native Android, iOS/iPadOS, browser sandboxes, and BSD have no supported native
  system collector. A remote session from a phone measures the remote machine.
- `doctor` checks local capabilities. Unknown/restricted readings remain
  explicit, and an incomplete process scan blocks recovery.

## Measured before and after

```text
ramraccoon snapshot --json --output before.json
ramraccoon snapshot --json --output after.json
ramraccoon compare --before before.json --after after.json --json
```

Capture the second snapshot after the action being measured. Use the same host
and selection scope. For an approved restart of one selected app-server, select
its new PID in the full post-resume sample. Do not compare a whole-host app-server
inventory to one selected tree and call the difference reclaimed memory.

Negative deltas indicate an observed decrease, not independent proof of cause.
The worker's lightweight report describes recorded identities after termination;
protected survivors, missing data, and failed scans must not become savings.

## Earlier-release evidence — not v0.4 validation

Retained historical records from the earlier implementation:

| Record | What it established then |
|---|---|
| [Windows detection](../evidence/windows-2026-07-30-before.json) | 387 Codex-tree processes, 25.27 GiB private memory, 96.3% system commit; no termination |
| [Windows independent tree count](../evidence/windows-2026-07-30-e2e.json) | Collector and independent CIM tree walk both counted 406; inspected app-server survived |
| [Controlled Windows recovery](../evidence/windows-2026-07-30-controlled-recovery.json) | Two fixture processes to zero; 0.07 GiB private decrease, not a real Codex recovery |
| [Linux x64 smoke](../evidence/linux-2026-07-30-smoke.json) | Earlier schema 2.0 collector ran with Node 24.18.0 and no Codex target; not validation of the new Linux/cgroup implementation |

A clean public skill install was recorded on 30 July 2026, and the v0.4.0 and
v0.4.1 public installs succeeded again. The v0.4.0 installer displayed Gen
“Safe,” Socket “0 alerts,” and Snyk “Low Risk,” but did not provide scan-commit
provenance. The v0.4.1 install ran non-interactively and displayed no
assessment labels. Those labels are not treated as a fresh v0.4 audit or
certification.
See [the capability review](./SECURITY-ASSESSMENT.md); no independent audit or
numerical safety score is claimed.
