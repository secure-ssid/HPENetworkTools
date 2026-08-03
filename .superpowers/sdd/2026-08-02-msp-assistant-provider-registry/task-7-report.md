# Task 7 — Provider Registry Integration and Verification

Date: 2026-08-02

## Documentation and default

`README.md` now documents all six Assistant choices, their exact speed-first
defaults, active-provider selection, readiness criteria, and the two retained
write boundaries.

- Default active selection: **Ollama**.
- New configurations leave every provider disabled until an operator configures
  and saves one.
- Codex CLI: `gpt-5.6-terra`, low reasoning effort.
- Claude CLI: `sonnet`, low reasoning effort.
- Kimi CLI: `kimi-code/kimi-for-coding-highspeed`, thinking off.
- GitHub Copilot CLI: `auto`, adaptive effort.
- Ollama: `http://127.0.0.1:11434/v1`, `qwen2.5-coder:7b`.
- OpenRouter: `https://openrouter.ai/api/v1`, `openai/gpt-4.1-mini`.

Green means more than executable discovery: the selected, enabled provider
must be installed, authenticated, model-ready, and have completed its isolated
single read-only `centralmcp` invocation. Assistant writes still require both
the global Assistant setting and an explicit per-session opt-in; portal write
workflows keep their existing review/confirmation gates.

## Integrated test-gap correction

The full server run found one stale expectation in
`server/tests/systems.test.ts`: it expected a generic upstream `502` after the
new registry had correctly stopped dispatch with a `409` for an unready Ollama
provider. The test now verifies that fail-closed `409` contract and that no
MCP/LLM detail is disclosed. No product behavior was changed.

## Repository verification

| Command | Result |
|---|---|
| `npm run test -w server` | PASS — 84 files, 2502 tests |
| `npm run test -w web` | PASS — 70 files, 1321 tests |
| `npm run typecheck -w server` | PASS |
| `npm run typecheck -w web` | PASS |
| `npm run typecheck` | PASS — shared, web, and server workspaces |

The test runners emitted their existing expected negative-path logging plus
Node/React warnings; none produced test failures.

## Safe live checks

A listener was present at `127.0.0.1:5173`. Fresh `GET /api/chat/status`
returned HTTP 200 and reported MCP and LLM configured/reachable, but its JSON
shape had only the legacy fields (`configured`, `writeMode`, `mcpUrl`, and
`mcpReachable`). It omitted `activeProvider` and `providers`, which establishes
that this running process predates the registry route implementation. No
endpoint URL, token, key, or configuration value is recorded here.

The compatible-provider read-only test was therefore attempted only through
the supported route, `POST /api/chat/providers/ollama/test`; the legacy
listener returned `404 {"error":"not found"}`. No direct Ollama request was
made, because it would not prove isolated `centralmcp` access.

Installed native executables were discovered locally, but discovery was not
treated as readiness. Each was tested only through its isolated provider route
against the live listener:

| Provider | Executable found | Isolated route result | Verified state |
|---|---:|---|---|
| Codex | yes | `POST /api/chat/providers/codex/test` → 404 | unavailable; no centralmcp proof |
| Claude | yes | `POST /api/chat/providers/claude/test` → 404 | unavailable; no centralmcp proof |
| Kimi | yes | `POST /api/chat/providers/kimi/test` → 404 | unavailable; no centralmcp proof |
| GitHub Copilot | yes | `POST /api/chat/providers/copilot/test` → 404 | unavailable; no centralmcp proof |
| Ollama | not directly probed | `POST /api/chat/providers/ollama/test` → 404 | unavailable; no centralmcp proof |
| OpenRouter | not tested without an enabled local configuration | no safe live test attempted | unavailable/not configured |

The `404`s are an intentional truthful unavailable result for this old running
server, not evidence that any provider can safely access `centralmcp`. Start
the current server build with the intended configuration, then use each
provider's **Test provider** action to establish readiness. No product
configuration was changed during this verification.

## Change hygiene

Only Task 7 files are included in the commit: `README.md`, the justified
server test expectation update, and this report. `git diff --check` completed
without errors before committing.
