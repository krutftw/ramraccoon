# Capability review and assessment limits

This document is a maintainer explanation of the current capability boundary,
not an independent audit or security certification. Previous self-assigned
numerical safety scores have been removed: they did not establish measured
risk or prove the destructive path safe on every platform.

## Current v0.4 structure

```text
skills/ramraccoon/
  SKILL.md
  agents/openai.yaml
  assets/ramraccoon-mark.svg
  scripts/ramraccoon.mjs
  scripts/platform.mjs
```

One Node CLI implements comparison and explicitly requested recovery; the
platform module implements local read-only collection. There are no install
hooks or third-party runtime dependencies in `package.json`. The CLI invokes
fixed OS utilities rather than accepting an arbitrary user shell command.

The important boundary is capability, not the presence of a reassuring badge:

- Snapshot and doctor read local process/memory metadata without terminating
  processes. Comparison reads only the two supplied files.
- Recovery intentionally writes evidence and terminates one explicitly selected
  Codex app-server tree after identity and visibility checks.
- A logical child-agent interruption is not reported as proof of OS cleanup.
- Unknown measurements and incomplete scans do not become zeros or reclaimed RAM.
- Command arguments are not emitted in snapshots, but names, IDs, service names,
  and recovery evidence paths can still be sensitive.
- Process enumeration and OS termination are not atomic; identity checks do
  not remove every race, reparenting case, or visibility limitation.

Read [SECURITY.md](../SECURITY.md) for permissions, privacy, checkpoint
responsibility, fixture mode, and the limitations of recovery evidence.

## Evidence and limits

The current local verification exercised 57 behavior regressions on Windows
x64 and 56 on Linux x64 under WSL2 (Ubuntu and Alpine), read-only diagnostics
against owned fixtures, and controlled recovery where the selected processes
exited, an unrelated fixture survived, a process that left the tree was
reported `partial`, and an abandoned job left its target running. It also
checked a cgroup-v2 memory limit and a Codex-style bubblewrap sandbox inside
WSL2. It did not terminate or claim to repair a real Codex runtime. Native
Linux hardware, macOS and ARM64 results are not yet available for this release.

See [VALIDATION.md](./VALIDATION.md) for reproducible commands, native versus
parser-only coverage, current CI blockers, and earlier-release evidence.

Both the historical installer and the v0.4.0 clean public install displayed
Gen “Safe,” Socket “0 alerts,” and Snyk “Low Risk.” The v0.4.0 installer did not
identify which source commit those assessments scanned, and the non-interactive
v0.4.1 install displayed no labels. The labels are not treated as a fresh v0.4
review or certification of recovery. No current independent
audit, verified marketplace rescan, or numerical security score is claimed.
