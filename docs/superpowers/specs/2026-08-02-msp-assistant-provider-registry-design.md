# MSP Assistant Provider Registry Design

## Goal

Make the embedded MSP assistant selectable, fast, and honest about its actual runtime. Operators can switch among local Codex CLI, Claude Code, Kimi, GitHub Copilot CLI, Ollama, and OpenRouter without treating every product as an OpenAI-compatible HTTP server. The assistant keeps one product-aware Central/Mist/ClearPass MCP boundary and one write policy regardless of selected provider.

The normal MSP profile favors low interactive latency and concise network answers. It must not silently select Claude Opus, GPT-5.6 Sol, Pro mode, or high/xhigh/max reasoning. Deep reasoning remains an explicit future override, not the default.

## Non-goals

- Do not copy HPE credentials into model-provider settings or browser state.
- Do not expose arbitrary shell, filesystem, browser, or GitHub administration tools to a network-assistant provider.
- Do not claim a CLI can execute Central/Mist/ClearPass tools until its adapter has passed a real provider-and-MCP readiness test.
- Do not replace the existing product connector catalog, ticket automation design, or visual drilldown work.

## Provider model

The server stores an `assistant` configuration with an active provider and independent, masked settings per provider. Existing `mcp`, `llm`, and `chatWriteMode` settings migrate without losing the saved Ollama configuration.

| Provider | Transport | Fast default | Required setup |
| --- | --- | --- | --- |
| Codex CLI | local Codex app-server JSON-RPC | `gpt-5.6-terra`, low reasoning | installed and authenticated Codex CLI |
| Claude Code | local non-interactive/streaming CLI adapter | Sonnet-class, low effort, never Opus | installed and authenticated Claude CLI |
| Kimi | local ACP adapter | provider fast/default agent model, no elevated thinking mode | installed and authenticated Kimi CLI |
| GitHub Copilot CLI | local non-interactive/streaming CLI adapter | provider fast/auto model with low effort | installed and authenticated `copilot` CLI |
| Ollama | OpenAI-compatible HTTP | operator-selected local tool-capable model; prefer the smallest verified tool-capable installed model | local Ollama server and selected model |
| OpenRouter | OpenAI-compatible HTTP | operator-selected low-latency function-capable model | API key and selected model |

`gpt-5.6-terra` at low reasoning is the Codex/OpenAI fast profile: OpenAI positions Terra as the balanced tier and low reasoning for latency-sensitive workloads. The provider registry does not use the bare `gpt-5.6` alias because it routes to Sol. External provider aliases are deliberately resolved at test time rather than guessed from a static model list.

Each provider record contains only relevant fields: executable path or local endpoint, selected model or alias, optional key, and a `speedProfile` of `fast` or `custom`. The initial default is `fast`; custom explicitly exposes the model and effort fields. A model/test failure is shown as unavailable, never silently rerouted to a different provider.

## Runtime architecture

`AssistantRuntime` dispatches through a closed `AssistantProviderAdapter` interface. It owns conversation normalization, streaming/reply conversion, cancellation, provider timeout, availability checks, and redacted diagnostics. It returns the current browser response shape: final reply plus a compact tool transcript.

1. The browser selects a saved active provider and sends a chat request with optional per-session write permission.
2. The server resolves the active adapter and rejects unavailable/auth-failed providers with a precise, redacted status.
3. The server creates a short-lived, mode-0600 MCP launch configuration containing only the configured centralmcp endpoint and bearer token, if any. It is deleted after a CLI session ends.
4. Each CLI adapter is launched with its native protocol and only that MCP configuration. Built-in shell, filesystem, editing, browser, and unrelated MCP tools are disabled or denied. The process receives no HPE connector secrets.
5. OpenAI-compatible adapters retain the existing server-owned `find_tool` / `invoke_read_tool` / gated `invoke_tool` loop. Native CLI adapters receive the same centralmcp capability boundary through their generated MCP configuration.
6. centralmcp remains the enforcement point for product capability, dry-run/confirm requirements, and its per-product write gates. Portal `chatWriteMode` and the browser session opt-in remain a second required gate.
7. The server records provider, selected model, elapsed time, tool names, and redacted outcome; it never logs prompts containing credentials, API keys, or raw tool arguments.

Codex uses app-server rather than `codex exec`, preserving conversational turns and streamed agent events. Claude Code and Copilot use their documented non-interactive streaming modes with a strict temporary MCP configuration. Kimi uses its ACP transport only after a contract probe proves the installed version can attach the generated centralmcp configuration; until then its UI status is `installed — MCP attachment unavailable`, not falsely ready.

## Compact UI

Connected systems → Assistant becomes a concise control panel:

- Provider segmented picker: Codex, Claude, Kimi, Copilot, Ollama, OpenRouter.
- One line of provider health tags: installed, authenticated, MCP ready, model ready, selected.
- Fast profile is the default and visibly states the active model/alias and low/no elevated reasoning. `Custom` is a small advanced disclosure.
- Relevant fields only: executable/model for CLIs; host/model for Ollama; endpoint/key/model for OpenRouter.
- `Test provider` performs a native health/auth/MCP compatibility probe. `Save` persists masked settings. `Allow write tools` remains a separate switch.

The UI avoids paragraph help, raw protocol URLs in the default view, and model marketing descriptions. Full diagnostics live behind a compact details disclosure.

## Error handling and migration

- Legacy OpenAI-compatible settings migrate to the Ollama record when the local Ollama endpoint is recognized; otherwise they migrate to a retained compatible-provider record that can be corrected without losing the model/key.
- Missing executable, missing auth, unsupported native protocol, timeout, unavailable model, or missing MCP capability have separate user-visible status codes.
- A provider test must be read-only. A model can only report `MCP ready` after it discovers and invokes a bounded read-only centralmcp capability in a disposable session.
- A slow local model is not an upstream configuration error: its timeout is tuned by provider class and exposed as a latency result. The current fixed 30-second OpenAI-compatible timeout becomes a configurable, conservative fast-profile budget with cancellation preserved.
- Provider changes invalidate the current conversation tool state; conversations do not cross providers silently.

## Verification

- Settings tests cover migration, secret masking, per-provider persistence, and the no-Sol/no-Opus/no-elevated-thinking fast defaults.
- Adapter contract tests use fake process/app-server/HTTP transports to prove command construction excludes workspace/shell tools, temporary MCP files are mode 0600 and deleted, cancellation works, and redacted errors never contain keys.
- Native integration probes run only for locally installed/authenticated CLIs and invoke one read-only centralmcp discovery/read path; they do not run writes.
- Browser tests cover provider switching, dynamic fields, unavailable status, test result, custom profile disclosure, and saved settings surviving reload.
- A final manual check selects every installed provider, runs `Test provider`, confirms a concise live Central/Mist/ClearPass read for ready adapters, and confirms a write request stays blocked until both portal gates plus centralmcp dry-run/confirm semantics permit it.
