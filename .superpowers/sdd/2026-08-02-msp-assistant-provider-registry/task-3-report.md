# Task 3 report — OpenAI-compatible assistant adapter

## Delivered

- Extracted the Chat Completions/tool-call loop into `OpenAICompatibleAdapter`; its `run()` input explicitly carries base URL, model, API key, and timeout. The adapter never reads global settings.
- Kept `chatLoop()` as the public compatibility façade. It reads the canonical active compatible provider, resolves it through the provider registry, and retains the existing centralmcp write/tool policy.
- Preserved the `content: null` tool-call repair by replaying it as an empty string.
- Added the optional `find_tool.platform` selection with the exact allowed values: `central`, `mist`, and `clearpass`; valid selections are forwarded unchanged to centralmcp.
- Replaced the fixed 30-second completion timeout with exported provider timeout resolution: 15 seconds for interactive work and 90 seconds for bounded generation/startup. Timeout failures say `assistant provider timed out after …ms`.

## Changed files

- `server/src/services/assistant/openaiCompatible.ts` (new)
- `server/src/services/assistant/types.ts`
- `server/src/services/mcpChat.ts`
- `server/src/routes/chat.ts`
- `server/tests/mcpChat.test.ts`
- `server/tests/chat.test.ts` (new)

## Red/green evidence

- RED: `pnpm --dir server test -- mcpChat.test.ts` was blocked in this checkout because pnpm cannot find its linked `vitest` executable (`sh: vitest: command not found`).
- RED equivalent: `npm --prefix server test -- mcpChat.test.ts` failed before implementation because `../src/services/assistant/openaiCompatible` did not exist.
- GREEN: `npm --prefix server test -- mcpChat.test.ts` passed: 1 file, 21 tests. It covers both compatible providers, null tool-call replay, platform forwarding, timeout resolver boundaries, explicit timeout behavior, and existing centralmcp policy/loop regression cases.
- GREEN: `npm --prefix server run typecheck` passed (`tsc --noEmit`).
- GREEN: `git diff --check` passed.

## Commit

- `9178e29 refactor: route compatible chat through provider adapter`
- `a1c4279 fix: preserve safe provider timeout errors`

## Concerns

- The requested pnpm command remains unavailable due to the checkout's missing pnpm-linked Vitest executable; npm uses the installed Vitest and supplied the red/green evidence.
- The adapter's native-provider readiness probe intentionally returns unready; native CLI probe implementation is deferred to Task 4.

## Review-fix evidence

- Provider timeout failures are now a typed `AssistantProviderTimeoutError`. The chat route maps only that known error to HTTP 504 with `assistant provider timed out — try again shortly`; unrelated failures remain the existing generic 502.
- Non-OK OpenAI-compatible responses now throw a status-only error. The route logs a fixed safe message for generic upstream failures, so neither provider response bodies nor credentials can reach browser responses or route logs.
- `AssistantProviderAdapter.chat()` now has an explicit request contract carrying provider config, bounded timeout, tool executor, and cancellation signal. `chatLoop()` calls the registry-returned adapter through that contract; it no longer uses `instanceof` or a cast-only `compatible` property.
- Review-fix tests: `npm --prefix server test -- chat.test.ts mcpChat.test.ts systems.test.ts` passed: 3 files, 60 tests. `npm --prefix server run typecheck` and `git diff --check` passed.
