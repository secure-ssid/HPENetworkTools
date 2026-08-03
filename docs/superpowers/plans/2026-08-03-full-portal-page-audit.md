# Full Portal Page Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every routed portal page show the useful live information, retain working drill-throughs and lab-direct writes, and state a real connector failure without blanking unrelated data.

**Architecture:** Audit each route against its live API envelope first, then cover the screen's populated, empty, and failed states with its existing Vitest/Testing Library test. Correct one page family at a time and keep vendor credentials masked; direct lab writes remain enabled without tickets, approvals, or delays.

**Tech Stack:** React 18, React Router 6, TypeScript, Vitest, Testing Library, Express, shared HPE view models.

## Global Constraints

- Lab configuration writes are direct and enabled by default; do not introduce ticket, review, lease, approval, or delay gates.
- Never display, log, export, or commit credentials, API tokens, client secrets, or raw vendor error bodies.
- A live API failure must remain visible as a failure; do not substitute demo data for an answered failure.
- Preserve useful operational fields and drill-through actions; remove only repeated/no-value information.
- Every production behavior change starts with a focused failing test and ends with focused tests, typecheck, production build, and a committed change.

---

### Task 1: Establish a route-to-live-contract baseline

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-full-portal-page-audit.md`
- Inspect: `web/src/app/routes.tsx`
- Inspect: `server/src/routes/screens.ts`

**Interfaces:**
- Consumes: the 20 routed screen paths from `AppRoutes` and the GET screen contracts in `screensRouter`.
- Produces: a checked route matrix with one safe live-envelope result for each routed screen before any UI conclusion is made.

- [ ] **Step 1: Record the exact route matrix**

  Audit `/overview`, `/topology`, `/alerts`, `/tickets`, `/clients`, `/auth-events`, `/clearpass`, `/central`, `/mist`, `/inventory`, `/sites`, `/devices`, `/licenses`, `/greenlake`, `/configure`, `/compliance`, `/systems`, `/uxi`, `/sites/:siteId`, and `/devices/:name`.

- [ ] **Step 2: Query each non-mutating screen route through the running local API**

  Run a safe JSON-shape probe that records only HTTP status, `dataSource`, top-level keys, row counts, and provenance/error-state keys. Do not print tenant objects, client MACs, credentials, or raw vendor payloads.

- [ ] **Step 3: Record pass/fail evidence beside every route**

  A route passes the baseline only when it returns a readable envelope and its screen has a reachable populated or honest empty/failed state. A failed connector is recorded against that plane only, not used to mark every page failed.

### Task 2: Restore useful client information without restoring table noise

**Files:**
- Modify: `web/src/screens/Clients.tsx`
- Modify: `web/src/screens/Clients.test.tsx`
- Inspect: `web/src/screens/dataColumns.tsx`

**Interfaces:**
- Consumes: `ClientRow.ip`, `link`, `rssi`, `snr`, `retries`, `tput`, `roams`, and `quality` from `@hpe/shared`.
- Produces: visible client table columns for the useful facts the live API already supplies; absent values remain absent instead of being invented.

- [ ] **Step 1: Write a failing Clients test for retained operational facts**

  Add three distinct live client rows with reported IP, signal, SNR, retries, throughput, roam count, and quality. Assert that the default `Client sessions` table exposes the corresponding headers and the reported values, while a column containing only `—` is still omitted.

- [ ] **Step 2: Run the test to verify the current omission**

  Run: `npm run test -w web -- src/screens/Clients.test.tsx`

  Expected: FAIL because the present `columns` definition does not include those live fields.

- [ ] **Step 3: Add only the retained client columns**

  Extend `columns` in `Clients.tsx` with `IP`, `Link`, `Signal`, `SNR`, `Retries`, `Throughput`, `Roams`, and `Quality`. Use the existing `reported()` formatter and existing numeric/mono style conventions; retain `partitionColumns()` so identical facts still appear once below the table.

- [ ] **Step 4: Verify the focused client behavior**

  Run: `npm run test -w web -- src/screens/Clients.test.tsx`

  Expected: PASS, including the new retained-facts case and the existing drawer/drill-through cases.

- [ ] **Step 5: Commit the isolated client correction**

  Run: `git add web/src/screens/Clients.tsx web/src/screens/Clients.test.tsx && git commit -m "fix: retain useful client facts"`

### Task 3: Make ClearPass connection state actionable and keep its screen truthful

**Files:**
- Modify: `web/src/screens/Systems.tsx` or the owning connection form component discovered during Task 1
- Modify: `server/src/connectors/catalog.ts` only if a masked static-token connection cannot reach `ClearPassAdapter`
- Modify: the closest existing ClearPass/system test file for the chosen form
- Inspect: `server/src/planes/clearpass.ts`, `server/src/config/settings.ts`, `server/src/routes/screens.ts`

**Interfaces:**
- Consumes: ClearPass endpoint, TLS choice, OAuth client credentials or a pre-minted bearer token.
- Produces: one unambiguous connector mode and an operator-visible degraded message when the live CPPM cannot complete its chosen auth path.

- [ ] **Step 1: Write a failing form/config test for the selected ClearPass credential mode**

  Assert that a saved ClearPass token mode sends `{ kind: 'token', token: '<masked replacement>' }` through the existing connector-settings API without falling back to OAuth client credentials. Assert that client-credential mode continues to send only its own fields.

- [ ] **Step 2: Run the selected focused test to prove the current mode cannot be selected or persists incorrectly**

  Run the owning Systems/connector test file identified in Task 1.

  Expected: FAIL for the missing or misrouted token-mode contract.

- [ ] **Step 3: Implement the smallest connector-mode correction**

  Reuse the connector catalog's existing `auth.token` adapter path. Mask retained credentials in responses, leave `verifyTls: false` available for the lab CPPM, and do not alter lab write admission.

- [ ] **Step 4: Verify ClearPass route states**

  Run the focused web/server test files and call `GET /api/clearpass`, `GET /api/clearpass/endpoints`, and `GET /api/systems/state`. The screen must show live rows when CPPM connects and an explicit plane degradation when its TLS/auth handshake fails.

- [ ] **Step 5: Commit the ClearPass correction separately**

  Run: `git add <tested ClearPass files> && git commit -m "fix: make ClearPass auth mode explicit"`

### Task 4: Repair and verify topology interaction and layout

**Files:**
- Modify: `web/src/screens/Topology.tsx`
- Modify: `web/src/screens/Topology.test.tsx`
- Modify: `web/src/screens/SiteTopologyDiagram.test.tsx` only if the shared interaction needs correction
- Inspect: `server/src/routes/screens.ts`

**Interfaces:**
- Consumes: `TopologyGraph` with managed nodes, ghost nodes, sites, and reported edges from `GET /api/topology`.
- Produces: visible site/device cards, a clear live-source status, and tested click/keyboard navigation from nodes to device/site detail routes.

- [ ] **Step 1: Write a failing topology interaction or layout regression test based on the live graph shape**

  Use a graph with four sites, sixteen managed nodes, one ghost, and cross-site edges. Assert the visible node labels remain reachable, a normal click opens the device route, a focused click keeps its one-hop edge visible, and the graph has a readable empty state when there are no nodes.

- [ ] **Step 2: Run the topology test to observe the regression**

  Run: `npm run test -w web -- src/screens/Topology.test.tsx src/screens/SiteTopologyDiagram.test.tsx`

  Expected: FAIL only when the observed broken interaction/layout is represented; do not change topology styling before this evidence exists.

- [ ] **Step 3: Implement the minimum layout/interaction correction**

  Keep the graph’s reported-only provenance. Correct the failed card sizing, clipping, focus, or navigation path without changing graph construction or inventing edges.

- [ ] **Step 4: Verify the topology family**

  Run: `npm run test -w web -- src/screens/Topology.test.tsx src/screens/SiteTopologyDiagram.test.tsx src/screens/SiteTopology.test.ts`

- [ ] **Step 5: Commit the isolated topology correction**

  Run: `git add web/src/screens/Topology.tsx web/src/screens/Topology.test.tsx web/src/screens/SiteTopologyDiagram.test.tsx && git commit -m "fix: restore topology interaction"`

### Task 5: Audit the operational-route families

**Files:**
- Inspect/modify as indicated by evidence: `web/src/screens/Overview.tsx`, `Alerts.tsx`, `Tickets.tsx`, `AuthEvents.tsx`, `Inventory.tsx`, `Sites.tsx`, `Devices.tsx`, `SiteDetail.tsx`, `DeviceDetail.tsx`, `Licenses.tsx`
- Test: the corresponding existing `*.test.tsx` files

**Interfaces:**
- Consumes: the screen-specific `GET /api/*` envelopes already defined in `web/src/api/screens.ts`.
- Produces: a completed populated/empty/error/drill-through checklist for each core operations page.

- [ ] **Step 1: Run the core operations screen tests as one evidence batch**

  Run: `npm run test -w web -- src/screens/Overview.test.tsx src/screens/Alerts.test.tsx src/screens/Tickets.test.tsx src/screens/AuthEvents.test.tsx src/screens/Inventory.test.tsx src/screens/Sites.test.tsx src/screens/Devices.test.tsx src/screens/SiteDetail.test.tsx src/screens/DeviceDetail.test.tsx src/screens/Licenses.test.tsx`

- [ ] **Step 2: For each failing or live-empty page, add one focused regression test before editing that page**

  The test must assert a concrete view-model fact or a concrete route/deep-link, for example a device row opens `/devices/:name`, a license filter suppresses unassigned expired records, or an alert action updates the visible row.

- [ ] **Step 3: Implement only the failure’s owning screen/API correction and rerun that test file**

  Use the screen’s current API helper and preserve its `apiError` state; never add a fixture fallback to an answered live failure.

- [ ] **Step 4: Commit each independently verified core-page correction**

  Use one commit per tested screen family, named `fix: repair <screen family> page state`.

### Task 6: Audit the product, configuration, and connected-systems families

**Files:**
- Inspect/modify as indicated by evidence: `web/src/screens/Central.tsx`, `Mist.tsx`, `GreenLake.tsx`, `Uxi.tsx`, `Configure.tsx`, `Compliance.tsx`, `Systems.tsx`, and `web/src/screens/systems/*`
- Test: `Central.test.tsx`, `Mist.test.tsx`, `GreenLake.test.tsx`, `Configure.test.tsx`, `ConfigureBulk.test.tsx`, `Compliance.test.tsx`, `Systems.test.tsx`, and existing systems subcomponent tests

**Interfaces:**
- Consumes: each product’s read envelope and existing direct-write APIs.
- Produces: a complete product-page checklist showing editable lab controls, visible read data, and truthful degraded states per plane.

- [ ] **Step 1: Run the product/configuration test evidence batch**

  Run: `npm run test -w web -- src/screens/Central.test.tsx src/screens/Mist.test.tsx src/screens/GreenLake.test.tsx src/screens/Configure.test.tsx src/screens/ConfigureBulk.test.tsx src/screens/Compliance.test.tsx src/screens/Systems.test.tsx src/screens/systems/IdentityProviderSection.test.tsx src/screens/systems/MistSection.test.tsx src/screens/systems/NotificationsSection.test.tsx src/screens/systems/PlaneRow.test.ts`

- [ ] **Step 2: Verify each product’s GET response and declared write capability**

  Use safe, redacted probes for `/api/central`, `/api/mist`, `/api/uxi`, `/api/configure`, `/api/compliance`, and `/api/systems`. Record counts/status only and inspect lab-direct write controls without submitting a configuration mutation.

- [ ] **Step 3: Correct each confirmed product-page regression test-first**

  A valid correction keeps useful inventory, configuration fields, and drill-throughs visible; it must not reintroduce broker/ticket copy or hidden write gates in lab mode.

- [ ] **Step 4: Commit independently verified product/configuration corrections**

  Use one commit per coherent product screen family.

### Task 7: Final full-route verification and handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-full-portal-page-audit.md`

**Interfaces:**
- Consumes: all completed task results.
- Produces: a local running build with route evidence, known external connector conditions, and a clean worktree.

- [ ] **Step 1: Run the full production verification**

  Run: `npm run typecheck && npm run build && npm test`

- [ ] **Step 2: Repeat the safe route matrix against the freshly restarted local server**

  Confirm all screen endpoints answer, record any still-external vendor failure by plane, and never print credentials or tenant records.

- [ ] **Step 3: Check source and commit state**

  Run: `git diff --check && git status --short && git log --oneline -10`

- [ ] **Step 4: Report the completed pages, remaining externally unreachable planes, and the exact local reload step**

  State only verified results. Leave the latest local server running for the user unless they ask to stop it.
