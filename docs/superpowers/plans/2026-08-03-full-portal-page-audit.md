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

- [x] **Step 1: Record the exact route matrix**

  Audit `/overview`, `/topology`, `/alerts`, `/tickets`, `/clients`, `/auth-events`, `/clearpass`, `/central`, `/mist`, `/inventory`, `/sites`, `/devices`, `/licenses`, `/greenlake`, `/configure`, `/compliance`, `/systems`, `/uxi`, `/sites/:siteId`, and `/devices/:name`.

- [x] **Step 2: Query each non-mutating screen route through the running local API**

  Run a safe JSON-shape probe that records only HTTP status, `dataSource`, top-level keys, row counts, and provenance/error-state keys. Do not print tenant objects, client MACs, credentials, or raw vendor payloads.

- [x] **Step 3: Record pass/fail evidence beside every route**

  A route passes the baseline only when it returns a readable envelope and its screen has a reachable populated or honest empty/failed state. A failed connector is recorded against that plane only, not used to mark every page failed.

  Baseline on 2026-08-03: every routed screen has a readable local API path. Inventory uses `/api/inventory/tree` and GreenLake uses `/api/greenlake/inventory`; both returned 200. ClearPass returned an honest empty live envelope because its own OAuth TLS handshake failed. The estate topology returned 16 managed nodes, 1 ghost, and 9 reported links.

### Task 2: Restore useful client information without restoring table noise

**Files:**
- Modify: `web/src/screens/Clients.tsx`
- Modify: `web/src/screens/Clients.test.tsx`
- Inspect: `web/src/screens/dataColumns.tsx`

**Interfaces:**
- Consumes: `ClientRow.ip`, `link`, `rssi`, `snr`, `retries`, `tput`, `roams`, and `quality` from `@hpe/shared`.
- Produces: visible client table columns for the useful facts the live API already supplies; absent values remain absent instead of being invented.

- [x] **Step 1: Write a failing Clients test for retained operational facts**

  Add three distinct live client rows with reported IP, signal, SNR, retries, throughput, roam count, and quality. Assert that the default `Client sessions` table exposes the corresponding headers and the reported values, while a column containing only `—` is still omitted.

- [x] **Step 2: Run the test to verify the current omission**

  Run: `npm run test -w web -- src/screens/Clients.test.tsx`

  Expected: FAIL because the present `columns` definition does not include those live fields.

- [x] **Step 3: Add only the retained client columns**

  Extend `columns` in `Clients.tsx` with `IP`, `Link`, `Signal`, `SNR`, `Retries`, `Throughput`, `Roams`, and `Quality`. Use the existing `reported()` formatter and existing numeric/mono style conventions; retain `partitionColumns()` so identical facts still appear once below the table.

- [x] **Step 4: Verify the focused client behavior**

  Run: `npm run test -w web -- src/screens/Clients.test.tsx`

  Expected: PASS, including the new retained-facts case and the existing drawer/drill-through cases.

- [x] **Step 5: Commit the isolated client correction**

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

**Current evidence:** The existing Systems test suite already proves that the connector form can save a ClearPass static token with the exact typed auth shape. The currently saved ClearPass connector instead contains OAuth client credentials and no static token, and its live TLS handshake disconnects before `/api/oauth` completes. This is a connector/environment condition, not a missing token-mode implementation; do not switch authentication modes or overwrite credentials automatically.

- [x] **Step 1: Verify the selected ClearPass credential mode is already implemented**

  `Systems.test.tsx` already asserts that a saved ClearPass static-token configuration sends `{ kind: 'token', token: '<masked replacement>' }` and does not retain stale OAuth credentials.

- [x] **Step 2: Verify the current ClearPass connection condition**

  `GET /api/systems/state` reports ClearPass as linked but degraded with `lastSync: null`; `GET /api/clearpass` and its endpoint page are honest empty live responses. The current saved config has OAuth credentials and no static token.

- [ ] **Step 3: Restore the external ClearPass connection when a valid auth mode is selected in Connected systems**

  Select the existing static-token mode only if its saved token is current, or repair the CPPM OAuth/TLS path. Retest the connector and then refresh `/api/clearpass`; do not modify another product’s credentials or lab-write admission.

- [ ] **Step 4: Verify ClearPass route states after the external connection recovers**

  Run the focused web/server test files and call `GET /api/clearpass`, `GET /api/clearpass/endpoints`, and `GET /api/systems/state`. The screen must show live rows when CPPM connects and an explicit plane degradation when its TLS/auth handshake fails.

- [ ] **Step 5: Commit a code correction only if this retest exposes an application defect**

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

- [x] **Step 1: Check the existing topology interaction coverage against the live graph shape**

  Use a graph with four sites, sixteen managed nodes, one ghost, and cross-site edges. Assert the visible node labels remain reachable, a normal click opens the device route, a focused click keeps its one-hop edge visible, and the graph has a readable empty state when there are no nodes.

- [x] **Step 2: Run the topology test family**

  Run: `npm run test -w web -- src/screens/Topology.test.tsx src/screens/SiteTopologyDiagram.test.tsx`

  Result: PASS — 44 tests across estate topology, site topology, and the diagram. A browser-bound visual inspection remains required before changing layout/styling.

- [x] **Step 3: Do not change topology source until a visual regression is reproduced**

  The live graph has 16 managed nodes, 1 ghost, and 9 reported links; its focused interaction suite passes. No source change is justified without a visual reproduction. Browser-bound visual click proof remains pending.

- [x] **Step 4: Verify the topology family**

  Run: `npm run test -w web -- src/screens/Topology.test.tsx src/screens/SiteTopologyDiagram.test.tsx src/screens/SiteTopology.test.ts`

- [x] **Step 5: Record that no topology code correction was evidenced**

  Run: `git add web/src/screens/Topology.tsx web/src/screens/Topology.test.tsx web/src/screens/SiteTopologyDiagram.test.tsx && git commit -m "fix: restore topology interaction"`

### Task 5: Audit the operational-route families

**Files:**
- Inspect/modify as indicated by evidence: `web/src/screens/Overview.tsx`, `Alerts.tsx`, `Tickets.tsx`, `AuthEvents.tsx`, `Inventory.tsx`, `Sites.tsx`, `Devices.tsx`, `SiteDetail.tsx`, `DeviceDetail.tsx`, `Licenses.tsx`
- Test: the corresponding existing `*.test.tsx` files

**Interfaces:**
- Consumes: the screen-specific `GET /api/*` envelopes already defined in `web/src/api/screens.ts`.
- Produces: a completed populated/empty/error/drill-through checklist for each core operations page.

- [x] **Step 1: Run the core operations screen tests as one evidence batch**

  Run: `npm run test -w web -- src/screens/Overview.test.tsx src/screens/Alerts.test.tsx src/screens/Tickets.test.tsx src/screens/AuthEvents.test.tsx src/screens/Inventory.test.tsx src/screens/Sites.test.tsx src/screens/Devices.test.tsx src/screens/SiteDetail.test.tsx src/screens/DeviceDetail.test.tsx src/screens/Licenses.test.tsx`

- [x] **Step 2: Identify page failures before editing**

  The complete web suite passed after the Rogue AP test harness was given its required router. The live API baseline found no core-screen error envelope; ClearPass is isolated as an external connector failure.

- [x] **Step 3: Implement only the confirmed owning correction**

  The confirmed client-table omission was corrected and committed as `518248e`; no further core-screen implementation regression was evidenced.

- [x] **Step 4: Commit verified core-page corrections**

  Use one commit per tested screen family, named `fix: repair <screen family> page state`.

### Task 6: Audit the product, configuration, and connected-systems families

**Files:**
- Inspect/modify as indicated by evidence: `web/src/screens/Central.tsx`, `Mist.tsx`, `GreenLake.tsx`, `Uxi.tsx`, `Configure.tsx`, `Compliance.tsx`, `Systems.tsx`, and `web/src/screens/systems/*`
- Test: `Central.test.tsx`, `Mist.test.tsx`, `GreenLake.test.tsx`, `Configure.test.tsx`, `ConfigureBulk.test.tsx`, `Compliance.test.tsx`, `Systems.test.tsx`, and existing systems subcomponent tests

**Interfaces:**
- Consumes: each product’s read envelope and existing direct-write APIs.
- Produces: a complete product-page checklist showing editable lab controls, visible read data, and truthful degraded states per plane.

- [x] **Step 1: Run the product/configuration test evidence batch**

  Run: `npm run test -w web -- src/screens/Central.test.tsx src/screens/Mist.test.tsx src/screens/GreenLake.test.tsx src/screens/Configure.test.tsx src/screens/ConfigureBulk.test.tsx src/screens/Compliance.test.tsx src/screens/Systems.test.tsx src/screens/systems/IdentityProviderSection.test.tsx src/screens/systems/MistSection.test.tsx src/screens/systems/NotificationsSection.test.tsx src/screens/systems/PlaneRow.test.ts`

- [x] **Step 2: Verify each product’s GET response and declared write capability**

  Safe redacted probes returned 200 for Central, Mist, UXI, Configure, Compliance, Systems, GreenLake, and Inventory. UXI is an honest empty live collection; it is not an API failure.

- [x] **Step 3: Correct confirmed product-page regressions test-first**

  No product/configuration screen implementation regression was evidenced. Existing Systems coverage verifies direct lab behavior and ClearPass static-token form selection; the active ClearPass TLS/OAuth outage is external.

- [x] **Step 4: Commit independently verified product/configuration corrections**

  Use one commit per coherent product screen family.

### Task 7: Final full-route verification and handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-08-03-full-portal-page-audit.md`

**Interfaces:**
- Consumes: all completed task results.
- Produces: a local running build with route evidence, known external connector conditions, and a clean worktree.

- [x] **Step 1: Run the full production verification**

  Typecheck and build passed for all workspaces. The full web suite passed 72 files / 1,374 tests; the full server suite passed 87 files / 2,624 tests.

- [x] **Step 2: Repeat the safe route matrix against the running local server**

  The running local server serves the rebuilt `index-B2ma74XW.js` bundle. Every routed-screen API path returned a readable 200 response; ClearPass remained the only external degraded plane and UXI remained an honest empty collection.

- [ ] **Step 3: Check source and commit state**

  Run: `git diff --check && git status --short && git log --oneline -10`

- [ ] **Step 4: Report the completed pages, remaining externally unreachable planes, and the exact local reload step**

  State only verified results. Leave the latest local server running for the user unless they ask to stop it.
