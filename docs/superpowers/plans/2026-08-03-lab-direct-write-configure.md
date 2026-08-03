# Lab Direct Write Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make implemented product configuration surfaces apply immediately in the lab, with no ticket, review, queue, lease, or dry-run requirement, while keeping real validation, capability checks, concurrency controls, audit records, and outcome evidence.

**Architecture:** A single persisted lab policy (`configMode`) controls server-side admission. The generic Central broker gains an immediate-apply path; direct product services conditionally skip review confirmation. The UI reads the same setting and presents a compact Apply action rather than approval workflow controls.

**Tech Stack:** TypeScript, Express, React, Vitest, existing product adapters and settings store.

## Global Constraints

- [ ] Lab is default-on; `configMode: false` preserves the existing hardened workflow.
- [ ] Never claim a plane is writable when no real writer exists.
- [ ] Preserve input validation, vendor scope checks, allowlists, concurrency/generation guards, post-write refresh, and audit trails.
- [ ] Do not log credentials, one-time secrets, or payload secrets.
- [ ] Keep incident-driven ticket automation separate from configuration writes.

---

## Task 1: Add a single lab-write policy and immediate Central broker apply

**Files:**
- Modify: `server/src/config/settings.ts`
- Create: `server/src/services/labWritePolicy.ts`
- Modify: `server/src/services/writeBroker.ts`
- Modify: `server/src/routes/configure.ts`
- Modify: `server/tests/settings.test.ts`
- Modify: `server/tests/writeBroker.test.ts`

- [x] Write failing tests proving lab defaults to direct writes, `POST /configure/apply` makes one supported Central write without ticket/queue/lease, and explicit hardened mode retains the existing gate.
- [x] Implement the policy helper and explicit immediate broker method, reusing existing validation, target selection, transport, refresh, and audit logic.
- [x] Add the route with typed input/output and no client-supplied audit bypass.
- [x] Run focused server tests and typecheck.
- [x] Commit the tested slice.

## Task 2: Remove lab-only review gates from real direct writers

**Files:**
- Modify: `server/src/services/ssidDirectWrite.ts`
- Modify: `server/src/routes/configure.ts`
- Modify: `server/src/services/clearpassDirectWrite.ts`
- Modify: `server/src/routes/clearpassDirectWrite.ts`
- Modify: `server/src/services/sseObjects.ts`
- Modify: `server/src/routes/sse.ts`
- Modify: `server/src/services/greenlakeObjects.ts`
- Modify: `server/src/routes/greenlake.ts`
- Modify: related server tests

- [x] Add failing tests: absent review confirmation works in lab and fails when hardened mode is explicitly enabled.
- [x] Make only review confirmation conditional on the shared policy.
- [x] Keep SSE commit journals/fingerprints and ambiguous-outcome recovery protections intact.
- [x] Keep ClearPass secret hygiene and vendor write-scope enforcement intact.
- [x] Run affected server tests and typecheck.
- [x] Commit the tested slice.

## Task 3: Remove webhook approval friction without weakening write correctness

**Files:**
- Modify: `server/src/routes/hooks.ts`
- Modify: `server/src/services/centralWebhooks.ts`
- Modify: `server/src/routes/centralWebhooks.ts`
- Modify: related webhook tests

- [x] Add failing tests for lab admission without confirmation and hardened rejection without it.
- [x] Conditionalize only review confirmation.
- [x] Retain tenant binding, URL/topic/secret validation, one-time-secret handoff, generation preconditions, locks, and durable recovery journal.
- [x] Run focused tests and typecheck.
- [x] Commit the tested slice.

## Task 4: Replace Configure approval workflow with immediate lab apply

**Files:**
- Modify: `web/src/api/configure.ts`
- Modify: `web/src/screens/Configure.tsx`
- Modify: `web/src/screens/Configure.test.tsx`
- Modify: `web/src/screens/ConfigureBulk.test.tsx`

- [x] Add a direct apply API client.
- [x] In lab, hide ticket, dry-run, queue, lease, and review controls and show compact Apply actions for supported Central and SSID writes.
- [x] Preserve previews, form validation, outcome evidence, and a hardened-mode fallback.
- [x] Run focused web tests, typecheck, and production build.
- [x] Commit the tested slice.

## Task 5: Align product direct-write panels with lab policy

**Files:**
- Create: `web/src/hooks/useLabConfigMode.ts`
- Modify: `web/src/api/clearpass.ts`, `web/src/api/sse.ts`, `web/src/api/greenlake.ts`, `web/src/api/webhooks.ts`
- Modify: `web/src/screens/ClearPass.tsx`, `web/src/screens/SseInventoryPanel.tsx`, `web/src/screens/GreenLake.tsx`, `web/src/screens/CentralWebhooksPanel.tsx`, `web/src/screens/systems/MistSection.tsx`
- Modify: related API and panel tests

- [x] Add a reusable portal-setting hook that adopts confirmed lab mode and falls back to hardened UI while settings are unavailable/loading.
- [x] In lab remove review checkboxes/state/wording from existing direct-write product panels and omit `reviewConfirmed` from their requests.
- [x] Retain one-time HMAC acknowledgement, SSE manual-reconciliation attestation, validation, write-scope hiding, and outcome/partial/recovery evidence.
- [x] Keep a tested hardened-mode UI fallback that sends and requires review confirmation.
- [x] Run focused web tests, typecheck, and production build.
- [x] Commit the tested slice.

## Task 6: Make live inventory rows genuinely drillable

**Files:**
- Create: `web/src/screens/configure/deepLink.ts`
- Modify: `web/src/screens/Configure.tsx`
- Modify: `web/src/screens/central/WlanSection.tsx`, `web/src/screens/mist/wlans.tsx`, Mist view leaf components
- Modify: `web/src/screens/Topology.tsx`
- Modify: related Central, Mist, Configure, and Topology tests

- [x] Fix the focused topology chip border-style warning without globally changing alert semantics.
- [x] Define a validated Central/Mist WLAN deep-link contract that identifies an exact loaded row by plane, name, VLAN, and targets.
- [x] Make WLAN rows open Configure with that exact row preselected; malformed, missing, or ambiguous links must not reconstruct a writable object.
- [x] Make Mist AP-health rows open their device and rogue rows open the originating site using accessible controls.
- [x] Run focused web tests, typecheck, and production build.
- [x] Commit the tested slice.

## Task 7: Add truthful bounded ClearPass endpoint paging

**Files:**
- Modify: ClearPass adapter, plane interfaces, routes/read API, and server tests
- Modify: `web/src/api/clearpass.ts`, `web/src/screens/ClearPass.tsx`, and related web tests

- [x] Add a bounded, on-demand ClearPass endpoint page API with truthful total/next-page semantics and no secret leakage.
- [x] Page endpoint rows in the UI; reset page on filters and retain distinct unavailable, empty, and failed states.
- [x] Do not silently promise repository-wide filtering when only a page is loaded.
- [x] Run focused server/web tests, typechecks, and production build.
- [x] Commit the tested slice.

## Task 8: Finish compact inventory details and license cleanup

**Files:**
- Modify: `web/src/screens/ClearPass.tsx` and related tests
- Modify: `web/src/screens/Licenses.tsx` and related tests

- [x] Make ClearPass static inventory rows open compact read-only details rather than inert text.
- [x] Hide zero-assignment idle license capacity from the primary list while retaining unknown/assigned/currently useful records.
- [x] Run focused web tests, typecheck, and production build.
- [x] Commit the tested slice.

## Task 9: Automate tickets from real incidents only

**Files:**
- Create: `server/src/services/incidentAutomation.ts`
- Modify: ticket store, alert dispatch, webhook ingestion, relevant routes/tests

- [x] Persist incident fingerprints and an idempotent incident upsert/resolve path separate from configuration writes.
- [x] Automate only canonical device-down episodes and explicit client-health failure episodes; exclude session telemetry and configuration events.
- [x] Deduplicate across restarts and resolve/note only the matching automated incident on recovery.
- [x] Add focused tests proving no configuration write creates a ticket.
- [x] Run focused and full server tests, typecheck, and commit the tested slice.
