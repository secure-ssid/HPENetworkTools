# Persistent Codex CLI Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the portal's per-message Codex CLI startup with a private,
CentralMCP-only persistent app-server and provide the requested speed-first
model dropdown.

**Architecture:** A shared model catalog drives settings validation and the
React selector. `CodexAppServer` owns a private authenticated child, validates
its JSONL protocol and exact MCP inventory, and provides a fresh ephemeral
thread per chat. `CodexAdapter` uses it first and retains its current isolated
`codex exec` route only for failures that occur before a turn starts.

**Tech Stack:** TypeScript, Node child processes/filesystem, Express, React,
Vitest, locally authenticated Codex CLI 0.145.0, CentralMCP streamable HTTP.

## Global Constraints

- The provider is normal local Codex CLI only, never Computer Use, browser,
  desktop app, global app-server daemon, or inherited global MCP.
- The allowed Codex model IDs are exactly `gpt-5.3-spark`, `gpt-5.6-luna`,
  `gpt-5.6-terra`, `gpt-5.4`, and `gpt-5.4-mini`.
- Default to `gpt-5.3-spark` and `auto`; auto omits an effort override.
- Every private child uses an empty owner-only workspace and isolated
  owner-only `CODEX_HOME` with only a copied mode-0600 authenticated
  `auth.json`; no user config/rules/history/project files are inherited.
- Launch only with `--strict-config --disable apps --disable plugins --disable
  computer_use --disable browser_use` and require exact `['centralmcp']`
  inventory before a model turn.
- The CentralMCP bearer token is a child environment variable only. Never put
  it in arguments, logs, JSONL responses, browser payloads, or a scope key.
- No fallback/replay is allowed after `turn/start` could have run a tool.
- Lab writes remain immediate when the existing `chatWriteMode` enables them.

---

### Task 1: Share the requested Codex model catalog and selector

**Files:**
- Create: `shared/assistantModels.ts`
- Modify: `server/src/config/settings.ts`
- Modify: `server/src/services/assistant/cliAdapters.ts`
- Modify: `server/src/services/assistant/registry.ts`
- Modify: `web/src/screens/systems/AssistantSection.tsx`
- Test: `server/tests/assistantProviders.test.ts`
- Test: `web/src/screens/Systems.test.tsx`

**Interfaces:**
- Produces `CODEX_MODEL_OPTIONS` with `{ id, label }` entries and
  `isCodexModel(id): boolean` for server validation and browser rendering.
- Codex config has
  `{ enabled: boolean; model: CodexModelId; reasoningEffort: 'auto' | 'low' | 'medium' | 'high' }`.

- [ ] **Step 1: Write failing model catalog and selector tests.**

```ts
expect(screen.getByLabelText('Model')).toHaveDisplayValue('gpt-5.3-spark');
expect(screen.getByRole('option', { name: /Spark.*fastest/i })).toBeInTheDocument();
expect(screen.getByRole('option', { name: /Luna/i })).toBeInTheDocument();
expect(screen.getByRole('option', { name: /Terra/i })).toBeInTheDocument();
expect(screen.getByRole('option', { name: /GPT-5\.4 Mini/i })).toBeInTheDocument();
expect(screen.getByRole('option', { name: /Auto.*normal/i })).toBeInTheDocument();
```

```ts
await expect(adapter.discover({ enabled: true, model: 'gpt-5.3-spark', reasoningEffort: 'auto' }))
  .resolves.toMatchObject({ installed: true });
await expect(adapter.discover({ enabled: true, model: 'not-a-model', reasoningEffort: 'auto' }))
  .resolves.toMatchObject({ installed: false });
```

- [ ] **Step 2: Run the focused tests and observe the expected failures.**

Run: `npm run test -w server -- assistantProviders.test.ts && npm run test -w web -- Systems.test.tsx`

Expected: the current free-text model field and Terra/low-only validation fail
the new assertions.

- [ ] **Step 3: Implement the single catalog and persisted compatibility.**

```ts
export const CODEX_MODEL_OPTIONS = [
  { id: 'gpt-5.3-spark', label: 'Spark · fastest' },
  { id: 'gpt-5.6-luna', label: 'Luna · fast' },
  { id: 'gpt-5.6-terra', label: 'Terra · balanced' },
  { id: 'gpt-5.4', label: 'GPT-5.4 · legacy' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini · legacy quick' },
] as const;
```

Migrate old persisted Codex `low` configs unchanged, set defaults to Spark /
auto, use the same predicate in `isCodexConfig`, and replace only the Codex
free-text input with `Select`. Keep other providers unchanged.

- [ ] **Step 4: Run the focused suite and typechecks.**

Run: `npm run test -w server -- assistantProviders.test.ts && npm run test -w web -- Systems.test.tsx && npm run typecheck -w server && npm run typecheck -w web`

Expected: PASS.

- [ ] **Step 5: Commit the catalog/selector task.**

```bash
git add shared/assistantModels.ts server/src/config/settings.ts server/src/services/assistant/cliAdapters.ts server/src/services/assistant/registry.ts web/src/screens/systems/AssistantSection.tsx server/tests/assistantProviders.test.ts web/src/screens/Systems.test.tsx
git commit -m "feat: add fast Codex model selector"
```

### Task 2: Implement the private persistent Codex app-server transport

**Files:**
- Create: `server/src/services/assistant/codexAppServer.ts`
- Modify: `server/src/services/assistant/types.ts`
- Modify: `server/src/services/assistant/cliAdapters.ts`
- Test: `server/tests/codexAppServer.test.ts`
- Test: `server/tests/assistantProviders.test.ts`

**Interfaces:**
- Produces `CodexAppServer.chat(input)` and `CodexAppServer.probe(input)`.
- Consumes `{ endpoint, authToken, writeEnabled, model, reasoningEffort,
  prompt, timeoutMs, signal }` and returns the existing assistant result or a
  typed stage (`before-turn` / `after-turn`) failure.
- `CodexAdapter` invokes the existing one-shot command only for a
  `before-turn` failure.

- [ ] **Step 1: Write failing JSONL lifecycle tests with a fake child.**

```ts
await transport.chat(request);
expect(fake.sentMethods()).toEqual([
  'initialize', 'initialized', 'thread/start', 'mcpServerStatus/list', 'turn/start',
]);
expect(fake.env.HPE_ASSISTANT_MCP_TOKEN).toBe('secret-token');
expect(fake.sentText()).not.toContain('secret-token');
expect(fake.workspaceMode).toBe(0o700);
expect(fake.authMode).toBe(0o600);
```

```ts
fake.replyInventory(['centralmcp', 'computer-use']);
await expect(transport.chat(request)).rejects.toMatchObject({ stage: 'before-turn' });
expect(fake.sentMethods()).not.toContain('turn/start');

fake.acceptTurnThenDisconnect();
await expect(adapter.chat(request)).rejects.toThrow(/did not complete/i);
expect(oneShotRunner.calls).toHaveLength(0);
```

- [ ] **Step 2: Run the new transport tests and observe failure.**

Run: `npm run test -w server -- codexAppServer.test.ts assistantProviders.test.ts`

Expected: FAIL because no persistent transport exists.

- [ ] **Step 3: Implement the private process and strict protocol parser.**

```ts
const args = [
  'app-server', '--stdio', '--strict-config',
  '--disable', 'apps', '--disable', 'plugins',
  '--disable', 'computer_use', '--disable', 'browser_use',
];
```

Create a 0700 private home/workspace, copy the local authenticated
`auth.json` as 0600 without reading/logging it, spawn without a shell, and
communicate through request IDs. Start an ephemeral read-only thread with
flattened CentralMCP config; require exact inventory before `turn/start`.
Accept only completed `agentMessage` and `mcpToolCall` items for
`centralmcp`. Restart/dispose on scope change, abort, invalid event, or
process error.

- [ ] **Step 4: Integrate safe fallback in `CodexAdapter`.**

Use app-server results first. A failure before `turn/start` uses the current
isolated `codex exec` command. A failure after turn start returns a safe error
and disposes the app-server; it never replays a possibly mutating request.
For `auto`, omit `model_reasoning_effort`; for explicit effort, use the
selected value in both transports.

- [ ] **Step 5: Run focused tests, typecheck, and commit.**

Run: `npm run test -w server -- codexAppServer.test.ts assistantProviders.test.ts && npm run typecheck -w server && git diff --check`

Expected: PASS.

```bash
git add server/src/services/assistant/codexAppServer.ts server/src/services/assistant/types.ts server/src/services/assistant/cliAdapters.ts server/tests/codexAppServer.test.ts server/tests/assistantProviders.test.ts
git commit -m "feat: keep Codex CLI assistant warm"
```

### Task 3: Verify persistent behavior and live provider selection

**Files:**
- Modify: `README.md` only if the assistant setup copy is stale.
- Test: `server/tests/chat.test.ts`
- Test: `web/src/screens/Systems.test.tsx`

**Interfaces:**
- Uses Task 1's persisted selector and Task 2's app-server transport.
- Produces a provider test that reports actual selected-model availability,
  never a green status solely because a picker option exists.

- [ ] **Step 1: Add a failing chat integration test.**

```ts
expect(fakeAppServer.startCount).toBe(1);
await chatOnce('first read-only request');
await chatOnce('second read-only request');
expect(fakeAppServer.threadCount).toBe(2);
expect(fakeAppServer.startCount).toBe(1);
```

- [ ] **Step 2: Run the integration test and observe failure.**

Run: `npm run test -w server -- chat.test.ts`

- [ ] **Step 3: Wire the existing provider test/status cache to the selected model.**

The status uses a CentralMCP `find_tool` read-only probe. It reports an
unsupported account model as unavailable without leaking model-provider
diagnostics or attempting a write.

- [ ] **Step 4: Run complete affected verification.**

Run: `npm run test -w server -- codexAppServer.test.ts assistantProviders.test.ts chat.test.ts mcpChat.test.ts && npm run test -w web -- Systems.test.tsx && npm run typecheck -w server && npm run typecheck -w web && npm run build -w web && git diff --check`

Expected: PASS.

- [ ] **Step 5: Restart and prove the selected provider safely.**

Confirm the existing port-5173 listener is the portal, restart it from the
committed tree, select Codex/Spark (or another dropdown option), press
**Test provider**, then ask for one safe inventory lookup. Record only
provider status, selected model, elapsed timing, and CentralMCP tool names.
Never use a configuration write merely to demonstrate lab access.

