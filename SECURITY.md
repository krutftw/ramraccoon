# Security

## Reporting

Please report a vulnerability through GitHub private vulnerability reporting when available. Do not include live process command lines, tokens, private paths, or task content in a public issue.

## Safety model

RAM Raccoon v0.1 is read-only at the operating-system layer. The bundled script:

- reads Windows process and memory metadata;
- emits aggregate process-family counts;
- suppresses full command lines;
- never calls `Stop-Process`, `taskkill`, WMI termination methods, or native termination APIs.

The agent workflow may recommend or invoke Codex's documented child-agent interruption operation when the user requested cleanup. Interruption is not presented as proof that an MCP runtime was unloaded.

Any proposal to terminate processes automatically must include a verifiable ownership protocol, PID-reuse protection, dry-run behavior, recovery design, and adversarial tests. Age/name heuristics are not sufficient.
