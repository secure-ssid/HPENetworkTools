# HPE Network Tools — UI & API Improvements Report

**Date:** 2026-08-03  
**Scope:** `/Users/stephenchoate/Documents/HPENetworkTools`  
**Stack:** React 18 + Vite (web), Express + TypeScript (server), shared contracts (`shared/`), NightDesk design system  

---

## 1. Executive summary

HPE Network Tools is already a mature multi-plane ops portal: 20 routed screens, ~12 management planes, careful data-provenance rules (live vs demo vs failed), reviewed writes, OIDC, webhooks, assistant/MCP, and a strong test culture.

The highest-value next work is **not greenfield features**. It is:

1. **Finish open plans** that unlock clearer connectors, visual drill-downs, and unified clients.
2. **Break up oversized screens/routes** so UI and API stay maintainable.
3. **Scale the read path** (pagination, caching, incremental refresh) for large estates.
4. **Polish operator UX** on density, empty/error states, search, and accessibility.

Below is a prioritized backlog with concrete file anchors and expected impact.

### Already shipped in this pass (2026-08-03)

| Item | Status | Anchors |
|---|---|---|
| Visual reference contracts + URL/MIME safety | Done | `shared/visualReferences.ts` |
| Visual references API (list/create/delete/upload/stream) | Done | `server/src/services/visualReferences.ts`, `server/src/routes/visualReferences.ts` |
| VisualReferencePanel on site/device/client detail | Done | `web/src/components/VisualReferencePanel.tsx` |
| ConfigActionPanel (capability-gated, review before handoff) | Done | `web/src/components/ConfigActionPanel.tsx` + `CONFIG_ACTION_CAPABILITIES` |
| ClearPass degraded/unlinked banner → Systems | Done | `web/src/screens/ClearPass.tsx` |
| Licences hide idle zero-assignment by default | Done | `web/src/screens/Licenses.tsx` |
| API `Cache-Control` + error `code` on JSON errors | Done | `server/src/index.ts` |
| Docs + smoke coverage | Done | `docs/user-guide.md`, `docs/security.md`, `scripts/smoke.sh`, README link |
| Focused tests + monorepo typecheck | Green | shared/server/web visual + screen tests |

### Swarm batch 2 (2026-08-03) — taxonomy + recommendations

| Item | Status | Anchors |
|---|---|---|
| Device/client taxonomy classifiers + buckets | Done | `shared/taxonomy.ts` |
| Config recommendations (read-only rules) | Done | `shared/configRecommendations.ts` |
| `GET /api/recommendations` + `/api/taxonomy/summary` | Done | `server/src/routes/recommendations.ts` |
| DeviceTypeBadge / ClientCategoryBadges | Done | `web/src/components/*` |
| ConfigRecommendationsPanel on Overview, Device, Site, Client, Licences | Done | screens + panel |
| Category filter chips on Devices + Clients | Done | list screens |
| Visual target kinds: estate, endpoint, service, license | Done | `shared/visualReferences.ts` |

### Batch 3 + UI redesign (2026-08-03)

| Item | Status | Anchors |
|---|---|---|
| Nightdesk visual redesign (tokens, shell glass, nav, cards, stats, buttons, headers) | Done | `web/src/nightdesk/tokens.css`, `components.css`, `app.css`, `ScreenHeader.tsx` |
| DataTable window virtualization (>80 rows) | Done | `web/src/nightdesk/DataTable.tsx` |
| Weak ETag + helpers on devices/recommendations | Done | `server/src/lib/httpCache.ts` |
| Topology model extract from screens.ts | Done | `server/src/routes/screens/topologyModel.ts` |
| OpenAPI route catalog stub | Done | `GET /api/openapi.json` |
| Notification center SSE stream + bell client | Done | `.../center/stream`, `AppShell` NotificationBell |
| Topology + Configure visual/recs depth | Done | Topology/Configure screens |
| ClearPass TLS repair deep-link + copy | Done | `ClearPass.tsx` → `/systems?plane=clearpass` |

### Loop 4 (2026-08-03) — keep searching and adding

| Item | Status | Anchors |
|---|---|---|
| Shared client CSV helper | Done | `web/src/lib/csv.ts` |
| Visual refs + config recs on Sites/Mist/Central/UXI/Inventory/Systems/Compliance/GreenLake/Tickets/AuthEvents/Alerts | Done | respective screens |
| Export CSV on Sites, Devices, AuthEvents, Alerts, Compliance findings, GreenLake sections | Done | screen headers |
| Tickets copy deep-link | Done | `Tickets.tsx` |
| Optional `?limit=&cursor=` page envelope on devices/clients/sites/alerts groups | Done | `applyListPaging` in `screens.ts` |
| ETag/304 on devices, clients, sites, alerts | Done | `sendCachedJson` |
| `GET /api/devices/bulk?serials=` | Done | `screens.ts` |
| `GET /api/configure/history/export` + Configure drawer download | Done | `configure.ts`, `Configure.tsx` |
| OpenAPI catalog expanded | Done | `openapi.ts` |

### Loop 5 (2026-08-03) — research / debug / load-more

| Item | Status | Anchors |
|---|---|---|
| Live notification delivery attempt log (no bodies) | Done | `notifier.deliveries()`, `GET /api/notifications/deliveries`, Notifications UI |
| Runtime debug API + Systems panel | Done | `GET /api/debug/runtime`, `RuntimeDebugSection.tsx` |
| Client light/dark theme toggle | Done | `tokens.css` `data-nd-theme`, AppShell localStorage |
| List filters `?q=` / `?plane=` on devices/clients/sites | Done | `applyListFilters` in `screens.ts` |
| Devices/Clients Load more (page size 250) | Done | `ScreenListQuery`, Devices/Clients screens |
| Systems state ETag/304 | Done | `systems.ts` + `httpCache` |
| Health `?deep=1` process/notifier facts when allowed | Done | `index.ts` `/api/health` |
| Server devices CSV export | Done | `GET /api/devices/export` |
| OpenAPI + tests for deliveries/debug | Done | `openapi.ts`, `notifications.test.ts`, `debugRuntime.test.ts` |

### Loop 6 (2026-08-03) — alerts load-more + plane health

| Item | Status | Anchors |
|---|---|---|
| Alerts Load more (groups page size 100) | Done | `Alerts.tsx`, `getAlerts(ScreenListQuery)` |
| `GET /api/systems/:plane/health` | Done | `systems.ts` — calls/events, noteChars only |
| Runtime debug plane card drill-down | Done | `RuntimeDebugSection.tsx` |

### Loop 7 (2026-08-03) — SSE reconnect, sites paging, exports, light polish

| Item | Status | Anchors |
|---|---|---|
| NotificationBell SSE exponential reconnect + poll bridge | Done | `AppShell.tsx` |
| Sites Load more (page size 100) + `getSites(ScreenListQuery)` | Done | `Sites.tsx`, `screens.ts` API |
| `GET /api/clients/export` (before `:mac`) + OpenAPI | Done | `screens.ts`, `openapi.ts` |
| UXI client filters + CSV export | Done | `Uxi.tsx` |
| Delivery log CSV (outcomes only) | Done | `NotificationsSection.tsx` |
| Inventory copy node id/path | Done | `Inventory.tsx` |
| Topology nodes/edges CSV export | Done | `Topology.tsx` |
| Tickets queue CSV export | Done | `Tickets.tsx` |
| ClearPass endpoints page CSV export | Done | `ClearPass.tsx` |
| Light theme shell polish (root/sidebar/topbar/nav) | Done | `components.css` |
| Devices board duplicate `className` fix | Done | `Devices.tsx` |

### Loop 8 (2026-08-03) — health deep UI, plane exports, sites export

| Item | Status | Anchors |
|---|---|---|
| Runtime debug “Health deep” (`GET /api/health?deep=1`) | Done | `RuntimeDebugSection.tsx` — withheld when OIDC stranger |
| Mist rogues + AP health CSV | Done | `Mist.tsx` |
| Central sites/WLANs/firmware/alerts CSV | Done | `Central.tsx` |
| `GET /api/sites/export` + OpenAPI | Done | `screens.ts` before `:siteId` |
| Auth-events optional `?q=` filter (list only) | Done | `screens.ts` `applyListFilters` on events |
| Systems tests: stub fetch + catalog timeout | Done | `Systems.test.tsx` |

### Loop 9 (2026-08-03) — listQuery extract + Overview export

| Item | Status | Anchors |
|---|---|---|
| Extract `applyListPaging` / `applyListFilters` / `sendCachedJson` | Done | `server/src/routes/screens/listQuery.ts` |
| Overview alerts/sites/planes CSV export | Done | `Overview.tsx` |

### Loop 10 (2026-08-04) — recommendations CSV + listQuery tests

| Item | Status | Anchors |
|---|---|---|
| ConfigRecommendationsPanel Export CSV (real fields) | Done | `ConfigRecommendationsPanel.tsx` + ToastProvider tests |
| `listQuery` unit tests | Done | `server/tests/listQuery.test.ts` |
| OpenAPI `GET /api/health?deep=1` | Done | `openapi.ts` |

### Loop 11 (2026-08-04) — auth-events paging, inventory/debug/recs export

| Item | Status | Anchors |
|---|---|---|
| Auth-events optional `?limit=&cursor=` paging + Load more (250) | Done | `screens.ts`, `getAuthEvents(ScreenListQuery)`, `AuthEvents.tsx` |
| Inventory search results CSV | Done | `Inventory.tsx` |
| Runtime debug planes CSV | Done | `RuntimeDebugSection.tsx` |
| `GET /api/recommendations/export` + OpenAPI | Done | `recommendations.ts`, `openapi.ts` |
| OpenAPI `/api/auth-events` | Done | `openapi.ts` |

### Loop 12 (2026-08-04) — more server exports + detail CSVs

| Item | Status | Anchors |
|---|---|---|
| `GET /api/auth-events/export` | Done | `screens.ts` (shared `authEventsBody`) |
| `GET /api/tickets/export` | Done | `screens.ts` (no note bodies) |
| `GET /api/uxi/export` | Done | `screens.ts` |
| `server/src/lib/csv.ts` helper | Done | shared escape/send helpers |
| SiteDetail Export devices | Done | live + demo headers |
| DeviceDetail Export ports | Done | ports table |
| Configure Export queue CSV | Done | broker queue snapshot |
| OpenAPI auth-events/tickets/uxi export | Done | `openapi.ts` |

### Loop 13 (2026-08-04) — alerts/compliance export + auth share link

| Item | Status | Anchors |
|---|---|---|
| `GET /api/alerts/export` (before `:fingerprint`) | Done | `screens.ts` `alertsBody` |
| `GET /api/compliance/export` | Done | `screens.ts` `complianceBody` |
| AuthEvents Copy view link (q/plane/range) | Done | `AuthEvents.tsx` |
| OpenAPI alerts/compliance export | Done | `openapi.ts` |

### Loop 14 (2026-08-04) — licenses export + share links + Sites polish

| Item | Status | Anchors |
|---|---|---|
| `GET /api/licenses/export` | Done | `screens.ts` `licensesBody` + `sendCsv` |
| Devices / Clients Copy view link | Done | current URL clipboard |
| Sites Load more (100) + Export CSV + Copy filter link + `?q=`/`?plane=` deep-link | Done | `Sites.tsx` |
| Sites VisualReference + ConfigRecommendations panels | Done | service target `sites` |
| OpenAPI licenses export | Done | `openapi.ts` |

### Loop 15 (2026-08-04) — recovery, more CSVs, debug export

| Item | Status | Anchors |
|---|---|---|
| Restored wiped `screens.ts` body builders + list paging + all `/export` routes | Done | `alertsBody` / `authEventsBody` / `sitesBody` / `devicesBody` / … + `sendCsv` |
| Client CSV: Compliance findings, UXI sensors, Inventory search results | Done | `Compliance.tsx`, `Uxi.tsx`, `Inventory.tsx` |
| `sendCsv` on recommendations + configure history exports | Done | `recommendations.ts`, `configure.ts` |
| `GET /api/debug/runtime/export` plane health CSV | Done | `debug.ts` (no secrets/notes) |
| OpenAPI debug runtime export | Done | `openapi.ts` |

### Loop 16 (2026-08-04) — devices bulk + debug CSV tests

| Item | Status | Anchors |
|---|---|---|
| Restored `GET /api/devices/bulk?serials=` (max 50, optional planes) | Done | `screens.ts` before `:name` |
| Debug runtime CSV test | Done | `debugRuntime.test.ts` |
| Devices bulk HTTP tests | Done | `devicesBulk.test.ts` |

**Still open (next loops):** more `screens.ts` domain splits, full connector-integrity plan checkboxes, deeper connector form audit.

---

## 2. Current architecture (baseline)

| Layer | What exists today | Notes |
|---|---|---|
| **UI shell** | `web/src/app/*`, `web/src/nightdesk/*` | Lazy routes, error boundary, auth gate, mobile drawer, NightDesk tokens |
| **Screens** | 20 routes in `web/src/app/routes.tsx` | Operate / Inventory / Govern grouping |
| **API client** | `web/src/api/*` (barrel `client.ts`) | Honest unreachable→demo fallback; answered failures never become fixtures |
| **Server** | Express routers under `server/src/routes/*` | Health, screens, inventory, configure, diagnostics, webhooks, auth, chat, etc. |
| **Planes** | `server/src/planes/*` + poller | Central, Classic, Mist, ClearPass, UXI, AOS-8/CX, EdgeConnect, OpsRamp, SSE, GreenLake, Local |
| **Shared** | `shared/*` | Types, fixtures, topology, alerts, connectors catalog work |
| **Design archive** | `design/*.dc.html`, `docs/design-reference.md` | Spec source of truth for fidelity |

**Largest hotspots (LOC):**

| File | ~LOC | Risk |
|---|---:|---|
| `server/src/routes/screens.ts` | 3,387 | God-route; hard to evolve contracts |
| `web/src/screens/Configure.tsx` | 2,574 | Dense config UX + writes |
| `web/src/screens/ClearPass.tsx` | 2,278 | Table + drawer + writes |
| `web/src/screens/Clients.tsx` | 2,265 | Unified clients surface |
| `web/src/screens/Alerts.tsx` | 2,215 | Rules, silences, maintenance, bell |
| `web/src/screens/Systems.tsx` | 1,565 | Connector forms |
| `web/src/screens/DeviceDetail.tsx` | 1,234 | Trends, ports, actions, terminal |

---

## 3. Open plans already in-repo (do these first)

These live under `docs/superpowers/plans/` and are the most grounded roadmap.

| Plan | Open items | UI impact | API impact | Priority |
|---|---:|---|---|---|
| **Full portal page audit** (`2026-08-03-full-portal-page-audit.md`) | 5 | ClearPass truthfulness; final audit report | ClearPass auth/TLS recovery verification | **P0** |
| **Lab direct-write configure** (`2026-08-03-lab-direct-write-configure.md`) | mostly done (5 open constraints) | Lab vs hardened config mode clarity | Keep writers honest / no false writability | **P0** |
| **Connector integrity + unified clients** (`2026-08-02-connector-integrity-and-unified-clients.md`) | 45 | Catalog-driven Systems forms; source badges on Clients; licence cleanup | Typed connectors, probe-before-save, client grouping by MAC | **P0** |
| **Visual drill-downs + config actions** (`2026-08-02-visual-drilldowns-and-config-actions.md`) | 24 | Floorplans/images/docs on site/device/client; capability-gated action panel | `/api/visual-references`, safe asset upload/stream | **P1** |
| **MSP assistant provider registry / persistent Codex** | many | Assistant reliability UX | Provider probe contract, persistent CLI session | **P1** |

**Immediate ops gap (from page audit):** ClearPass is linked but degraded (OAuth/TLS handshake). UI already shows honest empty live data; remaining work is connector recovery, not fake rows.

---

## 4. UI improvements

### 4.1 P0 — Operator clarity & consistency

| Improvement | Why | Where | Effort |
|---|---|---|---|
| **Catalog-driven connector forms** | One form shape per product auth type; no stub-save paths; TLS-relaxed warning always visible | `Systems.tsx`, `shared/connectors.ts`, systems sections | M |
| **Unified Clients source badges + filters** | Same client seen on Central + Mist + ClearPass should show provenance, not silent overwrite | `Clients.tsx`, screen envelope | M |
| **ClearPass degraded banner with repair path** | “Empty” must not look like “no endpoints”; deep-link to Systems with mode/status | `ClearPass.tsx`, `Systems.tsx` | S |
| **Per-screen loading skeletons (shared)** | Many screens still ad-hoc loading text; NightDesk should own skeleton/empty/error primitives | `nightdesk/feedback.tsx`, `ApiErrorState.tsx` | S–M |
| **Standard empty / failed / unread triad** | API already preserves three states; UI should use one vocabulary everywhere (“not fetched” ≠ “none” ≠ “failed”) | All list/detail screens | M |
| **Licence operational filter** | Hide unused/expired noise by default; keep reclaim path for orphans | `Licenses.tsx` | S |

### 4.2 P1 — Interaction & navigation

| Improvement | Why | Where | Effort |
|---|---|---|---|
| **Visual reference panel** | Operators need floorplans/port maps/docs beside live topology | New `VisualReferencePanel`, Site/Device/Client detail | L |
| **Config action panel on detail screens** | Jump from device/SSID/client into preview → review → push without hunting Configure | `ConfigActionPanel`, Device/Site/Clients | M |
| **Global command palette polish** | Search exists; upgrade to ⌘K actions (go to screen, open ticket, silence alert, run diagnostic) | App shell topbar / search | M |
| **Table virtualization** | Devices/Clients/Alerts/ClearPass can grow large; no `react-window` today | `nightdesk/DataTable.tsx` / `Table.tsx` | M |
| **Saved views + column manager everywhere** | Facets/saved views exist as components; not every big table uses them | Wire into Devices, Alerts, AuthEvents, ClearPass, Licenses | M |
| **Topology visual QA + layout presets** | Interaction tests pass; browser visual proof still pending; add density/layout toggles | `Topology.tsx`, `SiteTopology*` | M |
| **Overview actionable “what changed” strip** | Sparklines exist; add last-hour delta chips (new downs, new alerts, expiring licences) | `Overview.tsx` + metrics API | M |
| **Assistant panel status UX** | Provider readiness is nuanced; surface install/auth/model/MCP probe codes as a checklist | `ChatPanel.tsx`, Systems → Assistant | M |

### 4.3 P2 — Design system, a11y, polish

| Improvement | Why | Where | Effort |
|---|---|---|---|
| **Extract mega-screens into feature folders** | Configure/Clients/Alerts/ClearPass/Systems are hard to review and slow to change | `web/src/screens/<feature>/*` (partially started) | L |
| **Focus/keyboard audit on drawers & dialogs** | Mobile drawer is focus-managed; write dialogs/review modals need the same pass | NightDesk `Drawer`, Configure/ClearPass write flows | M |
| **ARIA live regions for poll/sync** | Stale/degraded plane status should announce without stealing focus | Shell + plane status | S |
| **Responsive density modes** | Design ref defines density tokens; expose Comfortable/Compact | tokens + shell | S |
| **Dark/light if not fully tokenized end-to-end** | Tokens exist (`--nd-*`); audit leftover inline hex/rgba | CSS + screens | M |
| **Screenshot-driven visual regression** | Playwright MCP artifacts exist under `.playwright-mcp`; formalize critical-path shots | CI / scripts | M |
| **DsGallery → living style guide** | `/ds` exists; expand with real component states used in production | `DsGallery.tsx` | S |

### 4.4 UI anti-patterns to avoid while improving

- Do **not** fall back to demo fixtures on answered HTTP errors (already enforced in `web/src/api/core.ts` — keep it).
- Do **not** invent empty arrays for unread detail sections (`dropUnreadableBlocks` contract).
- Do **not** show credentials, raw vendor bodies, or one-time HMAC keys in UI/logs.
- Do **not** offer write actions for planes without a real writer.

---

## 5. API improvements

### 5.1 P0 — Contract integrity & connectors

| Improvement | Why | Where | Effort |
|---|---|---|---|
| **Typed connector config end-to-end** | Discriminated auth per product; migrate legacy `planes` → `connectors` once | `shared/connectors.ts`, `settings.ts`, `connectors/catalog.ts` | L |
| **Authenticated probe-before-save** | Reachability ≠ connected; each adapter owns `validateConnection()` | `server/src/planes/*`, `routes/systems.ts` | L |
| **Refuse enabled stub adapters** | Prevent “linked” systems that never sync | catalog factory + systems route | S |
| **Client observation grouping API** | Return grouped sources + `missingSources` instead of destructive dedupe | `routes/screens` live client path | M |
| **ClearPass connection diagnostics endpoint** | Structured auth/TLS failure codes for UI repair copy | ClearPass adapter + systems state | S |
| **Split `screens.ts` god-route** | 3.3k-line router blocks safe evolution | `server/src/routes/screens/*` (partial split exists) | L |

### 5.2 P1 — Scale, freshness, and developer ergonomics

| Improvement | Why | Where | Effort |
|---|---|---|---|
| **Cursor pagination on large list screens** | Inventory already has honest cursor paging (`limit` default 25 / max 50). Devices/Clients/Alerts/AuthEvents still tend to ship full envelopes | screen routes + web client | L |
| **Conditional requests / ETag on screen envelopes** | Polling full overview/devices JSON is wasteful; support `If-None-Match` → 304 | screens router + poller cache keys | M |
| **Incremental/delta sync metadata** | Expose `syncedAt`, `stale`, `generation` consistently on every envelope (partial today) | screen envelopes + registry | M |
| **Server-Sent Events for alert/bell updates** | Bell/unread today is pull-oriented; push unread count + new alert ids | new `/api/events` or alerts channel | M |
| **OpenAPI (or Zod-first contract export) for portal API** | Vendor OpenAPI is referenced in adapters; **portal** has no published schema | generate from Zod or tRPC-like contracts | L |
| **Consistent Zod validation on all write routes** | Zod is a dependency; validation density is uneven across routers | all mutating routes | M |
| **Standard error envelope** | `{ error, code, details?, retryAfter? }` everywhere (partial patterns exist for SSE/writes) | `handler.ts` + error middleware | M |
| **Rate-limit & concurrency budgets per plane** | Write broker already tracks vendor rate-limit reset; extend read poller budgets into settings UI | poller + connector polling config | M |
| **Visual references API** | Safe upload/list/stream with MIME allowlist, 10 MiB cap, owner-only paths | planned `visualReferences` service/routes | M |
| **Idempotency keys on writes** | Review/push retries should not double-apply | writeBroker / configure / SSE commit | M |

### 5.3 P2 — Platform hardening

| Improvement | Why | Where | Effort |
|---|---|---|---|
| **Request metrics beyond access log** | Log line is METHOD path status ms; add histogram/counters per route + plane | middleware + `/api/metrics` expansion | M |
| **Compression + security headers** | No broad `compression`/`helmet` usage spotted | `server/src/index.ts` | S |
| **API versioning prefix** | `/api/v1/...` before external consumers appear | router mount | S (now) / L (later) |
| **Background job status API generalization** | Diagnostics jobs pattern is good; reuse for long reports, bulk configure, backup diffs | jobs service | M |
| **Bulk read endpoints** | “N devices by serial” for topology/detail hydration without N+1 | devices/inventory routes | M |
| **Webhook delivery outbox inspection API** | Demo outbox exists; first-class operator view of outbound alert notifications | notifications routes + UI | S |
| **Health deep-check mode** | Public health is carefully redacted; add authenticated `?deep=1` probe summary | `/api/health` | S |

### 5.4 API design principles already worth preserving

Keep these as non-negotiable while extending:

1. **Three-state detail sections** (never asked / empty / failed).  
2. **Same-origin write protection** even when auth is off.  
3. **Health `ok` vs `status: degraded` split** (don’t restart-loop on vendor 429).  
4. **Masked secrets + write-only credential fields**.  
5. **Plane+serial identity** for device actions (never name-only targeting).  
6. **Inventory cursor past-end is distinct from last page**.

---

## 6. Cross-cutting performance recommendations

| Area | Observation | Recommendation |
|---|---|---|
| **Screen payloads** | Many screens are full-estate view models | Split summary vs detail; lazy secondary panels |
| **Poller** | Central multi-plane pull | Per-connector dataset toggles + cadence (in connector design) |
| **Frontend data layer** | Hand-rolled `fetch` helpers, no React Query/SWR | Either keep thin layer **or** adopt a cache with stale-while-revalidate; don’t mix both |
| **Tables** | Full DOM rows | Virtualize at ~200+ rows |
| **Topology** | 2D + optional 3D canvas | Keep 3D opt-in; progressive graph load by site |
| **Build** | Workspace web build watched by server | Code-split already via `lazy()`; audit chunk sizes for Configure/Systems |

---

## 7. Suggested delivery sequence (90-day view)

### Sprint A (1–2 weeks) — Truth & connectors
1. Finish portal page-audit remaining ClearPass verification.  
2. Land typed connectors + probe-before-save (shared + server).  
3. Systems UI catalog forms + degraded repair copy.  
4. Clients source grouping + badges.

### Sprint B (2–3 weeks) — Detail UX
1. Visual references API + panel on Site/Device/Client.  
2. Config action handoff panel (capability-gated).  
3. Shared skeleton/empty/error primitives; wire top 6 screens.  
4. Licence operational default filter.

### Sprint C (2–3 weeks) — Scale
1. Paginate Devices/Clients/Alerts list APIs.  
2. ETag/304 on overview + devices envelopes.  
3. Table virtualization.  
4. Split `screens.ts` into domain modules with contract tests.

### Sprint D (ongoing) — Platform
1. Portal OpenAPI/Zod export.  
2. Standard error codes.  
3. SSE/event channel for notification bell.  
4. Assistant provider readiness checklist UX.  
5. Visual regression smoke set.

---

## 8. Quick wins (< 1 day each)

1. **ClearPass banner** when plane health ≠ healthy.  
2. **Licences:** hide expired/unused by default with toggle.  
3. **Overview:** click-through already exists — add “last sync age” chip per plane using `/api/health`.  
4. **API:** `Cache-Control: private, no-cache` explicit on authenticated JSON (avoid intermediary surprises).  
5. **API:** centralize Zod parse helper for query ints (`limit`/`cursor` pattern from inventory).  
6. **UI:** ensure every destructive button has `aria-describedby` pointing at review summary.  
7. **Docs:** publish this report link from `README.md` Documentation table.  
8. **DsGallery:** document the three-state empty language with live examples.

---

## 9. Out of scope / explicitly deferred

| Idea | Why defer |
|---|---|
| AOS-10 direct SSH adapter | Research decision: stay Central-mediated |
| Multi-tenant connector instances per product | Spec allows later; would change identity model |
| Replacing NightDesk with a third-party DS | Fidelity is a product feature |
| Blind “add GraphQL” rewrite | REST + typed envelopes are fine; version and paginate first |

---

## 10. Success metrics

| Metric | Target |
|---|---|
| Connector save with failed probe | **0** enabled saves |
| Screen shows demo data after live HTTP error | **0** |
| p95 `GET /api/devices` (cold, 5k devices) | **< 500 ms** after pagination |
| Largest React screen file | **< 800 LOC** after splits |
| Open P0 plan checkboxes | **0** |
| Keyboard-only path: search → device → diagnostic | Fully operable |
| ClearPass degraded explanation | Visible + links to Systems |

---

## 11. File map for implementers

```
web/src/app/routes.tsx          # route matrix
web/src/api/core.ts             # fetch honesty rules
web/src/nightdesk/*             # DS primitives
web/src/screens/*               # page implementations
server/src/index.ts             # middleware + mounts
server/src/routes/screens.ts    # split candidate
server/src/routes/inventory.ts  # pagination reference implementation
server/src/planes/*             # vendor adapters + probes
server/src/services/poller.ts   # freshness
server/src/services/writeBroker.ts
shared/connectors.ts            # typed connector contracts (plan)
docs/superpowers/plans/*        # executable task lists
docs/design-reference.md        # UI fidelity law
```

---

## 12. Bottom line

The portal’s differentiator is **honest multi-plane operations** — provenance, degraded states, and reviewed writes. The best UI/API improvements double down on that:

- **Make every connector independently true** (typed config + real probes).  
- **Make every dense screen scannable and progressive** (pagination, virtualization, visual context).  
- **Make contracts explicit and small** (split god-files, standard errors, optional OpenAPI).  

Start with the open **connector integrity** and **page-audit ClearPass** work; then ship **visual drill-downs** and **list-scale APIs**. That sequence maximizes operator value without risking the honesty guarantees already built into `web/src/api/core.ts` and the server health model.
