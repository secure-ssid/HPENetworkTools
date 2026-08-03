# Task 4 report — isolated native assistant CLI adapters

## Delivered

- Added `CodexAdapter`, `ClaudeAdapter`, `KimiAdapter`, and `CopilotAdapter` behind the existing no-shell `CommandRunner` seam.
- Extended the registry-owned read-only probe context with the centralmcp endpoint and bearer token so adapters create the owner-only disposable launch configuration without reading global settings or receiving product/provider credentials.
- Claude probes use `claude -p`, stream JSON, `--mcp-config`, `--strict-mcp-config`, a centralmcp `find_tool` allow-list, explicit shell/filesystem/browser denies, Sonnet-class model validation, and low effort. Opus and non-low settings are refused before launch.
- Copilot probes use `copilot -p --output-format json --disable-builtin-mcps --additional-mcp-config`, expose only `centralmcp(find_tool)`, disable custom instructions/temp-dir/remote modes, retain `auto` without `--effort`, and allow `gpt-5.6-terra` only as the pinned alternate with an explicit non-adaptive effort.
- Native probe output is accepted only when JSON events show one centralmcp `find_tool` call and no other tool call. Exit failures, malformed output, forbidden tools, launch failures, and timeouts report unavailable; stderr is not propagated. Generated config disposal runs in `finally`.
- Codex and Kimi are deliberately fail-closed: their installed interfaces cannot attach only Task 2's generated JSON centralmcp config while suppressing user-configured MCP sources. They produce no probe command, config, or readiness evidence rather than broadening access.

## Local CLI capability evidence

- `codex --version` reported `codex-cli 0.145.0`; `codex app-server --help` did **not** advertise `--mcp-config`.
- `claude --version` reported `2.1.220 (Claude Code)`; `claude --help` advertised `--strict-mcp-config`.
- `kimi --version` reported `0.29.1`; `kimi --help` did **not** advertise `--mcp-config` (its ACP help also supplies no documented generated-config attachment option).
- `copilot --version` reported `GitHub Copilot CLI 1.0.77`; its help advertised both `--additional-mcp-config` and `--disable-builtin-mcps`.

No live provider/centralmcp probe was run: this checkout has no supplied isolated centralmcp test target, and a live CLI probe could consume authenticated-provider capacity. The recorded evidence is limited to installed binary/version and advertised isolation capability.

## Changed files

- `server/src/services/assistant/cliAdapters.ts` (new)
- `server/src/services/assistant/types.ts`
- `server/src/services/assistant/registry.ts`
- `server/tests/assistantProviders.test.ts`

## Test and verification results

- RED: `pnpm --dir server test -- assistantProviders.test.ts` remains environment-blocked because its pnpm-linked `vitest` executable is absent. The equivalent npm RED command failed as expected before implementation because `cliAdapters` did not exist.
- GREEN: `npm --prefix server test -- assistantProviders.test.ts` — passed: 1 file, 19 tests.
- GREEN: `npm --prefix server run typecheck` — passed (`tsc --noEmit`).
- GREEN: `npm --prefix server test` — passed: 84 files, 2,489 tests.
- GREEN: `git diff --check` — passed.

## Commit

Implementation commit subject: `feat: add isolated native assistant CLI adapters`.

## Concerns

- Codex/Kimi remain unavailable by design until their CLIs document a way to attach exactly the generated centralmcp configuration while disabling arbitrary user MCP configuration. No fallback to a user profile, home configuration, direct product endpoint, shell, filesystem, browser, or unbounded environment is permitted.
- The shared chat request does not yet carry registry-owned centralmcp launch context. Native `chat()` therefore fails closed; Task 5 must supply that context before registering native adapters for conversational dispatch.

## Review-fix evidence

- The installed Copilot CLI explicitly states that `--additional-mcp-config` *augments* `~/.copilot/mcp-config.json`; `--disable-builtin-mcps` only disables its built-in GitHub server. The adapter now treats Copilot as unavailable without creating a config or launching a command, matching the Codex/Kimi fail-closed posture. It retains the `auto` + `adaptive` policy and rejects `auto` paired with any explicit effort before executable discovery; a selected `gpt-5.6-terra` alternate remains the only model eligible for explicit effort.
- Claude is now the only native probe transport with a documented exclusive config surface: its installed help says `--strict-mcp-config` uses only `--mcp-config` and ignores all other MCP configuration.
- Replaced permissive name-scanning with provider-specific Claude stream-JSON validation. It rejects malformed non-empty JSONL, unknown event/block schemas, fabricated name fields, repeated/mixed tool-use blocks, unmatched or error tool results, and a missing/non-final failed result. Readiness requires exactly one `mcp__centralmcp__find_tool` tool-use, its matching non-error tool-result, and one final `result/success` event.
- Review regression coverage adds Copilot Auto/non-adaptive rejection plus Copilot exclusive-config fail-closed behavior, and seven false-proof fixtures: malformed-plus-valid, fabricated non-tool name, duplicate central calls, central-plus-shell in one event, missing tool result, failed tool result, and missing final result.
- RED: `npm --prefix server test -- assistantProviders.test.ts` failed on six unsafe pre-fix behaviors; the requested pnpm form remained environment-blocked by the missing linked Vitest executable.
- GREEN: focused provider tests passed 25 tests; `npm --prefix server run typecheck` passed; full `npm --prefix server test` passed 84 files / 2,495 tests; `git diff --check` passed.
