# Product Connector Integrity and Unified Clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Repair the dirty worktree's current gates and make every supported product connector independently configurable, authenticated, and represented in the unified Clients overview.

**Architecture:** A browser-safe shared catalog defines product metadata and a discriminated connector configuration. The server uses one factory to convert valid configurations into real adapters, while every adapter owns an authenticated minimal-read connection probe. Client aggregation groups observations by canonical endpoint identity but retains every product source.

**Tech Stack:** TypeScript 5.7, Node 20/22, Express 4, React 18, Vite, Vitest, npm workspaces.

## Global Constraints

- Preserve all tracked, staged, and untracked work. Do not reset, clean, or discard `drawer-check.yml` without an explicit user decision.
- Support one independently configured connector per product for this iteration.
- New Central, Central Classic, and Mist have separate configuration, validation, UI state, and client provenance.
- AOS-10 is Central-derived. It has no independent credential form, probe, or poller adapter.
- An enabled connector must never save if it would instantiate a `StubAdapter`.
- A successful connection test must authenticate and read a minimal permitted product API. Reachability alone is not connected.
- Secrets are write-only/masked. HTTPS is required when a credential travels except for visibly labelled lab-only TLS relaxation.
- Do not expose configuration push for a product that does not publish a compatible API.
- Every behavior change follows a red, green, refactor test cycle.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/connectors.ts` | UI-safe product catalog, typed connector configuration, parser, masker, and legacy-plane migration. |
| `shared/connectors.test.ts` | Catalog coverage, typed parsing, masking, and migration tests. |
| `server/src/connectors/catalog.ts` | Adapter factory, typed-to-adapter conversion, and probe dispatch. |
| `server/src/config/settings.ts` | Typed connector persistence and masked settings views. |
| `server/src/planes/*.ts` | Product-owned authenticated minimal-read probes. |
| `server/src/routes/systems.ts` | Probe-before-save lifecycle with no generic reachability fallback. |
| `web/src/screens/Systems.tsx` | Catalog-driven product editor. |
| `server/src/routes/screens/liveCore.ts` | Provenance-preserving grouped client observations. |
| `web/src/screens/Clients.tsx` | Aggregate source badges, source filters, and source details. |

### Task 1: Stabilize the Existing Test Gate

**Files:**
- Modify: `web/src/api/client.test.ts:1987-2056`
- Modify: `web/src/screens/Mist.test.tsx:34-151`
- Modify: `web/src/api/screens.ts:1265`
- Test: `web/src/api/client.test.ts` and `web/src/screens/Mist.test.tsx`

**Interfaces:**
- Consumes: Node `http.Server.closeAllConnections()` and shared `hhmmLocal()`.
- Produces: deterministic HTTP-test teardown and timezone-independent fixture assertions.

- [ ] **Step 1: Write the failing deterministic teardown test**

Keep the strict Central webhook request-shape test and make its cleanup close active sockets before `server.close()`.

```ts
finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
```

- [ ] **Step 2: Verify the red timeout**

Run: `npm run test -w web -- src/api/client.test.ts`

Expected: the strict webhook HTTP-boundary test exceeds the 5-second timeout in its close callback before the socket-close code exists.

- [ ] **Step 3: Implement the close without changing production code**

Apply the cleanup in Step 1. Do not increase Vitest timeouts.

- [ ] **Step 4: Write the timezone-stable Mist expectation**

Import `hhmmLocal` in `Mist.test.tsx` and make the expected demo stamp follow the renderer.

```ts
expect(
  screen.getByText(new RegExp(
    'sync stamp ' + hhmmLocal(MIST_PLANE_STATUS.lastSync!) + ' · DEMO FIXTURE',
  )),
).toBeTruthy();
```

- [ ] **Step 5: Verify the red/green fixture behavior**

Run: `npm run test -w web -- src/screens/Mist.test.tsx`

Expected before the assertion update: a local-timezone mismatch. Expected after: pass without changing the fixture or `Mist.tsx`.

- [ ] **Step 6: Remove the whitespace defect and run the narrow gate**

Delete the trailing blank line reported at `web/src/api/screens.ts:1265`.

Run: `git diff --check -- web/src/api/screens.ts && npm run test -w web -- src/api/client.test.ts src/screens/Mist.test.tsx`

Expected: no whitespace diagnostics and both test files pass.

- [ ] **Step 7: Commit only the repair**

```bash
git add web/src/api/client.test.ts web/src/screens/Mist.test.tsx web/src/api/screens.ts
git commit --only -m "test: stabilize web API and fixture gates" -- \
  web/src/api/client.test.ts web/src/screens/Mist.test.tsx web/src/api/screens.ts
```

### Task 2: Define the Shared Connector Catalog

**Files:**
- Create: `shared/connectors.ts`
- Create: `shared/connectors.test.ts`
- Modify: `shared/types.ts:2443-2520,1053-1058`
- Modify: `shared/index.ts`
- Modify: `shared/fixtures.ts:2397-2587`
- Test: `shared/connectors.test.ts`

**Interfaces:**
- Consumes: `PlaneKey`, `PlaneDatasetKey`, `Tone`, and legacy plane credential records.
- Produces: `ConnectorId`, `ConnectorConfig`, `ConnectorCatalogEntry`, `CONNECTOR_CATALOG`, `parseConnectorConfig()`, `maskConnectorConfig()`, and `migrateLegacyPlaneRecord()`.

- [ ] **Step 1: Write the failing catalog tests**

```ts
expect(CONNECTOR_CATALOG.map((entry) => entry.id)).toEqual([
  'central', 'classic', 'mist', 'greenlake', 'clearpass', 'uxi',
  'aos8', 'local', 'sse', 'edgeconnect', 'opsramp',
]);
expect(parseConnectorConfig('mist', {
  enabled: true,
  endpoint: 'https://api.mist.com',
  auth: { kind: 'token', token: 'mist-secret' },
})).toMatchObject({ id: 'mist', enabled: true, auth: { kind: 'token' } });
expect(maskConnectorConfig(mistConfig)).not.toContain('mist-secret');
expect(migrateLegacyPlaneRecord('opsramp', {
  tenantId: 'tenant-a', clientId: 'client-a', clientSecret: 'secret-a',
})).toMatchObject({ endpoint: 'https://app.opsramp.net' });
```

- [ ] **Step 2: Verify the red shared test**

Run: `npm run test -w shared -- connectors.test.ts`

Expected: FAIL because no connector module or exports exist.

- [ ] **Step 3: Implement discriminated configuration and catalog metadata**

Define a `ConnectorConfig` union with one member for each of the eleven configurable products. Each member has `id`, `enabled`, `endpoint`, `auth`, `verifyTls`, `pollIntervalSec`, `callBudget`, `datasets`, and `scopes`. Define the closed authentication union as OAuth client credentials, token, API key, username/password, or SSH credentials.

Catalog entries must hold product label, endpoint options, permitted auth types/fields, supported datasets, scope options, client contribution, and currently supported write capabilities. Move the current `CONNECT_TYPE_OPTIONS`, `CONNECT_FIELDS`, and endpoint metadata to derived compatibility exports so `Systems.tsx` can migrate without duplicate product truth.

- [ ] **Step 4: Implement parser, masker, and legacy migration**

`parseConnectorConfig()` rejects wrong product ids, unsupported auth kind, unknown nested fields, empty requirements, unsupported datasets/scopes, and a non-loopback HTTP endpoint. `maskConnectorConfig()` replaces every key/token/password/passphrase value. `migrateLegacyPlaneRecord()` retains stored scope strings, call budget, TLS flag, and approved firmware while producing the typed default endpoint and auth form.

Add `ClientObservation` and `sources` to the client contract; a grouped live client must retain each source row, source plane, observed time, and stale state.

- [ ] **Step 5: Run shared verification**

Run: `npm run typecheck -w shared && npm run test -w shared -- connectors.test.ts`

Expected: all eleven products parse and mask correctly; AOS-10 is absent; legacy OpsRamp produces a valid default endpoint config.

- [ ] **Step 6: Commit the shared contract**

```bash
git add shared/connectors.ts shared/connectors.test.ts shared/types.ts shared/index.ts shared/fixtures.ts
git commit --only -m "feat: add typed product connector catalog" -- \
  shared/connectors.ts shared/connectors.test.ts shared/types.ts shared/index.ts shared/fixtures.ts
```

### Task 3: Persist Typed Connectors and Build Valid Adapters Only

**Files:**
- Create: `server/src/connectors/catalog.ts`
- Create: `server/src/connectors/catalog.test.ts`
- Modify: `server/src/config/settings.ts`
- Modify: `server/src/planes/registry.ts`
- Modify: `server/src/planes/types.ts`
- Modify: `server/tests/settings.test.ts`

**Interfaces:**
- Consumes: `ConnectorConfig`, existing adapter constructors, and the settings store.
- Produces: `adapterCredentialsFor(config)`, `createConnectorAdapter(config, state, recordCall)`, and `connectorConfigFor(settings, id)`.

- [ ] **Step 1: Write failing settings-migration tests**

```ts
const store = new SettingsStore(file);
expect(store.load().connectors.opsramp).toMatchObject({
  id: 'opsramp', enabled: true, endpoint: 'https://app.opsramp.net',
});
expect(store.maskedView().connectors.opsramp.auth).toMatchObject({
  kind: 'oauthClientCredentials', clientSecret: MASK,
});
```

- [ ] **Step 2: Verify the settings red state**

Run: `npm run test -w server -- tests/settings.test.ts`

Expected: FAIL because `Settings` has no `connectors` record.

- [ ] **Step 3: Implement a one-way settings migration**

Add `connectors: Record<ConnectorId, ConnectorConfig | null>`. On load, migrate a `planes[id]` record only when a typed connector is absent, then write the typed shape on the next save. Keep `planes` as a derived compatibility read until every existing consumer uses `connectorConfigFor()`; it must not remain a second mutable source. Apply shared parsing and masking in `merged()` and `maskedView()`.

- [ ] **Step 4: Write failing factory tests**

```ts
expect(() => createConnectorAdapter(invalidLocal, state, recordCall)).toThrow(
  /baseUrl plus username\/password/,
);
expect(createConnectorAdapter(validOpsRamp, state, recordCall)).toBeInstanceOf(OpsRampAdapter);
```

- [ ] **Step 5: Implement the server catalog and registry**

Use one exhaustive switch in `server/src/connectors/catalog.ts` to convert each valid typed configuration to the exact keys its adapter already reads. The same factory creates Central, Classic, Mist, GreenLake, ClearPass, UXI, AOS-8, Local AOS-CX, SSE, EdgeConnect, and OpsRamp adapters. Replace the registry's long completeness chain with the factory. An invalid enabled connector yields a configuration error state; it never yields a `StubAdapter`. Derive AOS-10 visibility from Central capabilities.

- [ ] **Step 6: Run server catalog/settings verification**

Run: `npm run typecheck -w server && npm run test -w server -- src/connectors/catalog.test.ts tests/settings.test.ts`

Expected: a stored legacy record migrates, secrets mask, and every valid enabled connector makes a real adapter.

- [ ] **Step 7: Commit the persistence foundation**

```bash
git add server/src/connectors/catalog.ts server/src/connectors/catalog.test.ts \
  server/src/config/settings.ts server/src/planes/registry.ts server/src/planes/types.ts server/tests/settings.test.ts
git commit --only -m "feat: persist typed connector configurations" -- \
  server/src/connectors/catalog.ts server/src/connectors/catalog.test.ts \
  server/src/config/settings.ts server/src/planes/registry.ts server/src/planes/types.ts server/tests/settings.test.ts
```

### Task 4: Use Authenticated Product Probes for Test and Save

**Files:**
- Create: `server/src/planes/connectionProbe.ts`
- Modify: `server/src/planes/types.ts`
- Modify: `server/src/planes/central.ts`, `mist.ts`, `aos8.ts`, `aoscx.ts`, `edgeconnect.ts`, `opsramp.ts`, `greenlake.ts`, `clearpass.ts`, `uxi.ts`, `sse.ts`
- Modify: `server/src/connectors/catalog.ts`
- Modify: `server/src/routes/systems.ts`
- Modify: `server/tests/systems.test.ts` and product adapter tests

**Interfaces:**
- Consumes: typed connector config and each adapter's existing auth/read transport.
- Produces: `ConnectionProbeResult` and `probeConnector(config, recordCall)`.

- [ ] **Step 1: Write the failing authenticated-probe tests**

For Mist, AOS-8, Local AOS-CX, EdgeConnect, and OpsRamp, inject a fake transport that returns a minimal response only when it sees the real product authentication and exact minimal-read path.

```ts
await expect(probeConnector(validMist, recordCall)).resolves.toMatchObject({
  ok: true, authenticated: true, dataset: 'devices',
});
await expect(probeConnector(validOpsRamp, recordCall)).resolves.toMatchObject({
  ok: true, authenticated: true, dataset: 'devices',
});
```

- [ ] **Step 2: Verify the probes are missing**

Run: `npm run test -w server -- tests/mist.test.ts tests/aoscx.test.ts tests/aos8.test.ts tests/edgeconnect.test.ts tests/opsramp.test.ts`

Expected: FAIL because the current route falls back to a generic reachability check.

- [ ] **Step 3: Define and implement adapter-owned probes**

Define `ConnectionProbeResult` with `ok`, `authenticated`, `dataset`, `message`, and optional HTTP status. Add `validateConnection()` to each real adapter, using the same authentication path and first core API family as its live pull:

| Product | Minimum proof |
| --- | --- |
| New Central | OAuth token plus monitoring device/AP read |
| Central Classic | classic token plus classic monitoring read |
| Mist | Token auth plus org devices read |
| GreenLake | SSO token plus workspace platform read |
| ClearPass | OAuth/token plus endpoint repository read |
| UXI | SSO token plus sensor roster read |
| AOS-8 | controller login plus showcommand read |
| Local AOS-CX | REST cookie plus `GET /system` |
| SSE | bearer token plus Connectors read |
| EdgeConnect | API key/login plus Appliances read |
| OpsRamp | OAuth token plus tenant Resources read |

Every probe validates HTTPS before transmitting credentials, redacts secrets in messages, and reports insufficient scope separately from invalid credentials.

- [ ] **Step 4: Replace route-local probe branches**

Delete `completeCredsFor()`, `testReachable()`, and the route-local product ternary in `systems.ts`. Resolve the typed submitted/stored connector with `connectorConfigFor()`, call `probeConnector()`, and record its dataset label. `POST /credentials` must probe before it persists and reinitializes, while retaining existing Central/SSE mutation guards and first-poll reporting.

- [ ] **Step 5: Run the product and route contracts**

Run: `npm run test -w server -- tests/systems.test.ts tests/mist.test.ts tests/aoscx.test.ts tests/aos8.test.ts tests/edgeconnect.test.ts tests/opsramp.test.ts`

Expected: no configurable product reports connected after bare reachability; incomplete Local, EdgeConnect, and OpsRamp records do not save.

- [ ] **Step 6: Commit authenticated validation**

```bash
git add server/src/planes/connectionProbe.ts server/src/planes server/src/connectors/catalog.ts server/src/routes/systems.ts server/tests
git commit --only -m "feat: validate every product connection authentically" -- \
  server/src/planes/connectionProbe.ts server/src/planes/central.ts server/src/planes/mist.ts \
  server/src/planes/aos8.ts server/src/planes/aoscx.ts server/src/planes/edgeconnect.ts \
  server/src/planes/opsramp.ts server/src/planes/greenlake.ts server/src/planes/clearpass.ts \
  server/src/planes/uxi.ts server/src/planes/sse.ts server/src/planes/types.ts \
  server/src/connectors/catalog.ts server/src/routes/systems.ts server/tests
```

### Task 5: Render the Catalog in Connected Systems

**Files:**
- Modify: `web/src/api/systems.ts`
- Modify: `web/src/screens/Systems.tsx`
- Modify: `web/src/screens/Systems.test.tsx`
- Modify: `web/src/screens/systems/facts.ts`

**Interfaces:**
- Consumes: `CONNECTOR_CATALOG`, `ConnectorConfig`, and `ConnectionProbeResult`.
- Produces: a one-product connector editor whose test snapshot contains every tested field.

- [ ] **Step 1: Write failing product-form tests**

For each catalog entry, select the product and assert only its allowed endpoint/auth fields render. Assert OpsRamp default endpoint, required Local AOS-CX REST URL, EdgeConnect API-key alternative, TLS warning, cadence, budget, datasets, scopes, and no AOS-10 select option.

```tsx
await user.selectOptions(screen.getByLabelText('System type'), 'opsramp');
expect(screen.getByLabelText('Tenant ID')).toBeTruthy();
expect(screen.getByLabelText('Client ID')).toBeTruthy();
expect(screen.getByDisplayValue('https://app.opsramp.net')).toBeTruthy();
expect(screen.queryByRole('option', { name: /AOS-10/i })).toBeNull();
```

- [ ] **Step 2: Verify the existing generic form fails**

Run: `npm run test -w web -- src/screens/Systems.test.tsx`

Expected: failing coverage for controls currently hidden in duplicated `CONNECT_*` maps.

- [ ] **Step 3: Implement manifest-driven form state**

Replace local endpoint/client-id/extra credential maps with a `ConnectorConfig` draft initialized from catalog defaults. Render endpoint, auth fields, TLS, poll cadence, call budget, datasets, and scopes from the selected entry. Any field update invalidates a probe snapshot. Show authenticated dataset wording after a successful test.

- [ ] **Step 4: Render accurate capability and derived-source state**

Show each product's declared read/write capabilities. AOS-10 appears only as a Central-derived capability note. A successful response must identify the authenticated probe dataset; a reachability-only phrase cannot be shown as connected.

- [ ] **Step 5: Run web verification and commit**

Run: `npm run typecheck -w web && npm run test -w web -- src/screens/Systems.test.tsx`

```bash
git add web/src/api/systems.ts web/src/screens/Systems.tsx web/src/screens/Systems.test.tsx web/src/screens/systems/facts.ts
git commit --only -m "feat: configure product connectors from one catalog" -- \
  web/src/api/systems.ts web/src/screens/Systems.tsx web/src/screens/Systems.test.tsx web/src/screens/systems/facts.ts
```

### Task 6: Preserve Every Client Source in the Unified Overview

**Files:**
- Modify: `server/src/routes/screens/liveCore.ts`
- Modify: `server/src/routes/screens/client360.ts`
- Modify: `server/src/routes/screens.ts:901-970`
- Modify: `server/tests/routes.test.ts` and `server/tests/client360.test.ts`
- Modify: `web/src/api/screens.ts`
- Modify: `web/src/screens/Clients.tsx` and `web/src/screens/Clients.test.tsx`

**Interfaces:**
- Consumes: raw per-plane `PlanePull.clients` and `ClientObservation`.
- Produces: grouped `ClientRow.sources` ordered by freshness and source filters/details in the browser.

- [ ] **Step 1: Write failing server grouping tests**

Seed Central and Mist for the same normalized MAC and one unrelated ClearPass endpoint. Assert one shared overview row has both source observations, a fresh source is primary over stale, and an enabled client-capable plane missing the dataset remains named.

```ts
expect(payload.clients).toHaveLength(2);
expect(payload.clients[0].sources.map((source) => source.plane)).toEqual(['central', 'mist']);
expect(payload.clients[0].sources[1].stale).toBe(true);
expect(payload.missingSources).toContain('aos8');
```

- [ ] **Step 2: Verify the red dedupe behavior**

Run: `npm run test -w server -- tests/routes.test.ts tests/client360.test.ts`

Expected: failure because `dedupeClients()` drops the second observation.

- [ ] **Step 3: Implement deterministic source grouping**

Replace `dedupeClients()` with `groupClientObservations()`. Group normalized MACs, keep missing MACs independent, order sources by fresh state then catalog order, and use the first source as primary. Keep raw observations in `liveClient360World()`; do not add poll-time API calls.

- [ ] **Step 4: Add failing browser source tests**

```tsx
expect(screen.getByRole('button', { name: /Central.*Mist/i })).toBeTruthy();
await user.click(screen.getByRole('button', { name: /show 2 sources/i }));
expect(screen.getByText(/Central.*current/i)).toBeTruthy();
expect(screen.getByText(/Mist.*unverified/i)).toBeTruthy();
```

- [ ] **Step 5: Implement source-aware roster UI**

Default to all sources. Retain per-product filters, render source count/badges, and expose each source observation in an expandable client detail. Native Central, Classic, and Mist pages remain source-specific.

- [ ] **Step 6: Run client verification and commit**

Run: `npm run test -w server -- tests/routes.test.ts tests/client360.test.ts && npm run test -w web -- src/screens/Clients.test.tsx`

```bash
git add server/src/routes/screens/liveCore.ts server/src/routes/screens/client360.ts server/src/routes/screens.ts \
  server/tests/routes.test.ts server/tests/client360.test.ts web/src/api/screens.ts web/src/screens/Clients.tsx \
  web/src/screens/Clients.test.tsx shared/types.ts
git commit --only -m "feat: preserve client provenance across products" -- \
  server/src/routes/screens/liveCore.ts server/src/routes/screens/client360.ts server/src/routes/screens.ts \
  server/tests/routes.test.ts server/tests/client360.test.ts web/src/api/screens.ts web/src/screens/Clients.tsx \
  web/src/screens/Clients.test.tsx shared/types.ts
```

### Task 7: Document and Verify the Connector Foundation

**Files:**
- Modify: `docs/configuration.md`
- Modify: `docs/user-guide.md`
- Modify: `scripts/smoke.sh`

- [ ] **Step 1: Add smoke assertions**

Require Systems output to expose eleven configurable connector ids, reject a standalone AOS-10 credential entry, and make the clients envelope expose `sources` for grouped live observations.

- [ ] **Step 2: Update documentation**

Document one connector per product, Central-derived AOS-10, authenticated test-before-save, explicit TLS relaxation, poll/dataset controls, and client source badges. State configuration pushes are capability-specific.

- [ ] **Step 3: Run fresh full evidence**

Run: `npm run typecheck && npm run lint && npm test && npm run build && bash scripts/smoke.sh`

Expected: exit 0. Run authenticated live probes only against disposable lab credentials and report the exact product/dataset result.

- [ ] **Step 4: Commit docs and smoke coverage**

```bash
git add docs/configuration.md docs/user-guide.md scripts/smoke.sh
git commit --only -m "docs: explain configurable product connectors" -- \
  docs/configuration.md docs/user-guide.md scripts/smoke.sh
```

