# Validation

RAM Raccoon is tested as an installed Codex skill, not only as repository source.

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
claim RAM was reclaimed. RAM Raccoon cannot unload the executing Codex
app-server, and a child-agent interruption is not proof of OS memory release.

## Reproduce it

Run the repository contract checks:

```powershell
python .\tests\test_skill.py
pwsh -NoProfile -File .\tests\Test-RamRaccoonSnapshot.ps1
```

Run the live end-to-end test:

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

In the [recorded test run](../evidence/windows-2026-07-30-e2e.json), RAM
Raccoon reported 406 descendants and the independent CIM tree walk also counted
406. The inspected app-server remained alive and the test reported zero
terminations.

## Prove before and after

Capture a baseline:

```powershell
pwsh -NoProfile -File `
  .\skills\ramraccoon\scripts\Get-RamRaccoonSnapshot.ps1 `
  -Json | Set-Content .\before.json
```

After a separately approved Codex restart, capture `after.json`, then compare:

```powershell
pwsh -NoProfile -File `
  .\skills\ramraccoon\scripts\Compare-RamRaccoonSnapshots.ps1 `
  -Before .\before.json `
  -After .\after.json `
  -Json
```

The comparator reports raw values and signed deltas. Negative deltas mean the
post-action value is lower. It does not infer causation.

## Security review

The repository contains no network client, credential access, encoded payload,
dynamic evaluation, process termination, or write operation in its runtime
snapshot. A hidden-Unicode scan found no zero-width or bidirectional control
characters. The script reads one CIM process snapshot, aggregates selected
fields in memory, and emits a bounded JSON schema.

No independent community review was found at the time of the first release.
That is expected for a new project and should not be mistaken for independent
validation.
