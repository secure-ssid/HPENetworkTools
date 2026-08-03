# MSP Assistant Provider Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy one-provider Assistant configuration with a compact, configurable provider registry. Operators can choose Codex CLI, Claude Code CLI, Kimi CLI, GitHub Copilot CLI, Ollama, or OpenRouter while every provider is constrained to the same centralmcp boundary and write policy.

**Architecture:** Persist an `assistant` settings object with an active provider, per-provider settings, the centralmcp endpoint, and portal write mode. Migrate legacy `llm`, `mcp`, and `chatWriteMode` settings deterministically into this object. Route chat through an `AssistantProviderAdapter`: OpenAI-compatible HTTP for Ollama/OpenRouter and native subprocess or app-server adapters for installed CLIs. The adapter receives a generated, owner-only centralmcp configuration and a minimal allowed tool set; it never receives product credentials. A provider status service reports truthful readiness based on an actual read-only invocation, rather than merely finding an executable.

**Tech Stack:** TypeScript, Express, Zod, Vitest, React, TanStack Query, current centralmcp HTTP endpoint, native provider CLIs.

## Global Constraints

- Keep centralmcp as the only product-management tool boundary. Do not expose raw Central, Mist, ClearPass, shell, filesystem, browser, or GitHub administration tools to a model.
- Preserve centralmcp dry-run/confirmation behavior and product-specific write gates. Portal `chatWriteMode` remains an additional global/session gate.
- Do not write secrets to logs, browser responses, tests, fixtures, crash reports, or persistent generated files. Generated MCP configuration must be mode `0600`, deleted in `finally`, and contain only the MCP endpoint and its bearer token when one is configured.
- Spawn CLIs with argument arrays and `shell: false`. Limit inherited environment variables to the minimum required for the provider executable and authentication, and redact command failures before returning them to the UI.
- Default to speed: Codex `gpt-5.6-terra` with low reasoning; Claude Sonnet-class low reasoning; Kimi `kimi-code/kimi-for-coding-highspeed` with thinking disabled; Copilot `auto` with its normal/adaptive reasoning; Ollama's smallest installed tool-capable model; and an operator-selected low-latency OpenRouter model. Keep Copilot `gpt-5.6-terra` as a pinned alternate, but never make Sol, Opus, or an extra-high reasoning level the default.
- A configured provider is not reported as ready until it completes a native provider-plus-centralmcp read-only probe. If the installed CLI cannot attach only the generated MCP config while suppressing arbitrary user-configured tools, report it as unavailable and block selection.

---

## File map

| File | Responsibility |
| --- | --- |
| `server/src/config/settings.ts` | Assistant settings contract, legacy migration, validation, redaction |
| `server/src/routes/settings.ts` | Accept and return the assistant settings contract safely |
| `server/src/services/assistant/types.ts` | Provider IDs, adapter contract, status and test result types |
| `server/src/services/assistant/registry.ts` | Default settings, provider lookup, capability/status orchestration |
| `server/src/services/assistant/mcpLaunchConfig.ts` | Secure temporary centralmcp configuration lifecycle |
| `server/src/services/assistant/openaiCompatible.ts` | Ollama/OpenRouter chat and tool-call adapter |
| `server/src/services/assistant/cliAdapters.ts` | Codex, Claude, Kimi, and Copilot command/app-server adapters |
| `server/src/services/mcpChat.ts` | Compatibility façade and common centralmcp tool policy |
| `server/src/routes/chat.ts` | Active-provider dispatch and explicit provider test endpoint |
| `server/tests/settings.test.ts` | Migration, validation, and redaction coverage |
| `server/tests/assistantProviders.test.ts` | Registry, launch-config, native adapter, and status tests |
| `server/tests/mcpChat.test.ts` | Existing and expanded OpenAI-compatible tool-loop coverage |
| `server/tests/chat.test.ts` | Route behavior for status, chat, and provider test requests |
| `web/src/api/chat.ts` | Typed status/test/settings client helpers |
| `web/src/screens/systems/AssistantSection.tsx` | Compact provider chooser and per-provider configuration UI |
| `web/src/screens/Systems.test.tsx` | Provider-selection and configuration UI coverage |

## Task 1: Define and migrate the persistent Assistant settings contract

**Files:**
- Modify: `server/src/config/settings.ts`
- Modify: `server/src/routes/settings.ts`
- Modify: `server/tests/settings.test.ts`

**Interfaces:**
- Consumes: the current `Settings`, `McpSettings`, `LlmSettings`, and `chatWriteMode` persistence shapes.
- Produces: `AssistantProviderId`, `AssistantSettings`, `migrateAssistantSettings(input)`, and a redacted `Settings` response consumed by Tasks 2, 5, and 6.

- [ ] **Step 1: Write failing migration and masking tests.** Cover local legacy `http://127.0.0.1:11434/v1` mapping to `ollama`, a non-local OpenAI-compatible URL mapping to `openrouter`, blank legacy values receiving defaults, and an existing `assistant` object winning unchanged.
- [ ] **Step 2: Run the focused settings test file and confirm the migration assertions fail.** Run: `pnpm --dir server test -- settings.test.ts`.
- [ ] **Step 3: Add the closed provider union and schemas.** Define `AssistantProviderId` as `"codex" | "claude" | "kimi" | "copilot" | "ollama" | "openrouter"`, then define `AssistantProviderConfig`, `AssistantSettings`, and provider-specific Zod schemas in `settings.ts`.
- [ ] **Step 4: Add `assistant` to `Settings` and migrate legacy input.** Retain `mcp`, `llm`, and `chatWriteMode` only as read-compatible legacy input. Persist the canonical shape:

   ```ts
   assistant: {
     activeProvider: "ollama",
     mcp: { enabled, endpoint, authToken },
     chatWriteMode: "read-only" | "confirm" | "enabled",
     providers: {
       codex: { enabled, model: "gpt-5.6-terra", reasoningEffort: "low" },
       claude: { enabled, model: "sonnet", reasoningEffort: "low" },
       kimi: { enabled, model: "kimi-code/kimi-for-coding-highspeed", thinking: false },
       copilot: { enabled, model: "auto", effort: "adaptive" },
       ollama: { enabled, baseUrl, model, apiKey? },
       openrouter: { enabled, baseUrl: "https://openrouter.ai/api/v1", model, apiKey? }
     }
   }
   ```

- [ ] **Step 5: Implement `migrateAssistantSettings()` before default merging.** Map legacy local `llm.baseUrl` values to Ollama; map non-local legacy OpenAI-compatible values to OpenRouter; preserve the legacy MCP endpoint/token and write mode; never overwrite an existing `assistant` object.
- [ ] **Step 6: Validate and redact the canonical settings response.** Make `maskedView()` redact legacy and provider API keys/tokens. Reject unrecognized provider IDs, non-HTTP(S) URLs, blank required model values, and invalid reasoning/thinking values before save.
- [ ] **Step 7: Accept the canonical form on the settings route.** Add `assistant` to the settings-route allow-list and translate old form submissions into migration input for backward compatibility.
- [ ] **Step 8: Run `pnpm --dir server test -- settings.test.ts`, inspect changed fixtures, and commit.** Commit: `feat: persist configurable assistant providers`.

## Task 2: Build provider registry, readiness model, and secure MCP launch-config utility

**Files:**
- Create: `server/src/services/assistant/types.ts`
- Create: `server/src/services/assistant/registry.ts`
- Create: `server/src/services/assistant/mcpLaunchConfig.ts`
- Create: `server/tests/assistantProviders.test.ts`

**Interfaces:**
- Consumes: `AssistantSettings` and its six provider configs from Task 1.
- Produces: `AssistantProviderAdapter`, `ProviderStatus`, `getAssistantDefaults()`, `createMcpLaunchConfig()`, and the command-runner seam used by Tasks 3–5.

- [ ] **Step 1: Write failing registry tests.** Cover the exact defaults, unavailable executable, malformed config, generated-config cleanup, and a successful mock centralmcp read-only probe.
- [ ] **Step 2: Run `pnpm --dir server test -- assistantProviders.test.ts` and confirm the missing registry contract fails.**
- [ ] **Step 3: Define the adapter and status contracts.** Add `AssistantProviderAdapter` with `id`, `discover()`, `chat()`, and `probeReadOnly()`; add `ProviderStatus` with `installed`, `authenticated`, `mcpReady`, `modelReady`, `selected`, `resolvedModel`, `latencyMs`, and redacted `message`.
- [ ] **Step 4: Implement defaults and display descriptors.** `getAssistantDefaults()` must use the exact speed-first values from Global Constraints and return each provider's title, execution kind, and required fields.
- [ ] **Step 5: Implement the disposable MCP launch config.** Use `fs.mkdtemp`, `fs.writeFile(..., { mode: 0o600 })`, and `dispose()` that unlinks both file and directory in `finally`; assert permissions and failure cleanup in tests.
- [ ] **Step 6: Implement the injection-safe command runner and probe accounting.** Production uses `spawn` with `shell: false`; fakes assert no shell/filesystem/browser/unrelated MCP tools. `probeReadOnly()` succeeds only after recorded centralmcp read-only invocation and uses an injected clock for latency.
- [ ] **Step 7: Run `pnpm --dir server test -- assistantProviders.test.ts` and commit.** Commit: `feat: add assistant provider registry and readiness checks`.

## Task 3: Extract the OpenAI-compatible adapter and preserve centralmcp tool policy

**Files:**
- Create: `server/src/services/assistant/openaiCompatible.ts`
- Modify: `server/src/services/mcpChat.ts`
- Modify: `server/tests/mcpChat.test.ts`

**Interfaces:**
- Consumes: `AssistantProviderAdapter` and `AssistantSettings` from Tasks 1–2 plus current `mcpChat` exports.
- Produces: `OpenAICompatibleAdapter`, `platform?: "central" | "mist" | "clearpass"` on `find_tool`, and the compatibility façade used by Task 5.

- [ ] **Step 1: Write failing compatible-provider tests.** Assert Ollama and OpenRouter use one adapter, a null tool-call `content` is accepted, and provider timeout is passed instead of the fixed 30 seconds.
- [ ] **Step 2: Run `pnpm --dir server test -- mcpChat.test.ts` and confirm the adapter-routing cases fail.**
- [ ] **Step 3: Extract `OpenAICompatibleAdapter`.** Move the current Chat Completions/tool loop into `openaiCompatible.ts`; pass `{ baseUrl, model, apiKey, timeoutMs }` explicitly and do not read global settings in the adapter.
- [ ] **Step 4: Keep current callers working through `mcpChat`.** Keep its existing public entry points and resolve the active compatible adapter through the Task 2 registry so existing Ollama use continues unchanged.
- [ ] **Step 5: Extend centralmcp discovery and timeout behavior.** Add optional `platform: "central" | "mist" | "clearpass"` to `find_tool` and pass it untouched. Define short interactive and longer bounded generation/startup timeouts in one exported resolver; return a clear timeout result rather than an upstream-configuration error.
- [ ] **Step 6: Run `pnpm --dir server test -- mcpChat.test.ts` and commit.** Commit: `refactor: route compatible chat through provider adapter`.

## Task 4: Add native CLI adapters with strict MCP/tool isolation

**Files:**
- Modify: `server/src/services/assistant/registry.ts`
- Create: `server/src/services/assistant/cliAdapters.ts`
- Modify: `server/tests/assistantProviders.test.ts`

**Interfaces:**
- Consumes: Task 2's command runner, disposable MCP config, and adapter/status contract.
- Produces: `CodexAdapter`, `ClaudeAdapter`, `KimiAdapter`, and `CopilotAdapter` registered by Task 5.

- [ ] **Step 1: Write failing native-adapter contract tests.** For Codex, Claude, Kimi, and Copilot assert only generated centralmcp config, a read-only probe prompt, approved model values, and zero product credentials reach the command runner.
- [ ] **Step 2: Run `pnpm --dir server test -- assistantProviders.test.ts` and confirm each native provider is initially unimplemented.**
- [ ] **Step 3: Implement `CodexAdapter`.** Use installed `codex app-server` JSON-RPC noninteractively, set `gpt-5.6-terra`/low reasoning, restrict working directory/sandbox, and attach only generated centralmcp. If user MCPs cannot be suppressed, return `mcpReady: false`.
- [ ] **Step 4: Implement `ClaudeAdapter`.** Invoke `claude -p` stream JSON with `--mcp-config`, strict configuration, and the centralmcp-only allow-list excluding shell/filesystem/browser. Default to Sonnet class/low effort; never auto-select Opus.
- [ ] **Step 5: Implement `KimiAdapter`.** Use supported noninteractive/ACP transport with generated MCP config, model `kimi-code/kimi-for-coding-highspeed`, and disabled thinking. If this installed CLI cannot prove isolated MCP attachment, return unavailable without broader-config fallback.
- [ ] **Step 6: Implement `CopilotAdapter`.** Invoke `copilot -p --output-format json --disable-builtin-mcps --additional-mcp-config`; default `--model auto` with no effort override, expose `gpt-5.6-terra` alternate, and pass `--effort` only for chosen non-adaptive effort.
- [ ] **Step 7: Normalize output and teardown.** Parse native output into shared result/events, redact stderr, kill children on timeout, and dispose generated config in every success/failure branch.
- [ ] **Step 8: Add successful read-only fixtures and authentication/isolation/tool-call failure tests.** Selection is blocked for every failed prerequisite.
- [ ] **Step 9: Run `pnpm --dir server test -- assistantProviders.test.ts` and commit.** Commit: `feat: add isolated native assistant CLI adapters`.

## Task 5: Dispatch active provider and expose explicit readiness testing

**Files:**
- Modify: `server/src/routes/chat.ts`
- Modify: `server/src/services/mcpChat.ts`
- Create or modify: `server/tests/chat.test.ts`

**Interfaces:**
- Consumes: active `AssistantSettings`, registry readiness results, and the Task 3 compatibility façade.
- Produces: redacted status data, `POST /api/chat/providers/:providerId/test`, and selected-provider chat dispatch for Task 6.

- [ ] **Step 1: Write failing chat-route tests.** Cover active dispatch, disabled/unready 409 rejection, redacted status shape, and a read-only provider test invocation.
- [ ] **Step 2: Run `pnpm --dir server test -- chat.test.ts` and confirm the route cases fail.**
- [ ] **Step 3: Expand `GET /api/chat/status`.** Return active provider ID and full redacted readiness list, retaining current MCP/write-mode fields for older clients.
- [ ] **Step 4: Add `POST /api/chat/providers/:providerId/test`.** Validate saved config, invoke `probeReadOnly()`, return its status, and assert in route tests that it never invokes a write-capable centralmcp tool.
- [ ] **Step 5: Route messages via the persisted active provider.** Resolve `settings.assistant.activeProvider`; return actionable 409 for disabled/unready status; preserve portal write-mode policy around every tool call. Accept a session provider only after it matches an enabled saved registry entry and never persist it from chat.
- [ ] **Step 6: Run `pnpm --dir server test -- chat.test.ts mcpChat.test.ts` and commit.** Commit: `feat: dispatch chat through selected assistant provider`.

## Task 6: Replace the verbose Assistant form with a compact configurable provider panel

**Files:**
- Modify: `web/src/api/chat.ts`
- Modify: `web/src/screens/systems/AssistantSection.tsx`
- Modify: `web/src/screens/Systems.test.tsx`

**Interfaces:**
- Consumes: Tasks 1 and 5's redacted settings/status/test API shapes.
- Produces: the compact Assistant section and typed browser API helpers used by the Systems screen.

- [ ] **Step 1: Write failing Assistant UI tests.** Cover provider selection, only selected-provider fields, failed-save preservation of active provider, readiness tags, and read-only test action.
- [ ] **Step 2: Run `npm run test -w web -- src/screens/Systems.test.tsx` and confirm the new cases fail.**
- [ ] **Step 3: Replace the verbose endpoint form with a compact provider selector.** Show name, selected state, readiness tag, and resolved model; show fast defaults without explanatory paragraphs.
- [ ] **Step 4: Render only required provider fields.** Codex/Claude: model and reasoning. Kimi: model and thinking. Copilot: Auto/Terra alternate and adaptive label. Ollama/OpenRouter: endpoint, model, key. Place custom model/advanced controls in collapsed Advanced.
- [ ] **Step 5: Preserve a small separate Tool access section.** Keep centralmcp endpoint/auth and global write mode together; mask saved values and require a replacement value to change a secret.
- [ ] **Step 6: Wire `Test provider` to the read-only route.** Show concise progress, successful latency/resolved model, or redacted unavailable reason; never claim configured/connected without the returned status.
- [ ] **Step 7: Maintain Systems-screen accessibility.** Retain accessible labels, keyboard focus behavior, and compact copy without long product/provider descriptions.
- [ ] **Step 8: Run `npm run test -w web -- src/screens/Systems.test.tsx` and `npm run typecheck -w web`, then commit.** Commit: `feat: add compact configurable assistant providers UI`.

## Task 7: Integrate, verify, and document operator behavior

**Files:**
- Modify: `README.md`
- Modify: tests only where coverage gaps are found during the integrated run

**Interfaces:**
- Consumes: all completed provider, chat, and Assistant UI features.
- Produces: operator instructions and end-to-end verification evidence.

- [ ] **Step 1: Document the configured providers in `README.md`.** List all six choices, their speed-first defaults, active-provider selection, green-status meaning (native read-only centralmcp invocation), and retained centralmcp/portal write confirmation gates.
- [ ] **Step 2: Run the complete repository verification.** Run server tests, web tests, server typecheck, and `npm run typecheck -w web` with repository scripts; record exact pass/fail counts.
- [ ] **Step 3: Verify the live Assistant safely.** Call fresh `GET /api/chat/status`, then execute a read-only local-Ollama provider test without exposing any response secrets.
- [ ] **Step 4: Verify native providers truthfully.** Run a read-only test for each installed authenticated CLI. If any cannot establish isolated centralmcp access, retain it in the UI as unavailable with a concise repair action; never mark executable discovery as ready.
- [ ] **Step 5: Protect concurrent work and commit only plan-owned files.** Run `git diff --check`, `git status --short`, and inspect committed file lists before committing documentation with `docs: document assistant provider setup`.
- [ ] **Step 6: Report the final default, every verified provider state, test results, and intentional unavailable states caused by unsafe CLI isolation.**
