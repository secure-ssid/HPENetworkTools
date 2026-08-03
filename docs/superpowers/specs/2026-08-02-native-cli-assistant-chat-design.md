# Native CLI Assistant Chat — Design

## Goal

Make the provider picker’s Codex option run real assistant chat through the
locally authenticated Codex CLI. It must use the portal-selected `centralmcp`
endpoint only, never silently fall back to Ollama/OpenRouter or inherit the
operator’s broader Codex workspace configuration.

The existing picker, persisted selection, provider status, and chat route stay
the user-facing surface. Once Codex is selected, saved, and read-only-tested,
the normal Assistant drawer dispatches to it.

## Alternatives considered

1. Reuse the user’s Codex configuration. This can expose unrelated MCP servers,
   skills, or project rules, so it does not meet the portal’s product boundary.
2. Use a per-request isolated `codex exec` invocation. This uses saved CLI
   authentication but ignores user config/rules, has an empty temporary working
   directory, and supplies only the current `centralmcp` endpoint. This is the
   selected design.
3. Use an OpenAI HTTP client instead. That would be a different provider rather
   than the Codex CLI option the operator selected.

## Invocation boundary

Each request creates a disposable launch context and spawns `codex` without a
shell. The process uses `codex exec --ephemeral --ignore-user-config
--ignore-rules --skip-git-repo-check --sandbox read-only --json` with the
selected model and low reasoning effort.

`mcp_servers.centralmcp` is configured through CLI TOML overrides:

- the active HTTP endpoint is required;
- only `find_tool` and `invoke_read_tool` are exposed for this initial native
  chat path;
- a configured bearer token is supplied through a one-process environment
  variable, not command arguments or output;
- the temporary directory and any generated MCP material are owner-readable
  and removed in `finally`.

The Codex JSONL stream is treated as untrusted transport output. The adapter
returns only the final agent message and a compact transcript of actual
centralmcp tool calls. Stderr and unrecognized event payloads never reach the
browser or server logs.

## Readiness and dispatch

The Codex provider’s readiness probe uses the same isolated launch mechanism
and makes one `find_tool` call. It is ready only when that read-only call is
observed in the JSONL event stream. A saved Codex selection dispatches normal
Assistant chat to the same adapter; it never falls back to another provider.

This first slice is deliberately read-only. The pending direct-lab-write
rewrite will make immediate configuration writes available consistently across
all Assistant providers instead of giving Codex a one-off write policy.

## Other CLI choices

Claude, Kimi, and GitHub Copilot remain selectable/configurable, but their
status remains unavailable until each installed CLI can prove an equally
isolated, generated-config-only chat path. A green status must mean its chat
request can actually run — it cannot be a successful probe followed by a 409.

## Verification

- Unit tests assert the Codex command uses the isolated flags, current model,
  bounded read-only MCP tool allow-list, and token environment variable without
  leaking a token to args/stdout/stderr.
- Parser tests cover a valid final message, malformed/absent final output, and
  recorded centralmcp tool calls.
- Registry and route tests prove a selected, ready Codex provider dispatches
  through the native adapter and unavailable CLI providers do not fall back.
- A local manual proof uses the installed CLI with `centralmcp find_tool` and
  verifies the resulting Assistant chat remains read-only.
