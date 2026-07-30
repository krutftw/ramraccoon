# Security assessment: RAM Raccoon

## Executive summary

- Overall risk level: **SAFE**
- Source: `https://github.com/krutftw/ramraccoon`
- Evaluation date: 30 July 2026
- Evaluator: Codex using the Agent Skill Evaluator workflow
- Critical findings: No prompt injection, credential access, network client,
  obfuscation, persistence, process termination, or data exfiltration was found.
- Recommendation: **USE**. Review updates before installing, as with any agent
  skill that can instruct an agent to use system tools.

This is a maintainer-generated assessment. It is transparent evidence, not an
independent audit.

## Source and provenance

RAM Raccoon is maintained in a public GitHub repository with readable history,
an MIT license, contributing guidance, a security policy, tagged releases, and
no bundled binary executables.

A clean `npx skills add` run reported these automated marketplace results:

| Scanner | Install-time result |
|---|---|
| Gen Agent Trust Hub | Safe |
| Socket | 0 alerts |
| Snyk | Low Risk |

These scanners are supplementary. Their results do not replace manual source
review or runtime testing.

## Skill structure overview

The installed package contains five files:

```text
SKILL.md
agents/openai.yaml
assets/ramraccoon-mark.svg
scripts/Get-RamRaccoonSnapshot.ps1
scripts/Compare-RamRaccoonSnapshots.ps1
```

There are no compiled executables, dependency manifests, install hooks, remote
scripts, or hidden files in the skill package.

## SKILL.md analysis

### Prompt injection detection

No system-prompt override, role manipulation, encoded instruction, hidden
Unicode, conditional backdoor, or output-hiding pattern was found.

The skill contains conditional workflow instructions such as choosing between
an agent audit and runtime snapshot. These conditions directly support the
declared housekeeping purpose and do not override user intent or higher-level
instructions.

### Suspicious behavioral instructions

No suspicious instruction was found. The skill explicitly:

- forbids interruption of the root/current agent;
- keeps uncertain agents running;
- separates logical interruption from OS memory reclamation;
- requires explicit approval before restart or termination;
- forbids invented close or unload operations.

### Over-permissioned requests

The skill needs read access to the current collaboration tree and Windows
process metadata. Those permissions are proportionate to its purpose.

## Scripts security analysis

### `Get-RamRaccoonSnapshot.ps1`

The runtime script:

- takes bounded CIM and process snapshots;
- reads process names, parent relationships, memory counters, and command lines;
- uses command lines only in memory to identify known MCP families;
- never emits command lines;
- performs no network request;
- performs no file write;
- invokes no child command;
- terminates no process.

Reading command lines is the main privacy-sensitive operation. It is necessary
for distinguishing MCP families, remains in memory, and is excluded from the
output schema.

### `Compare-RamRaccoonSnapshots.ps1`

The comparator reads two user-selected JSON files and calculates signed deltas.
It performs no process operation, network request, or file write. It refuses
snapshots that do not declare read-only collection and zero terminations.

## References and assets analysis

The skill contains no reference directory. Its only asset is a plain SVG mark.
The SVG contains no script, event handler, remote resource, embedded data URL,
or executable content.

## Community feedback and external research

Exact searches for the project name, repository, Reddit discussion, and
security warnings found no independent review. The repository was newly
released on the evaluation date, so absence of community feedback is expected
and is not treated as positive evidence.

## Attack pattern analysis

No match was found for:

- system-prompt override or role manipulation;
- zero-width or bidirectional instruction hiding;
- encoded payload or dynamic evaluation;
- external data transmission;
- credential harvesting;
- persistence or self-modification;
- arbitrary command execution;
- process injection or termination.

The CIM query is a legitimate system call aligned with the advertised Windows
runtime inspection.

## Risk assessment

### Detailed scoring

| Dimension | Score | Justification |
|---|---:|---|
| Prompt injection | 98/100 | No override, hidden instruction, external content, or obfuscation |
| Code safety | 96/100 | Read-only scripts; no network, write, spawn, or termination path |
| Data privacy | 95/100 | Command lines inspected transiently but excluded from all output |
| Source trust | 86/100 | Public and transparent, but new and without independent community review |
| Functionality | 94/100 | Clean install, discovery, invocation, live run, and independent tree-count verification passed |
| **Overall rating** | **94/100** | Safe design with clearly documented operational limits |

### Threat summary

No malicious threat was identified. Remaining risks are operational:

1. a future update could change the trust profile;
2. MCP-family detection is heuristic;
3. runtime metadata requires ordinary local process visibility;
4. an agent could still misuse unrelated tools if higher-level safeguards were
   removed, which is why the skill repeats its safety contract.

### False positive analysis

Process inspection and conditional agent decisions can resemble high-permission
behavior. They are treated as legitimate because they are bounded, transparent,
necessary for the stated function, and paired with explicit non-termination and
privacy guarantees.

## Final verdict

**Recommendation: USE**

RAM Raccoon is appropriate for read-only runtime inspection and conservative
agent housekeeping. Keep the normal precautions shown in the repository:
review updates, do not assume interruption releases memory, and require explicit
approval for a Codex restart.

Specific concerns: no independent community review yet; Windows-only runtime
inspection; command lines are read transiently for MCP classification.

Safe use cases: child-agent necessity audits, Windows Codex memory snapshots,
before/after comparisons, and restart checkpoint preparation.

Alternative skills: none were identified that combine collaboration-tree
housekeeping with this bounded Windows Codex process inspection.

## Evaluation limitations

- The evaluation covered the repository and public package as of 30 July 2026.
- No controlled restart was performed, so reclaimed memory has not yet been
  measured.
- No unnecessary child agent existed in the evaluating task, so the
  interruption branch was correctly not exercised.
- Automated marketplace results may change as scanners update.

## Evidence appendix

- Public install: passed
- Codex project discovery: passed
- `npx skills use` prompt generation: passed
- Skill structure and SHA-256 capture: passed
- Live runtime snapshot: passed
- Default and PID-scoped modes: passed
- Invalid PID rejection: passed
- Independent process-tree count: exact match in the recorded end-to-end run
- App-server survival: passed
- Command-line property absence: passed
- Username absence: passed
- Process termination count: zero
- Hidden Unicode scan: clean
- Local contract tests: passed
