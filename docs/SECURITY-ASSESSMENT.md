# Security assessment: RAM Raccoon

## Executive summary

- Overall risk level: **SAFE BY DEFAULT; EXPLICITLY DESTRUCTIVE RECOVERY**
- Source: `https://github.com/krutftw/ramraccoon`
- Evaluation date: 30 July 2026
- Evaluator: maintainer using the Agent Skill Evaluator workflow
- Prompt injection, credential access, network clients, obfuscation,
  persistence, and data exfiltration were not found.
- v0.3 adds an intentional process-tree termination command. Use it only after
  reviewing the checkpoint and exact target.

This is a maintainer-generated assessment, not an independent audit.

## Source and provenance

The project is a public GitHub repository with readable history, an MIT
license, contributing guidance, a security policy, tagged releases, and no
bundled native executables.

The first clean `npx skills add` run reported:

| Scanner | Install-time result |
|---|---|
| Gen Agent Trust Hub | Safe |
| Socket | 0 alerts |
| Snyk | Low Risk |

Those results applied to the earlier read-only release and are supporting
evidence only. v0.3 must be reviewed on its current source because its recovery
capability changes the operational risk.

## Installed skill structure

```text
SKILL.md
agents/openai.yaml
assets/ramraccoon-mark.svg
scripts/Get-RamRaccoonSnapshot.ps1
scripts/Compare-RamRaccoonSnapshots.ps1
scripts/ramraccoon.mjs
```

There are no install hooks, remote scripts, third-party runtime packages,
compiled binaries, or hidden executable files. The portable script requires
Node 20 or newer.

## Skill instruction review

No system-prompt override, role manipulation, encoded instruction, hidden
Unicode, conditional backdoor, or output-hiding pattern was found.

The skill:

- never interrupts the root/current agent;
- keeps uncertain agents running;
- distinguishes logical interruption from memory reclamation;
- keeps audits and snapshots read-only;
- requires a saved checkpoint and explicit approval before recovery;
- forbids invented lifecycle tools and target broadening;
- requires one top-level app-server target with exact identity verification.

Snapshot mode needs read access to the collaboration tree and local process
metadata. Recovery additionally needs authority to terminate the selected
runtime tree and write evidence in a user-selected directory.

## Script review

### PowerShell snapshot and comparator

`Get-RamRaccoonSnapshot.ps1` takes bounded Windows process and memory snapshots.
It reads command lines transiently to classify known MCP families, emits no
command lines, makes no network request, writes no file, and terminates no
process.

`Compare-RamRaccoonSnapshots.ps1` reads two user-selected JSON files and
calculates signed deltas. It performs no process or network operation.

### Portable Node runtime

`ramraccoon.mjs` supports Windows, macOS, and Linux. The same source runs on x64
and ARM64. Snapshot and comparison commands are read-only and emit only
aggregate process data.

The `recover` command is intentionally destructive. Reviewed controls:

- `--yes` is mandatory;
- the target must identify as a Codex app-server;
- the selected PID and exact process-start timestamp are checked twice;
- recovery uses a fresh bounded process tree;
- only the selected root and its descendants are eligible;
- Windows console and terminal hosts are excluded;
- the recovery worker PID is excluded;
- failure or partial termination does not broaden the target;
- persisted task transcripts are not modified;
- a structured before/after result is written after target exit.

On Windows, WMI creates the recovery worker outside the Codex job object so it
can survive the runtime disconnect. This does not create persistence or a
scheduled task. The command line is constructed only from the current Node
executable, checked-in script path, numeric PID, exact timestamp, and
user-selected evidence path.

## Privacy review

Full process command lines can contain private paths and arguments. They are
used only in memory for Codex/MCP classification and never appear in snapshot,
termination-plan, or evidence output. Recovery plans include PIDs, process
names, counts, timestamps, and aggregate memory only.

The project contains no HTTP client, telemetry, credential access, or upload
path.

## References and assets

The skill has no `references/` directory. Its only installed asset is a plain
SVG mark. The SVG contains no script, event handler, remote resource, embedded
data URL, or executable content.

Repository documentation links to the public GitHub project, OpenAI's upstream
issue tracker, GitHub runner documentation, and the MIT license. Runtime code
does not fetch those links.

## Community feedback and external research

Searches performed on 30 July 2026:

- `"RAM Raccoon" Codex skill security`
- `"krutftw/ramraccoon"`
- `site:reddit.com "RAM Raccoon" Codex`
- `"ramraccoon" vulnerability OR malicious OR safety`

No independent review, warning, or relevant discussion was found. Results were
unrelated uses of “Raccoon.” This is expected for a new repository and is
neither positive nor negative security evidence.

## Attack-pattern review

No match was found for:

- prompt or role override;
- zero-width or bidirectional instruction hiding;
- encoded payload or dynamic evaluation;
- external data transmission;
- credential harvesting;
- persistence or self-modification;
- process injection.

Process termination is present only in the declared recovery command. It is
not arbitrary shell execution: candidate processes come from a local bounded
snapshot and are checked against the target tree immediately before action.

The environment-variable test switch resembles a conditional trigger in a
literal scan. It only enables the checked-in isolated fixture marker and does
not bypass `--yes`, exact PID selection, start-identity validation, or
descendant scoping. It is not used by normal skill instructions.

## Risk assessment

| Dimension | Score | Justification |
|---|---:|---|
| Prompt injection | 98/100 | No override, hidden instruction, external content, or obfuscation |
| Code safety | 89/100 | Read-only default; scoped recovery writes evidence and terminates one verified tree |
| Data privacy | 95/100 | Command lines are transient and excluded from output |
| Source trust | 86/100 | Public and transparent, but new and without independent review |
| Functionality | 92/100 | Live Windows detection and controlled recovery passed; real Codex recovery and hosted matrix remain pending |
| **Overall** | **91/100** | Conservative default with a clearly separated higher-risk recovery path |

Remaining risks:

1. recovery stops terminals and services owned by the selected runtime;
2. process-enumeration races can produce a partial result;
3. summed RSS on macOS/Linux can double-count shared pages;
4. MCP-family detection is heuristic;
5. future updates can change the trust profile;
6. macOS/Linux and ARM64 hosted runs are not yet green.

### False-positive analysis

Local process inspection, WMI worker creation, command execution, and process
termination match high-risk static patterns. They are not dismissed as benign
solely because the repository is a system utility:

- inspection is necessary for ownership and memory measurement;
- WMI launches only the same checked-in worker outside the dying Windows job;
- command lines are generated from fixed operations plus validated numeric or
  path arguments and are not accepted as an arbitrary user command;
- termination is the advertised recovery result and remains destructive;
- no network, credential, persistence, or hidden execution path was found.

## Validation evidence

- Public skill install and discovery: passed on the earlier public release
- Windows live snapshot: passed
- Independent Windows process-tree count: exact match in the recorded run
- Invalid PID rejection: passed
- Command-line property absence: passed
- Hidden Unicode scan: clean
- Portable unit contracts: passed locally
- Streamed Linux x64 collector smoke test: passed without remote file writes
- Controlled recovery fixture: 2 target application processes to 0
- Controlled target private memory: 0.07 GiB to 0
- Detached evidence worker after target exit: passed
- Real Codex recovery: pending explicit operator approval
- Six-runner x64/ARM64 hosted matrix: workflow defined, completion pending

## Verdict

Use RAM Raccoon freely for agent audits and read-only snapshots. Use recovery
only when losing runtime-owned terminals is acceptable, the checkpoint is
complete, and the displayed top-level app-server target is correct. If identity
verification fails or the result is partial, stop rather than broadening the
cleanup.

## Evaluation limitations

- The assessment is maintainer-generated and not independent.
- The current source was reviewed locally; install-time marketplace scanners
  have not yet re-scanned v0.3.
- A real Codex runtime recovery has not been approved or measured.
- macOS, Linux, Windows ARM64, and Linux ARM64 hosted jobs are defined but have
  not completed because the repository's Actions execution is currently
  blocked outside the code.
