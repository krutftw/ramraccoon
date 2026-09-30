# Contributing

RAM Raccoon is a diagnostic skill and short-lived CLI, not an automatic RAM
cleaner. System-wide diagnostics and Codex-specific recovery are separate.

## Development

Use Node 20+ (prefer a supported LTS). There are no runtime packages to install:

```text
npm test
npm run test:live
npm run test:recovery
npm pack --dry-run
```

- `npm test`: deterministic behavior regressions for comparisons, process
  classification, PID identities, CLI errors, Linux/cgroup and macOS parsers.
- `test:live`: creates a disposable tree, runs actual diagnostics, verifies
  scope/privacy/read-only survival and local doctor readiness, then cleans up.
- `test:recovery`: creates a target tree and unrelated survivor tree, stops only
  the explicitly selected target, and checks the detached worker's evidence.
  It is destructive **only to its own fixtures**, never an existing Codex PID.

The canonical runtime is `skills/ramraccoon/scripts/ramraccoon.mjs` with
read-only OS adapters in `platform.mjs`. Keep one implementation; do not add
parallel legacy collectors. Keep the installed skill self-contained under
`skills/ramraccoon` and the CLI bin usable through npm's symlink/shim entrypoint.

## Changes worth testing

Test consumer-visible behavior and uncertain boundaries: unknown versus zero,
incomplete visibility, overcommit enforcement, cgroup ancestry, page sizes,
paths with spaces, scope mismatches, PID reuse, and unrelated-process survival.
Do not add tests that pin documentation wording, implementation source text,
forwarded metadata, or self-comparisons. Parser tests do not certify a native OS.

Keep inspection read-only. Never infer ownership from age, name, idle CPU, or
memory size. Do not add automatic process termination, privilege escalation,
always-on background services, network reporting, or hidden fallbacks.
Preserve the distinction between logical agent state and OS process residency.

## Platform reports

Include version/commit, Node version, OS, architecture, native versus guest or
container scope, a sanitized `doctor --json` result, the command, expected
behavior, and observed behavior. Note missing process permissions or counters.
Do not post raw command lines, usernames, workspace paths, credentials, thread
contents, or a real destructive recovery without the owner's explicit approval.

The CI matrix configures Windows/macOS/Linux x64 and ARM64, Node 20/22/24, and an
offline memory-limited Alpine check. A configured job is not a passing job.
Update `docs/VALIDATION.md` only with observed results and actual blockers.
See `SECURITY.md` for disclosure and operational risks.
