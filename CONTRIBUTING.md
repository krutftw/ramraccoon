# Contributing

RAM Raccoon treats process cleanup as a safety-sensitive operation.

## Before opening a change

- Keep inspection read-only by default.
- Do not infer process ownership from name, age, or idle CPU alone.
- Do not add automatic process termination.
- Redact usernames, workspace paths, command arguments, tokens, and task content from fixtures.
- Separate logical agent state from OS process residency in reports and tests.

## Development

Validate the skill metadata:

```powershell
python .\tests\test_skill.py
```

Exercise the Windows inspector:

```powershell
pwsh -NoProfile -File .\tests\Test-RamRaccoonSnapshot.ps1
```

Include a concise before/after explanation and the relevant test output in pull requests.
