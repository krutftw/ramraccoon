# Validation

Configured support, parser coverage, native execution, and real Codex recovery
are different claims. This document keeps them separate.

## Current v0.4 results

Local environment: Windows 11 Pro 10.0.26100, x64 Node 24.11.1.

| Check | Observed result |
|---|---|
| `npm test` | 42 passed; 0 failed, skipped, or cancelled |
| `npm run test:live` | Two owned fixture processes detected; both survived the read-only snapshot; private arguments not emitted; doctor ready |
| `npm run test:recovery` | Two selected fixture processes became zero; unrelated fixture survived; detached worker wrote its result |
| Controlled target private memory | Observed decrease of 0.08 GiB; not a claim of host RAM released |
| Packed distribution | `npm pack` included both runtime modules, skill, metadata, and assets; no bundled runtime dependencies |
| Offline local package install | Installed the packed tarball with `--offline --ignore-scripts --no-audit --no-fund` into a temporary prefix |
| Installed CLI shim | `ramraccoon --version` returned 0.4.0; `ramraccoon doctor --json` returned ready on the actual Windows host |
| Clean public skill install | `npx skills add krutftw/ramraccoon -a codex -s ramraccoon -y --copy` installed the published skill in an empty temporary project; its version was 0.4.0 and doctor returned ready |
| Real Codex termination | Not performed or claimed |
| Native macOS/Linux/ARM64/WSL/container execution | Not available for this revision; not claimed |

The compact sanitized record is
[`windows-v0.4.0-controlled-validation.json`](../evidence/windows-v0.4.0-controlled-validation.json).
Tests created their own targets and removed their temporary fixtures; they did
not select a user's Codex PID. The ordinary installed CLI doctor also ran
against the actual host without terminating its detected app-servers.

A regression reproduced an incorrect claim of 12 GiB reclaimed when protected
descendants still survived. It failed before the fix and passed afterward.
The worker now reports excluded survivors separately and does not invent zero
Codex memory for that case. Physical/commit after readings in the lightweight
worker sample remain `null`; a normal post-resume snapshot is still required.

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
recovery with an unrelated survivor, and a package-content check. The Alpine
job runs with networking disabled, a 384 MiB cgroup memory limit, a read-only
source mount, and a PATH without `ps`. It checks the observed limit and exercises
live diagnostics and controlled recovery. Container startup/image pulling is a
CI action, not a runtime dependency of RAM Raccoon.

Runner labels follow [GitHub's documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
A job's `process.arch` must match the selected architecture; an x64 Node process
on an ARM machine does not count as native ARM validation.

### Current external blocker

The [v0.4 push's Actions run](https://github.com/krutftw/ramraccoon/actions/runs/36684952519)
failed before any of its nine jobs started. Every job annotation said:

> The job was not started because your account is locked due to a billing issue.

This is an account-level execution blocker, not a passing test or an observed
code failure. The owner must resolve it before the hosted matrix can provide
native evidence. No billing setting or financial record was changed. Check the
[actual workflow status](https://github.com/krutftw/ramraccoon/actions/workflows/portable.yml)
for subsequent results; do not reinterpret a configured matrix as green.

This local Windows environment had no running Linux container daemon, no
running suitable WSL guest, and no configured remote test host. Unrelated
project VMs were not started or repurposed for this validation.

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

A clean public skill install was recorded on 30 July 2026, and the v0.4 public
install above succeeded again. The current installer displayed Gen “Safe,”
Socket “0 alerts,” and Snyk “Low Risk,” but did not provide scan-commit
provenance. Those labels are not treated as a fresh v0.4 audit or certification.
See [the capability review](./SECURITY-ASSESSMENT.md); no independent audit or
numerical safety score is claimed.
