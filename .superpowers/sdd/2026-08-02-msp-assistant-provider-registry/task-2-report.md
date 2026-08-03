# Task 2 implementation and self-review — MSP Assistant Provider Registry

## Scope delivered

- Added the six-provider descriptor registry with the speed-first defaults, display titles, execution kinds, and required configuration fields.
- Added the shared adapter, readiness-status, chat, probe, and injection-safe command-runner contracts. The production runner uses argument arrays and `spawn(..., { shell: false })` with a minimal inherited environment.
- Added proof-based readiness orchestration. A provider is ready only after discovery and an adapter-recorded centralmcp read-only probe; executable discovery alone cannot set `mcpReady`.
- Added a disposable centralmcp-only launch configuration. It uses a unique temporary directory, owner-only config file mode `0600`, no product credentials, and cleanup of file and directory on normal disposal and creation failure.

## Files changed

- `server/src/services/assistant/types.ts`
- `server/src/services/assistant/registry.ts`
- `server/src/services/assistant/mcpLaunchConfig.ts`
- `server/tests/assistantProviders.test.ts`

## Test and verification results

- `pnpm --dir server test -- assistantProviders.test.ts` — blocked by the checkout's missing pnpm-linked Vitest executable (`sh: vitest: command not found`). This was also the expected red-command environment limitation.
- `npm --prefix server test -- assistantProviders.test.ts` — passed: 1 file, 7 tests. Covers exact defaults, unavailable executable, malformed configuration, actual centralmcp read-only proof and latency, lack of proof remaining unready, owner-only temporary config, normal cleanup, and cleanup after write failure.
- `npm --prefix server run typecheck` — passed (`tsc --noEmit`).
- `git diff --check` — passed before the implementation commit.

## Self-review

- Registry output never returns adapter exception or discovery text, so CLI diagnostics and credential-bearing failures are not exposed to browser/API consumers.
- The launch config serializes only the configured MCP endpoint and optional bearer token, under the single `centralmcp` server key. It contains no raw Central, Mist, ClearPass, shell, filesystem, browser, or unrelated MCP configuration.
- The status gate deliberately requires `centralMcpReadOnlyInvocation === true`; later native adapters must record that invocation instead of treating binary discovery as proof.
- The command-runner seam is isolated from adapters and forces `shell: false`; adapter-specific command construction and tool isolation are intentionally deferred to Task 4.

## Commit

Implementation commit: `09b1b804df611d159437fc32d7fbcfd00d68c31f` (`feat: add assistant provider registry and readiness checks`).

## Concerns

- The requested pnpm test command remains unavailable in this npm-lockfile checkout because its linked `vitest` executable is absent; the equivalent npm command passed.
- Native CLI adapters are intentionally not registered yet. Until Tasks 3–5 supply adapters that perform the real isolated probe, the registry reports them unavailable rather than ready.
