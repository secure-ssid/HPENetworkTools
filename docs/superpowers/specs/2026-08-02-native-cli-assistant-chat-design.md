# Native CLI Assistant Chat — Design

## Goal

Evaluate whether the provider picker’s Codex option can run real assistant chat
through the locally authenticated Codex CLI while remaining limited to the
portal-selected `centralmcp` endpoint.

The existing picker, persisted selection, provider status, and chat route stay
the user-facing surface. A provider can only become ready when its chat path
has the same isolation as its readiness check.

## Alternatives considered

1. Reuse the user’s Codex configuration. This can expose unrelated MCP servers,
   skills, or project rules, so it does not meet the portal’s product boundary.
2. Use a per-request `codex exec` invocation. This uses saved CLI
   authentication but ignores user config/rules, has an empty temporary working
   directory, and supplies only the current `centralmcp` endpoint. It is the
   closest candidate, but it does not restrict Codex built-in tools.
3. Use an OpenAI HTTP client instead. That would be a different provider rather
   than the Codex CLI option the operator selected.

## Invocation boundary

The closest candidate creates a disposable launch context and spawns `codex`
without a shell. The process uses `codex exec --ephemeral --ignore-user-config
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

The Codex JSONL stream is treated as untrusted transport output. Were this
enabled, the adapter would return only the final agent message and a compact
transcript of actual centralmcp tool calls. Stderr and unrecognized event
payloads would never reach the browser or server logs.

## Readiness and dispatch

The local proof showed Codex can make one `find_tool` call through this path.
That does not prove a Central-only chat boundary: `codex exec` has no documented
hard allow-list for its own built-in shell, filesystem, or web tools. Therefore
Codex remains unavailable in the portal unless the operator explicitly accepts
a clearly labeled lab escape hatch with that broader capability.

The pending direct-lab-write rewrite will make immediate configuration writes
available consistently across all Assistant providers instead of giving a
single CLI a one-off write policy.

## Other CLI choices

Claude, Kimi, and GitHub Copilot remain selectable/configurable. Claude has a
strict generated-MCP configuration mode but needs an API-key-style `--bare`
launch for comparable process isolation. Kimi and GitHub Copilot lack a
generated-config-only launch mode. A green status must mean its chat request
can actually run — it cannot be a successful probe followed by a 409.

## Verification

- A local manual proof uses the installed CLI with `centralmcp find_tool` and
  verifies one read-only tool call through the candidate path.
- The proof is deliberately insufficient for a green provider status because
  it cannot prevent non-MCP Codex built-in tools. An explicit operator decision
  is required before implementing a lab escape hatch.
