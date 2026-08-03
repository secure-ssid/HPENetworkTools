# Persistent Codex CLI Assistant — Design

## Goal

Make the portal's Codex provider fast by retaining one private, normal Codex
CLI app-server process instead of starting `codex exec` for every chat. The
portal must use the local Codex sign-in and CentralMCP only; it must never use
Computer Use, browser automation, the desktop app, or inherited global MCPs.

## User-facing behavior

- Codex's model field is a dropdown, not free text.
- The speed-first default is `gpt-5.3-spark` with `auto` reasoning. The
  dropdown also offers `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.4`, and
  `gpt-5.4-mini`. Older or account-specific choices remain selectable because
  the existing **Test provider** action proves actual CLI access before chat.
- `auto` means no reasoning-effort override: Codex chooses the normal effort.
  Low, medium, and high remain explicit options for deliberate tuning.
- All existing provider choices remain visible. This work makes only Codex
  executable and persistent; it does not falsely mark Kimi, Claude, or
  GitHub Copilot ready before their own native adapters exist.

## Persistent execution boundary

The portal owns one private `codex app-server --stdio` child per current
CentralMCP scope. It runs with:

```text
--strict-config --disable apps --disable plugins --disable computer_use --disable browser_use
```

At launch it creates owner-only temporary directories: an empty workspace and
an isolated `CODEX_HOME`. The latter contains only a mode-0600 copy of the
already-authenticated local `auth.json`; it contains no user config, plugins,
rules, history, or project files. The child receives the CentralMCP bearer
token only via `HPE_ASSISTANT_MCP_TOKEN`. The copied auth context and both
directories are removed whenever the child exits or is replaced.

The process protocol is JSONL:

```text
initialize -> initialized -> thread/start -> mcpServerStatus/list -> turn/start
  -> item/completed notifications -> turn/completed
```

Each browser chat uses a fresh ephemeral Codex thread and supplies the current
bounded conversation prompt. That prevents state from one browser conversation
being visible to another while retaining the app-server startup, sign-in, and
MCP connection cost across requests.

Before `turn/start`, the transport must prove that the exact thread inventory
contains only `centralmcp`. Any other server, an unknown event type, or a
scope change destroys the child and invalidates all threads. The scope key is
the model-independent CentralMCP endpoint, a non-secret token digest, and the
enabled tool set; a changed endpoint, token, or read/write tool set creates a
new child.

## Fallback and outcome rules

The existing isolated `codex exec --ignore-user-config --ignore-rules` path
remains the fallback. It may run only when the persistent path fails before a
`turn/start` request has been accepted. Once a turn could have invoked
CentralMCP, the portal returns a safe uncertain-provider error and never
replays the request through another path, avoiding duplicate lab writes.

The parser accepts only completed `agentMessage` text and `mcpToolCall` items
whose server is exactly `centralmcp`. Command, filesystem, browser, app, or
unexpected MCP items fail the child and never cross into the browser. Raw
JSONL, stderr, auth material, token values, copied-file paths, and config
contents are never returned or logged.

## Verification

- Unit tests drive JSON-RPC request IDs, initialization, thread creation,
  exact inventory proof, turn completion, cancellation, scope replacement,
  and disposal.
- Tests prove a token is present only in child environment data and an auth
  copy/private directories use restrictive modes.
- Tests prove no fallback replay after turn start, and fallback before a turn
  keeps the previous isolated `codex exec` behavior.
- UI tests prove the Codex model select has the five requested choices and
  `auto` reasoning; server tests prove the same values are accepted and an
  arbitrary model is rejected before process launch.
- A local provider test proves the selected account/model and CentralMCP
  read-only probe. It does not demonstrate a configuration write.

