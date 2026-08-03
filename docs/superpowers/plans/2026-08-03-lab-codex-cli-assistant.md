# Lab Codex CLI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the saved Codex provider run fast, lab-mode CentralMCP chats with immediate write capability and no per-message write switch.

**Architecture:** `CodexAdapter` launches `codex exec` for each request with an empty disposable directory, explicit TOML `centralmcp` overrides, and bearer token only in a child environment variable. It parses only Codex JSONL `agent_message` and `centralmcp` MCP tool events. The common chat loop supplies the current MCP connection and lab write state to native adapters; the browser has one persisted lab write setting instead of a session gate.

**Tech Stack:** TypeScript, Express, React, Vitest, locally authenticated Codex CLI, CentralMCP streamable HTTP.

## Global Constraints

- Lab mode permits immediate configuration writes: no ticket, lease, review, confirmation, or per-message opt-in.
- Keep model defaults speed-first: Codex `gpt-5.6-terra` and low reasoning.
- Start Codex with `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--skip-git-repo-check`, an empty temporary directory, and `--sandbox read-only`.
- Pass the CentralMCP bearer token through one child environment variable only; never place it in arguments, stdout, stderr, browser responses, or logs.
- Return only compact CentralMCP tool transcript entries and final assistant text. Never forward raw JSONL or stderr.
- This is an explicitly accepted lab escape hatch; do not describe it as production-grade Codex built-in-tool isolation.

---

### Task 1: Define the native chat boundary and Codex JSONL contract

**Files:**
- Modify: `server/src/services/assistant/types.ts`
- Modify: `server/src/services/assistant/cliAdapters.ts`
- Test: `server/tests/assistantProviders.test.ts`

**Interfaces:**
- Consumes: `AssistantChatRequest`, `CommandRunner`, and the existing `CodexAdapter`.
- Produces: `AssistantChatRequest.mcp`, a cancellable command execution shape, and tested JSONL parsing helpers used by Task 2.

- [ ] **Step 1: Write failing Codex command/parser tests.**

```ts
expect(command.args).toContain('--ignore-user-config');
expect(command.args).toContain('--sandbox');
expect(command.args).toContain('read-only');
expect(command.args.join(' ')).toContain('mcp_servers.centralmcp.url=');
expect(command.args.join(' ')).not.toContain('centralmcp-secret');
expect(command.env?.HPE_ASSISTANT_MCP_TOKEN).toBe('centralmcp-secret');
```

- [ ] **Step 2: Run the focused native-provider test and confirm the current Codex adapter is unavailable.**

Run: `npm run test -w server -- assistantProviders.test.ts`

Expected: Codex readiness/chat tests fail because `canChat()` is false and no command is built.

- [ ] **Step 3: Extend the native request contract.** Add `mcp: { endpoint: string; authToken: string | null; writeEnabled: boolean }` to `AssistantChatRequest`; add optional `signal` to `CommandExecution` and have the spawn runner terminate its exact child if the caller aborts.

- [ ] **Step 4: Implement narrow JSONL parsing.** Accept only nonempty JSON objects. Collect `item.completed` `agent_message.text` as final text and `mcp_tool_call` entries only when `server === 'centralmcp'`; compact all tool arguments/results to existing UI caps. Reject a missing final message, malformed output, or nonzero exit without returning raw provider output.

- [ ] **Step 5: Run the focused test and commit.**

Run: `npm run test -w server -- assistantProviders.test.ts`

Commit: `test: define Codex CLI chat contract`

### Task 2: Run Codex through the lab CentralMCP launch path

**Files:**
- Modify: `server/src/services/assistant/cliAdapters.ts`
- Test: `server/tests/assistantProviders.test.ts`

**Interfaces:**
- Consumes: Task 1's request MCP block and parser.
- Produces: a `CodexAdapter` with `canChat(): true`, real readiness probing, and real chat dispatch.

- [ ] **Step 1: Write failing adapter behavior tests.** Cover `codex --version`, a JSONL `find_tool` probe, a chat JSONL response with `find_tool` plus `invoke_tool`, normal final text, and temporary launch disposal after command failure.

- [ ] **Step 2: Run the focused test to verify missing implementation.**

Run: `npm run test -w server -- assistantProviders.test.ts`

Expected: Codex cannot report ready or return transcript text.

- [ ] **Step 3: Implement the explicit command builder.** Use an argument array equivalent to:

```text
codex exec --ephemeral --ignore-user-config --ignore-rules --skip-git-repo-check \
  --cd <temporary-directory> --sandbox read-only --model gpt-5.6-terra --strict-config \
  -c model_reasoning_effort="low" \
  -c mcp_servers.centralmcp.url="<endpoint>" \
  -c mcp_servers.centralmcp.enabled=true \
  -c mcp_servers.centralmcp.required=true \
  -c mcp_servers.centralmcp.enabled_tools=["find_tool","invoke_read_tool","invoke_tool"] \
  -c mcp_servers.centralmcp.default_tools_approval_mode="auto" \
  -c mcp_servers.centralmcp.bearer_token_env_var="HPE_ASSISTANT_MCP_TOKEN" \
  --json <prompt>
```

Omit the bearer-token override and environment value when no token is configured. The prompt names only CentralMCP tools, requires `find_tool` before invoking a product tool, and states that lab configuration writes take effect immediately.

- [ ] **Step 4: Reuse the disposable launch directory and delete it in `finally`.** The existing owner-only `createMcpLaunchConfig()` utility creates the directory. Pass its directory to `--cd`; do not point Codex at the JSON file or inherit user configuration.

- [ ] **Step 5: Implement the probe and chat paths.** A probe accepts exactly one successful `centralmcp/find_tool` event and records it as read-only. Chat accepts final agent text and compact CentralMCP events; it forwards the request abort signal and throws a safe adapter error for invalid or failed process output.

- [ ] **Step 6: Run tests, typecheck, and commit.**

Run: `npm run test -w server -- assistantProviders.test.ts && npm run typecheck -w server`

Commit: `feat: run Codex CLI assistant through CentralMCP`

### Task 3: Remove the session write gate and pass lab context to native chat

**Files:**
- Modify: `server/src/config/settings.ts`
- Modify: `server/src/routes/chat.ts`
- Modify: `server/src/services/mcpChat.ts`
- Modify: `server/tests/chat.test.ts`
- Modify: `server/tests/mcpChat.test.ts`

**Interfaces:**
- Consumes: Task 2's native adapter and the canonical `assistant.chatWriteMode` setting.
- Produces: default `enabled` lab write mode, no `allowWrite` browser body field, and a native adapter request with MCP endpoint/token/write state.

- [ ] **Step 1: Write failing route and tool-loop tests.** Assert a chat request does not send or require `allowWrite`, `chatWriteMode: 'enabled'` exposes `invoke_tool`, and a Codex request receives `{ mcp: { endpoint, authToken, writeEnabled: true } }`.

- [ ] **Step 2: Run focused chat and MCP tests to confirm the old two-switch gate remains.**

Run: `npm run test -w server -- chat.test.ts mcpChat.test.ts`

Expected: tests show `allowWrite` still controls `invoke_tool`.

- [ ] **Step 3: Make lab write mode the default.** Change `defaultAssistantSettings().chatWriteMode` to `'enabled'` while retaining the saved setting as a later hardening control.

- [ ] **Step 4: Remove `allowWrite` from `/api/chat` and `ChatLoopOptions`.** Build `writeEnabled` solely from `assistant.chatWriteMode === 'enabled'`; remove the confirmation copy and pass the current MCP details into `AssistantChatRequest`.

- [ ] **Step 5: Run tests, typecheck, and commit.**

Run: `npm run test -w server -- chat.test.ts mcpChat.test.ts && npm run typecheck -w server`

Commit: `feat: enable immediate lab assistant writes`

### Task 4: Make the Assistant UI state honest and compact

**Files:**
- Modify: `web/src/api/chat.ts`
- Modify: `web/src/screens/ChatPanel.tsx`
- Modify: `web/src/screens/systems/AssistantSection.tsx`
- Test: `web/src/screens/Systems.test.tsx`

**Interfaces:**
- Consumes: Task 3's no-`allowWrite` API and existing selected-provider status response.
- Produces: a compact lab read/write indicator and a provider control that persists the current selection.

- [ ] **Step 1: Write failing UI tests.** Assert the Chat panel does not render a per-session write toggle, provider selection remains available, and the Assistant section labels enabled write access as lab mode without an approval paragraph.

- [ ] **Step 2: Run the focused UI test to confirm the old control is visible.**

Run: `npm run test -w web -- Systems.test.tsx`

- [ ] **Step 3: Remove `allowWrite` from the browser request and chat panel.** Keep the compact transcript and provider picker. Replace the old confirmation wording with a small `LAB READ/WRITE` state only.

- [ ] **Step 4: Keep the global Assistant toggle as future hardening, not a blocker.** It controls persisted `chatWriteMode`, defaults on in the lab, and retains accessible labeling.

- [ ] **Step 5: Run UI tests, web typecheck, build, and commit.**

Run: `npm run test -w web -- Systems.test.tsx && npm run typecheck -w web && npm run build -w web`

Commit: `feat: make assistant lab writes immediate`

### Task 5: Integrate and verify live behavior

**Files:**
- Modify: `README.md` only if setup instructions are stale after implementation.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: fresh live server evidence and a concise operator handoff.

- [ ] **Step 1: Run full affected verification.**

Run: `npm run test -w server -- assistantProviders.test.ts chat.test.ts mcpChat.test.ts && npm run typecheck -w server && npm run test -w web -- Systems.test.tsx && npm run typecheck -w web && npm run build -w web`

- [ ] **Step 2: Restart the exact localhost portal server.** Confirm the prior listener PID is the portal's `tsx src/index.ts`, send it `SIGINT`, then start `npm run start -w server` and verify port `5173` is listening.

- [ ] **Step 3: Perform a live read-only Codex verification.** Save/select Codex only if needed, call the provider test endpoint, and request one safe inventory lookup. Inspect only status, model, timing, and tool names; do not print bearer tokens or raw command output.

- [ ] **Step 4: Review and commit only plan-owned files.** Run `git diff --check`, inspect `git status --short`, and commit the implementation after all checks report success.
