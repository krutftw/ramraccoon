# Security and safety

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/krutftw/ramraccoon/security/advisories/new) when enabled. If unavailable, open an issue requesting a private contact without publishing vulnerability details, live command lines, credentials, private paths, or task content.

## Capabilities, not an audit certificate

RAM Raccoon is a local diagnostic tool with a separately invoked destructive
recovery command. No independent security audit is claimed. The repository
contains no bundled native executable or third-party runtime dependency.
Installing or updating through npm/skills uses the network; ordinary runtime
collection and comparison do not upload data or download code.

| Operation | Reads | Changes |
|---|---|---|
| `doctor` / `snapshot` | Local OS memory counters, visible process metadata, Windows services when available | Console output; snapshot file only if explicitly requested |
| `compare` | Two user-selected JSON files | Console output |
| Skill housekeeping | Available agent inventory and task ownership | Only explicitly authorized non-root agent lifecycle operations |
| `recover` | A selected Codex app-server identity and current descendant tree | Evidence files, a short-lived detached worker, and termination of the approved tree |

Start with ordinary user permissions. Restricted collectors report unavailable
or partial data. Do not bypass OS isolation, grant root/administrator access,
or weaken process visibility controls simply to obtain a complete report.

## Recovery boundary

The CLI requires `--yes`, an explicit positive PID, a recognized top-level
Codex app-server, a complete visible process scan, and a process start identity.
It refuses a process-namespace init (PID 1 inside a namespace, or one seen from
outside through Linux `NSpid`), because stopping it ends every process in the
namespace, and an app-server this user cannot signal. The internal worker
refuses unless the evidence directory's report still records a scheduled job
for the same PID and start identity, and stands down if it no longer does
after the delay. That check prevents stale or mismatched worker runs; it does
not authenticate who wrote the report, so keep the evidence directory private
and never invoke `__recover-worker` directly.
A fresh scan re-verifies the target before action. Linux birth identities use
boot ID plus process start ticks; macOS and Windows use native start identity.
Recorded identities, not signal delivery or a reused PID alone, determine
whether the recorded processes remain. Windows console/terminal host processes
and the recovery worker are excluded from the termination list. Windows keeps
an exited parent's PID as a process's parent and later reuses that PID, so a
process that started before its recorded parent is not treated as its child.

These checks mitigate mistakes; enumeration and termination are **not atomic**.
A rapidly changing process tree or PID reuse can race between checks and OS
signals. A process can leave the tree during the delay, for example when its
parent exits; it is not stopped. The worker counts such survivors from the
before snapshot and reports `partial`. A process that refuses a signal because
another user owns it, or a replacement child that a planned process starts
during termination, also leaves the result `partial`. On Windows the root is
stopped last, so children that would die with it in a job object cannot free
PIDs for reuse while the loop still signals them. The tool does not claim
to discover every formerly owned orphan or every hidden host process. Failed or
partial results never authorize expanding the target.

The operator must save a useful checkpoint and explicitly approve the exact
target and disconnect. The CLI cannot verify checkpoint sufficiency. Recovery
may stop runtime-owned terminals, MCP servers, and services; do not run it while
any required external work must survive beneath that runtime. It never edits
persisted task transcripts, but unsaved volatile work can still be lost.

A lightweight worker after-sample is termination evidence, not a full host
memory measurement. Missing physical/commit counters remain `null`. Capture a
normal post-resume snapshot before claiming a new memory baseline.

## Privacy

Full process command lines are inspected transiently for classification and
are not included in snapshot output or termination plans. On Windows, the
PowerShell collector emits a full command line only for Codex processes, which
are classified by it (and, in test mode, for the test fixtures); other
processes contribute only the MCP marker names they contain, and the collector
omits its own. Where a policy enables PowerShell transcription, those Codex
command lines can be recorded in the transcript. Reports still contain
process names, PIDs, start identities, OS information, and Windows service
names. Recovery metadata also contains user-selected evidence paths and an
optional thread ID. External-tool errors may contain local details.

Choose a private evidence directory outside any repository or shared folder;
`--output-dir` defaults to `.ramraccoon` in the current directory, which for a
coding agent is usually the project being worked on. Review reports before sharing, and remove
sensitive names, paths, IDs, and error details. Do not upload raw process lists
or task checkpoints in public issues. Snapshots are not authenticated or a proof
that two files came from the same host.

## Testing boundary

`RAMRACCOON_TEST_MODE=1` makes any process whose arguments contain the test
fixture's exact `ramraccoon-test-app-server` marker count as an app-server, and
permits `recover --foreground`, which runs the worker inside the calling process.
Such a process counts as top-level unless another marked process is above it,
even beneath a real Codex app-server, so the tests can run from a Codex task
(recovery itself still needs a complete process view outside any sandbox).
The internal `__recover-worker` command accepts `--internal-test-mode` to carry
the same mode into the Windows worker, which does not inherit the environment;
no other command accepts that flag. Test mode is for repository tests, not a
supported operational recovery mode. It does not remove explicit target,
approval, identity, or descendant-scope checks. Unset it for normal use. Controlled tests own every target they terminate; a
successful fixture test is not evidence of a real user's Codex recovery.
