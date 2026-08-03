# Native CLI Assistant Chat — Design

## Goal

Enable the provider picker’s Codex option to run real assistant chat through
the locally authenticated Codex CLI and the portal-selected `centralmcp`
endpoint. The operator has explicitly approved the lab-only escape hatch:
configuration writes may run immediately through centralmcp without a
per-message confirmation or ticket.

The existing picker, persisted selection, provider status, and chat route stay
the user-facing surface. A provider becomes ready only after the same Codex
launch path completes a real `centralmcp/find_tool` read probe.

## Alternatives considered

1. Reuse the user’s Codex configuration. This can expose unrelated MCP servers,
   skills, or project rules, so it is not suitable for the portal runtime.
2. Use a per-request `codex exec` invocation. This uses saved CLI
   authentication, ignores user config/rules, has an empty temporary working
   directory, and supplies only the current `centralmcp` endpoint. This is the
   selected lab implementation.
3. Use an OpenAI HTTP client instead. That would be a different provider rather
   than the Codex CLI option the operator selected.

## Invocation boundary

Each request creates a disposable launch context and spawns `codex` without a
shell. The process uses `codex exec --ephemeral --ignore-user-config
--ignore-rules --skip-git-repo-check --sandbox read-only --json` with
`gpt-5.6-terra` and low reasoning effort. The empty temporary directory is the
only Codex working directory.

`mcp_servers.centralmcp` is configured through CLI TOML overrides:

- the active HTTP endpoint is required;
- `find_tool`, `invoke_read_tool`, and `invoke_tool` are exposed;
- tool approval mode is `auto` for this lab;
- a configured bearer token is supplied through a one-process environment
  variable, not command arguments or output;
- the temporary directory and any generated MCP material are owner-readable
  and removed in `finally`.

The Codex JSONL stream is treated as untrusted transport output. Were this
enabled, the adapter returns only the final agent message and a compact,
redacted transcript of actual centralmcp tool calls. Stderr and unrecognized
event payloads never reach the browser or server logs.

## Readiness and dispatch

The local proof showed Codex can make one `find_tool` call through this path.
The registry records Codex as ready only after that exact read-only invocation;
chat dispatch uses the same argument construction, MCP endpoint, and temporary
working directory. The portal's lab write mode is enabled by default, so both
the OpenAI-compatible and Codex paths can invoke `invoke_tool` immediately.

`codex exec` does not provide a documented hard allow-list for every built-in
tool. `--ignore-user-config`, `--ignore-rules`, an empty temporary directory,
and the read-only host sandbox prevent inherited portal/project context and
host-file writes, but this is not production-grade tool isolation. The operator
has accepted that limitation for the lab; production hardening remains a later
deployment mode rather than a blocker here.

## Other CLI choices

Claude, Kimi, and GitHub Copilot remain selectable/configurable. Claude has a
strict generated-MCP configuration mode but needs an API-key-style `--bare`
launch for comparable process isolation. Kimi and GitHub Copilot lack a
generated-config-only launch mode. They stay truthfully unavailable until they
gain runnable adapters; a selectable provider must never show green and then
return a chat 409.

## Verification

- Unit tests prove the Codex command contains the disposable working directory,
  TOML-only `centralmcp` configuration, the speed-first model, low reasoning,
  and no bearer token in arguments or returned output.
- Unit tests parse a successful JSONL probe, a multi-tool chat transcript, an
  upstream failure, malformed JSONL, and cancellation/timeout behavior.
- A local manual probe uses the installed CLI with `centralmcp find_tool` and
  verifies one read-only tool call through the actual configured path.
- A local chat proof may invoke a safe read tool only; it does not use a live
  configuration write merely to demonstrate the lab policy.
