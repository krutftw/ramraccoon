# Validation

RAM Raccoon is tested as an installed Codex skill, not only as repository source.

The current portable runtime is one dependency-free Node 20+ script. Node is
already present when the documented `npx skills add` installation path is used.
No native binary is shipped, so the same source runs on x64 and ARM64.

## Verified path

On 30 July 2026, the public repository was installed into a clean temporary
project with:

```powershell
npx skills add krutftw/ramraccoon -a codex -s ramraccoon -y --copy
```

The installer:

- cloned `https://github.com/krutftw/ramraccoon.git`;
- discovered exactly one skill named `ramraccoon`;
- copied all five packaged files;
- registered the skill for Codex;
- reported Gen **Safe**, Socket **0 alerts**, and Snyk **Low Risk**.

The clean install was then independently listed with `npx skills list --json`.
`npx skills use krutftw/ramraccoon@ramraccoon` produced the complete invocation
prompt, and the copied PowerShell snapshot executed successfully.

Automated marketplace scanners are supporting evidence, not a substitute for
source review. RAM Raccoon also checks its own bounded-permission contract; see
the [maintainer-generated security assessment](./SECURITY-ASSESSMENT.md).

## Real Windows result

The checked-in [sanitized snapshot](../evidence/windows-2026-07-30-before.json)
was collected from the globally installed public skill:

| Measurement | Observed |
|---|---:|
| Windows commit | 85.51 / 88.83 GiB (96.3%) |
| Codex process tree | 387 processes |
| Codex private memory | 25.27 GiB |
| Codex working set | 7.66 GiB |
| Repeated MCP bundle floor | 17 |
| Classification | CRITICAL |
| Processes terminated | 0 |
| Command lines emitted | No |

The current Codex task had one root agent and no child agents, so the correct
housekeeping decision was to keep the current task and interrupt nothing.

These numbers are deliberately presented as a detection result. They do not
claim RAM was reclaimed. A child-agent interruption is not proof of OS memory
release.

## Controlled recovery result

The explicit recovery engine was exercised on Windows against an isolated Node
fixture with a parent and memory-resident child. The fixture was selected by an
exact PID and process-start identity. Windows console hosts were deliberately
excluded from termination.

| Measurement | Before | After | Delta |
|---|---:|---:|---:|
| Target application processes | 2 | 0 | -2 |
| Target private memory | 0.07 GiB | 0 GiB | -0.07 GiB |

The detached worker survived the target exit and wrote the after-sample and
comparison. The sanitized result is
[`windows-2026-07-30-controlled-recovery.json`](../evidence/windows-2026-07-30-controlled-recovery.json).

This is proof of the scoped termination and measurement mechanism. It is not
presented as a real Codex leak-recovery result. A real Codex result requires the
operator to approve disconnecting the selected live runtime.

## Linux smoke result

The portable source was streamed directly to an existing Linux x64 host and
executed with Node v24.18.0 without installing files. It returned schema 2.0,
used the `summed RSS` metric, completed Linux physical/commit/swap collection,
emitted no command lines, and terminated no process. No Codex app-server was
running on that host, so this validates the Linux collector path rather than a
Codex recovery. See the
[`linux-2026-07-30-smoke.json`](../evidence/linux-2026-07-30-smoke.json)
record.

## Reproduce it

Run the portable repository contract checks:

```text
node --test ./tests/test_portable.mjs
python ./tests/test_skill.py
node ./skills/ramraccoon/scripts/ramraccoon.mjs snapshot --json
```

On Windows, run the legacy collector contract and live end-to-end test:

```powershell
pwsh -NoProfile -File .\tests\Test-RamRaccoonEndToEnd.ps1
```

The end-to-end test verifies:

- live top-level Codex app-server discovery;
- default and PID-scoped snapshot modes;
- rejection of an invalid PID;
- survival of the inspected app-server;
- process-tree count against a separate CIM tree walk;
- physical-memory total against a separate Windows query;
- absence of command-line and username fields in JSON;
- zero process termination;
- before/after comparator behavior.

In the [recorded Windows test run](../evidence/windows-2026-07-30-e2e.json), RAM
Raccoon reported 406 descendants and the independent CIM tree walk also counted
406. The inspected app-server remained alive and the test reported zero
terminations.

Run the controlled destructive fixture separately:

```text
node ./tests/Test-RamRaccoonRecovery.mjs
```

It targets only a process tree created by that test. It never targets a Codex
runtime.

## Cross-platform matrix

The checked-in `Portable checks` workflow covers:

| Runner | Architecture |
|---|---|
| Ubuntu 24.04 | x64 |
| Ubuntu 24.04 ARM | ARM64 |
| macOS 14 | Apple Silicon ARM64 |
| macOS 15 Intel | x64 |
| Windows 2025 | x64 |
| Windows 11 ARM | ARM64 |

These are standard public-repository runner labels documented by GitHub. The
workflow runs the portable unit tests, a live platform snapshot, and the
controlled recovery fixture. The workflow file is present, but a green run must
not be claimed until GitHub accepts and completes the jobs.

## Prove real before and after

Capture a baseline:

```text
node ./skills/ramraccoon/scripts/ramraccoon.mjs snapshot \
  --json --output ./before.json
```

After a separately approved recovery and resume, capture `after.json`, then
compare:

```text
node ./skills/ramraccoon/scripts/ramraccoon.mjs snapshot \
  --json --output ./after.json
node ./skills/ramraccoon/scripts/ramraccoon.mjs compare \
  --before ./before.json --after ./after.json --json
```

The comparator reports raw values and signed deltas. Negative deltas mean the
post-action value is lower. It does not infer causation.

## Security review

The repository contains no network client, credential access, encoded payload,
or dynamic evaluation. Snapshot and comparison modes do not terminate
processes. Recovery is intentionally state-changing, requires `--yes`, writes
evidence files, re-verifies PID plus start identity, scopes termination to one
app-server tree, and excludes Windows console-host processes. Full command
lines are read transiently for classification and never emitted.

No independent community review was found at the time of the first release.
That is expected for a new project and should not be mistaken for independent
validation.
