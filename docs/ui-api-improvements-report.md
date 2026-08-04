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
| ETag/304 on devices, clients, sites, alerts, overview | Done | `sendCachedJson` (+ Loop 68 overview + `etagPayload`) |
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

### Loop 18 (2026-08-04) — Sites restore + bulk lookup + tickets extract

| Item | Status | Anchors |
|---|---|---|
| Sites Load more (100) + Export CSV + Copy filter link + `?q=`/`?plane=` deep-link | Done | `Sites.tsx` restored on current CSS polish |
| Sites VisualReference + ConfigRecommendations panels | Done | service target `sites`, limit 8 |
| Alerts device-down rules Export CSV (no secrets) | Done | `Alerts.tsx` policy tab |
| Devices bulk serial lookup drawer → `getDevicesBulk` | Done | toast found/missing + navigate first match |
| ClearPass Copy filter link (`q`/`status`/`category`) + URL init | Done | `ClearPass.tsx` |
| Extract tickets routes to `screens/ticketsScreen.ts` | Done | `registerTicketsRoutes` |
| `GET /api/tickets/export` verification test | Done | `ticketsExport.test.ts` |

### Loop 19 (2026-08-04) — UXI filter, runtime live export, licenses extract

| Item | Status | Anchors |
|---|---|---|
| Overview Copy view link on header | Done | `Overview.tsx` + test |
| UXI local `?q=` filter (name/serial/site) + Export filtered + Copy filter link | Done | `Uxi.tsx`, `Uxi.test.tsx` |
| Runtime debug Export planes CSV also fetches `/api/debug/runtime/export` when live (blob download); honest toast on failure; no secrets | Done | `RuntimeDebugSection.tsx` |
| SiteTopology diagram Export CSV (nodes + edges) | Done | `SiteTopology.tsx` + diagram test |
| Extract licenses routes to `screens/licensesScreen.ts` | Done | `registerLicensesRoutes` |
| OpenAPI: tickets/licenses list paths; tickets/runtime exports remain listed | Done | `openapi.ts` |
| Focused tests + typecheck | Done | `licensesExport.test.ts`, Overview/Uxi/SiteTopology tests |

### Loop 20 (2026-08-04) — compliance extract + share links

| Item | Status | Anchors |
|---|---|---|
| Extract compliance routes to `screens/complianceScreen.ts` | Done | `registerComplianceRoutes` — body + GET `/compliance` + `/compliance/export` (no full diff in CSV) |
| GreenLake Export CSV + Copy view link; ConfigRecommendationsPanel retained | Done | `GreenLake.tsx` |
| AuthEvents Load more + Copy view link retained | Done | `AuthEvents.tsx` (no regression) |
| Systems Copy view link on header | Done | `Systems.tsx` |
| `GET /api/compliance/export` CSV test | Done | `complianceExport.test.ts` |
| OpenAPI `/api/compliance` + export | Done | `openapi.ts` |
| Focused tests + typecheck | Done | compliance export, GreenLake, Compliance |

### Loop 21 (2026-08-04) — alerts extract + share links

| Item | Status | Anchors |
|---|---|---|
| Extract alerts list/export to `screens/alertsScreen.ts` | Done | `registerAlertsRoutes` — `alertsBody` + GET `/alerts` + `/alerts/export` (export before `:fingerprint`) |
| Timeline stays on `screens.ts` | Done | `GET /alerts/:fingerprint/timeline` after static export path |
| Licences / Configure / Inventory / Mist / Central Copy view link | Done | respective `ScreenHeader` actions |
| `GET /api/alerts/export` CSV smoke | Done | `alertsExport.test.ts` |
| Focused tests + typecheck | Done | alerts export, Alerts, Licenses, Configure |

### Loop 22 (2026-08-04) — auth-events/uxi extract + server CSV download

| Item | Status | Anchors |
|---|---|---|
| Extract auth-events list/export to `screens/authEventsScreen.ts` | Done | `registerAuthEventsRoutes` — `authEventsBody` + filter/paging + export; `withOwningPlane` shared with ClearPass |
| Extract UXI list/export to `screens/uxiScreen.ts` | Done | `registerUxiRoutes` — `uxiSensorsBody` + GET `/uxi` + `/uxi/export` |
| `downloadApiCsv` helper | Done | `web/src/lib/downloadApiCsv.ts` — apiFetch/blob, no body logging |
| Tickets / Alerts optional **Download server CSV** when `dataSource === 'live'` | Done | fetches `/api/tickets/export` and `/api/alerts/export` |
| Devices Copy view link | Done | already present (verified) |
| OpenAPI `/api/uxi` list path | Done | `openapi.ts` |
| Focused tests + typecheck | Done | `authEventsExport.test.ts`, `uxiExport.test.ts`, `downloadApiCsv.test.ts` |

### Loop 23 (2026-08-04) — clients/sites extract + server CSV buttons

| Item | Status | Anchors |
|---|---|---|
| Extract clients CSV export to `screens/clientsScreen.ts` | Done | `registerClientsRoutes` — `CLIENT_LIST_FIELDS` + GET `/clients/export` before `:mac` (list+`:mac` moved in Loop 34) |
| Extract sites list/export to `screens/sitesScreen.ts` | Done | `registerSitesRoutes` — `sitesBody` + GET `/sites` + `/sites/export` before `:siteId`; detail stays on `screens.ts` |
| **Download server CSV** (live only) via `downloadApiCsv` | Done | Sites (`q`), Devices (`q`/`plane`), Clients (`q`/`plane`), Licenses, Compliance, Uxi — keep client-side Export CSV |
| `GET /api/clients/export` + `GET /api/sites/export` smoke | Done | `clientsExport.test.ts`, `sitesExport.test.ts` |
| Focused tests + typecheck | Done | clients/sites export + UI screens |

### Loop 24 (2026-08-04) — devices extract + AuthEvents server CSV

| Item | Status | Anchors |
|---|---|---|
| Extract devices list/export/bulk to `screens/devicesScreen.ts` | Done | `registerDevicesRoutes` — `devicesBody` + `DEVICE_LIST_FIELDS` + GET `/devices`, `/devices/export`, `/devices/bulk` before `:name`; detail + trends moved in Loop 35 |
| AuthEvents **Download server CSV** when live | Done | `/api/auth-events/export` with `q`/`plane`; client Export CSV kept for in-view rows |
| Overview / ClearPass full-repo server CSV | Skipped | Overview has no list export surface; ClearPass full catalog export N/A — page client CSV remains |
| `devicesExport.test.ts` | Done | list envelope + CSV + bulk (requires serials / missing) |
| Broad verification | Done | typecheck; server `*Export*` + devicesBulk + listQuery + debugRuntime; web Sites/Devices/Clients/Compliance/Alerts/Tickets/Overview/Uxi |

### Loop 25 (2026-08-04) — Mist/Central server CSV exports

| Item | Status | Anchors |
|---|---|---|
| `GET /api/mist/export` | Done | `screens/mistScreen.ts` — Mist-claimed devices via `devicesBody()` filter (`claimedBy`/plane); columns name/type/model/site/state/firmware/serial; no secrets |
| `GET /api/central/export` | Done | `screens/centralScreen.ts` — Central-claimed devices + site summary (`section=device\|site`); devices from `devicesBody()`, sites from `demoCentralSections` / `centralSiteRows` |
| Full screen handlers stay on `screens.ts` | Done | export-only extract; registered before any future `/:param` on those paths |
| Mist/Central UI **Download server CSV** (live only) | Done | `downloadApiCsv` → `/api/mist/export`, `/api/central/export`; client Export CSV kept |
| OpenAPI audit of `/export` routes | Done | added `/api/mist/export` + `/api/central/export`; catalog matches code export paths |
| Tests | Done | `mistExport.test.ts`, `centralExport.test.ts` |
| Focused typecheck + tests | Done | server export suite + Mist/Central UI |

### Loop 26 (2026-08-04) — topology + notification deliveries server CSV

| Item | Status | Anchors |
|---|---|---|
| `GET /api/topology` + shared `topologyBody()` | Done | `screens/topologyScreen.ts` — same assembly as former screens.ts path; reported neighbour facts only |
| `GET /api/topology/export?part=nodes\|edges` | Done | default `nodes`; CSV of graph facts (no guessed edges); 400 on bad `part` |
| Topology UI **Download server CSV** (live) | Done | `Topology.tsx` via `downloadApiCsv` for nodes + edges; client Export CSV kept |
| `GET /api/notifications/deliveries/export` | Done | outcome fields only (no payload bodies/secrets/URLs) |
| Notifications UI **Download server CSV** | Done | `NotificationsSection.tsx` via `downloadApiCsv`; client Export CSV kept |
| OpenAPI | Done | `/api/topology`, `/api/topology/export`, `/api/notifications/deliveries/export` |
| Tests | Done | `topologyExport.test.ts`, `notificationsDeliveriesExport.test.ts` |
| Focused typecheck + tests | Done | topology/notifications export + Topology/NotificationsSection |

### Loop 27 (2026-08-04) — search / configure history / recommendations CSV

| Item | Status | Anchors |
|---|---|---|
| SearchPanel **Export CSV** of current hits | Done | `web/src/app/SearchPanel.tsx` — `exportTableCsv` columns `label,kind,path` (no secrets) |
| Configure history **Download server CSV** | Done | `Configure.tsx` history drawer uses `downloadApiCsv` → `/api/configure/history/export?limit=200` (replaces `window.open`) |
| ConfigRecommendationsPanel **Download server CSV** | Done | always tries `/api/recommendations/export` with `device`/`site`/`client` filters; honest toast on fail |
| Overview server export | Skipped | client multi-file Export CSV already covers alerts/sites/planes; no new `/api/overview/export` |
| Tests + typecheck | Done | SearchPanel, ConfigRecommendationsPanel, Configure history download |

### Loop 28 (2026-08-04) — ClearPass extract + export

| Item | Status | Anchors |
|---|---|---|
| Extract ClearPass routes | Done | `screens/clearpassScreen.ts` — `registerClearPassRoutes`, honest envelopes via `clearpassBody()` |
| `GET /api/clearpass` + `/endpoints` + `/services/:id` | Done | same contracts as former `screens.ts` paths; static export/endpoints before `:id` |
| `GET /api/clearpass/export` | Done | CSV `section=endpoint\|session`; optional `q` + `part=endpoints\|sessions`; poller/fixture snapshot; no secrets |
| ClearPass UI **Download server CSV** (live only) | Done | `ClearPass.tsx` via `downloadApiCsv` → `/api/clearpass/export`; client Export CSV kept |
| OpenAPI | Done | `/api/clearpass/export` |
| Tests | Done | `clearpassExport.test.ts` |
| Focused typecheck + tests | Done | server clearpass export suite + typecheck |

### Loop 29 (2026-08-04) — Inventory + OpenAPI polish

| Item | Status | Anchors |
|---|---|---|
| Inventory **Export CSV** (client) of loaded search hits | Done | `Inventory.tsx` — already present; test coverage added |
| Inventory **Download server CSV** | Done | header button → `downloadApiCsv('/api/devices/export')` — no dedicated inventory export route; devices export is the portal inventory CSV |
| OpenAPI inventory browse paths | Done | `/api/inventory/tree`, `/search`, `/node` + devices/export note as inventory source |
| OpenAPI export catalog audit (L18–28) | Done | shipped `/export` routes including `/api/clearpass/export` (Loop 28) |
| Tests + typecheck | Done | `Inventory.test.tsx` export cases; focused server/web checks |

### Loop 30 (2026-08-04) — Mist full extract

| Item | Status | Anchors |
|---|---|---|
| Extract Mist dashboard + audit-log | Done | `screens/mistScreen.ts` — `registerMistRoutes`, `mistBody()` |
| `GET /api/mist` + `/mist/export` + `/systems/mist/audit-log` | Done | export static path before `/mist`; same contracts as former `screens.ts` |
| Mist UI **Download server CSV** + **Copy view link** | Done | already on `Mist.tsx` (`downloadApiCsv` → `/api/mist/export`) |
| Site SLE drill + siteMistKeys | Kept on `screens.ts` | `/sites/:siteId/sle/:metric` stays with site detail |
| Tests + typecheck | Done | mistExport, mistScreen, siteDetailMist audit-log |

### Loop 31 (2026-08-04) — Central extract + alerts timeline

| Item | Status | Anchors |
|---|---|---|
| Expand Central routes into `screens/centralScreen.ts` | Done | `registerCentralRoutes` — `centralBody()` + GET `/central` + `/central/export` (export before dashboard) |
| Extract alerts timeline into `screens/alertsScreen.ts` | Done | `GET /alerts/:fingerprint/timeline` after static `/alerts/export` + `/alerts` |
| `GET /api/alerts/:fingerprint/timeline/export` | Done | CSV of timeline events (`ts/kind/label/detail/approximate/correlation`; no secrets); registered before JSON timeline |
| Alerts timeline UI **Download server CSV** | Done | occurrence drawer → `downloadApiCsv` when server timeline loaded (hidden on offline demo spine) |
| OpenAPI | Done | `/api/alerts/{fingerprint}/timeline` + `/timeline/export` |
| Tests + typecheck | Done | `alertsExport.test.ts` timeline+CSV; `alertTimeline.test.ts`; `centralScreen`/`centralExport`; AlertsMaintenance CSV button |

### Loop 32 (2026-08-04) — Overview + Systems extract

| Item | Status | Anchors |
|---|---|---|
| Extract Overview into `screens/overviewScreen.ts` | Done | `registerOverviewRoutes` — `overviewBody()` + GET `/overview` + `/overview/export` |
| Extract Systems screen VM into `screens/systemsScreen.ts` | Done | `registerSystemsRoutes` — `systemsBody()` + GET `/systems` (credentials stay on `routes/systems.ts`) |
| Mount early from `screens.ts` | Done | static paths before param routes; handlers removed from god-route |
| `GET /api/overview/export?part=alerts` | Done | Needs-you-now CSV (`sev/title/plane/age/device/site/meta`; no secrets); default `part=alerts` |
| Overview UI **Download server CSV** | Done | live-only header button → `downloadApiCsv('/api/overview/export?part=alerts')` (client Export CSV retained) |
| OpenAPI | Done | `/api/overview`, `/api/overview/export`, `/api/systems` |
| Tests + typecheck | Done | `overviewExport.test.ts`, `systemsScreen.test.ts`, Overview CSV button cases; existing overview/systems route tests |

### Loop 33 (2026-08-04) — Configure + search-index extract

| Item | Status | Anchors |
|---|---|---|
| Extract `GET /api/configure` into `screens/configureScreen.ts` | Done | `registerConfigureScreenRoutes` — screen envelope only (stats/inventory/queue/capabilities); model stays in `configureModel.ts` |
| Keep broker history/export on `routes/configure.ts` | Done | `GET /configure/history` + `/history/export` unchanged (no duplication with screen extract) |
| Extract `GET /api/search-index` into `screens/searchScreen.ts` | Done | `registerSearchRoutes` — tickets + live sections + fixture filter; same envelope honesty rules |
| Wire `register*` into `screens.ts` | Done | both registers on `screensRouter`; handlers removed from god-route |
| Tests + typecheck | Done | configureHistory export; routes configure + search-index; server typecheck |

### Loop 34 (2026-08-04) — clients list + :mac into clientsScreen

| Item | Status | Anchors |
|---|---|---|
| Move `GET /api/clients` + `GET /api/clients/:mac` | Done | `screens/clientsScreen.ts` — `registerClientsRoutes` order: `/clients/export` → `/clients` → `/clients/:mac` |
| Keep `CLIENT_LIST_FIELDS` shared | Done | exported from `clientsScreen.ts` for list filter/paging + export |
| Move `serveClients` + client detail joins/stats | Done | `liveApForClient` / serving radio / wiring / `clientDetailKeys` / `liveClientStats` leave `screens.ts` |
| Tests + typecheck | Done | server typecheck; `clientsExport.test.ts`; clients-focused routes coverage |

### Loop 35 (2026-08-04) — device detail + trends into devicesScreen

| Item | Status | Anchors |
|---|---|---|
| Move `GET /api/devices/:name` | Done | `screens/devicesScreen.ts` — `serveDeviceDetail` + `snapshotDeviceConfig` + identity/409 helpers |
| Move trends routes | Done | `/devices/:name/trends/hardware`, `/interfaces`, `/ap/:metric` + stubs/claimant/live reads |
| Static-before-param order | Done | `registerDevicesRoutes`: `/export` → `/bulk` → `/devices` → `/:name` → trends |
| Shared window helper | Done | `trendWindow` from `screens/helpers.ts` (same bounds rule as site applications) |
| Leave site helpers elsewhere | Done | site detail in `siteDetailScreen.ts`; no site-only helper imports |
| Detail CSV export | Skipped | list `/devices/export` covers inventory; detail includes config bodies — avoid secret surface |
| Tests + typecheck | Done | server typecheck; `devicesExport`/`devicesBulk`/`deviceTrendsRoutes`/`mistApRoutes`/`configBackup` join + routes device cases |

### Loop 36 (2026-08-04) — site detail + SLE + applications extract

| Item | Status | Anchors |
|---|---|---|
| Extract `GET /api/sites/:siteId` | Done | `screens/siteDetailScreen.ts` — `registerSiteDetailRoutes` after list/export |
| Extract `GET /api/sites/:siteId/sle/:metric` | Done | same module; Mist on-demand drill + stubs unchanged |
| Extract `GET /api/sites/:siteId/applications` | Done | Central DPI on-demand; shared `loadSiteApplications` |
| Keep `/sites/export` + `/sites` first | Done | `sitesScreen.ts` registers static paths before param routes |
| Shared `trendWindow` helper | Done | `screens/helpers.ts` — used by site apps + `devicesScreen` trends |
| Optional `GET /api/sites/:siteId/applications/export` | Done | CSV of DPI rows (no secrets); OpenAPI paths added |
| Tests + typecheck | Done | server typecheck; `siteDetailMist`, `siteApplications`, `sitesExport` |

### Loop 37 (2026-08-04) — server CSV audit + visual/config panels

| Item | Status | Anchors |
|---|---|---|
| SiteDetail applications **Download server CSV** (live) | Done | `siteDetail/Applications.tsx` via `downloadApiCsv` → `/api/sites/:siteId/applications/export`; client Export CSV kept |
| RuntimeDebug **Download server CSV** (live) | Done | `RuntimeDebugSection.tsx` — separate button via `downloadApiCsv` → `/api/debug/runtime/export` (client Export integrity CSV kept) |
| Audit existing server CSV screens | Done | Topology, Mist, Central, ClearPass, Overview, AuthEvents, Compliance, Licenses, Sites, Devices, Clients, Tickets, Alerts, Uxi, Inventory, Configure history, Recommendations already had buttons |
| VisualReference + ConfigRecommendations gaps | Done | Added VisualReference on Overview (`estate/overview`) + Devices (`service/devices`); both panels on Uxi (`connector/uxi`), Alerts (`service/alerts`), Compliance (`service/compliance`), Tickets (`service/tickets`), Inventory (`estate/inventory`). DeviceDetail / ClientDetail / SiteDetail already had both |
| Tests + typecheck | Done | Applications CSV tests; web typecheck + focused screen tests |

### Loop 38 (2026-08-04) — connector integrity / RuntimeDebug polish

| Item | Status | Anchors |
|---|---|---|
| `GET /api/debug/runtime` includes `integrity{devices,doubleClaimed,unclaimed}` counts | Done | `debug.ts` via `liveDeviceData()` — counts only, no device identities/secrets |
| `GET /api/debug/runtime/export` → `connector-integrity.csv` | Done | integrity metric rows + plane link/health rows; OpenAPI updated |
| RuntimeDebug surfaces double-claimed / unclaimed badges | Done | `RuntimeDebugSection.tsx` |
| Plane filter + share URL (`?rtFilter=` / `?rtPlane=`) | Done | filter select; deep-link opens plane health drill-down |
| Copy view link | Done | copies Systems URL with current runtime filter/plane |
| Export integrity CSV + live Download server CSV | Done | client snapshot + `downloadApiCsv` for `/api/debug/runtime/export`; no secrets |
| Tests + typecheck | Done | `debugRuntime.test.ts`; Systems stub; server/web typecheck |

### Loop 39 (2026-08-04) — SSE inventory polish

| Item | Status | Anchors |
|---|---|---|
| Client **Export CSV** of filtered SSE objects | Done | `SseInventoryPanel.tsx` via `exportTableCsv` — summary cols only, never `raw` |
| Server CSV `GET /api/sse/objects/:kind/export?q=` | Done | `routes/sse.ts` + OpenAPI; registered before `/:id`; no secrets |
| Copy view link + filter query params | Done | `sseKind` / `sseQ` URL sync; link = `/systems?plane=sse&sseKind=&sseQ=` |
| VisualReference for SSE connector | Done | `connector/sse` @ plane `SSE` on the inventory panel |
| Tests + typecheck + docs | Done | `SseInventoryPanel.test.tsx`, `sseRoutes.test.ts`, user-guide SSE section |

### Loop 40 (2026-08-04) — DeviceDetail / ClientDetail / SiteDetail polish

| Item | Status | Anchors |
|---|---|---|
| DeviceDetail **Copy view link** | Done | live + demo headers; preserves `?plane=&serial=` |
| DeviceDetail **Export summary** CSV | Done | inventory fields via `deviceSummaryCsvRow` — never claim codes / config bodies |
| Hardware trends **Export trends** | Done | metric/t/v samples only; secret-shaped series keys dropped (`trendSeriesExportRows`) |
| ClientDetail drawer **Copy view link** + **Export summary** | Done | `?mac=` (+ `diagnostics=1`); one-row session CSV |
| SiteDetail **Copy view link** with section | Done | `?section=` / `#section` + `site-section-*` anchors; scrolls on open |
| GreenLake / AuthEvents share links + AuthEvents server CSV | Verified | already present (no code change this loop) |
| Tests + typecheck + docs | Done | deviceDetail facts/trends helpers; DeviceDetail/Clients/SiteDetail UI tests |

### Loop 42 (2026-08-04) — Notifications + Tickets polish

| Item | Status | Anchors |
|---|---|---|
| Notifications deliveries **Download server CSV** | Verified + tested | UI → `downloadApiCsv('/api/notifications/deliveries/export')` (outcomes only; no bodies/URLs/secrets) |
| Notifications **Copy section link** + deep-link scroll | Done | `/systems?section=notifications#notifications`; `systems-section-notifications` id; Systems scroll |
| Delivery log honest empty / error states | Done | empty attempt message; unavailable names the error (never hides the section) |
| Tickets server CSV + **Copy ticket link** | Verified + tested | live-only `/api/tickets/export`; `?sel=` share link |
| Tickets VisualReference + ConfigRecommendations | Verified + tested | service target `tickets` + workflow recommendations panel |
| Docs | Done | user-guide Notify + Work a ticket; this Loop 42 row |
| Tests + typecheck | Done | `NotificationsSection.test.tsx`, `Tickets.test.tsx` |

### Loop 43 (2026-08-04) — OpenAPI + user-guide parity

| Item | Status | Anchors |
|---|---|---|
| Scan `register*Screen` + route files for `/export` paths | Done | 21 CSV export routes under `screens/*`, `configure`, `notifications`, `recommendations`, `debug`, `sse` |
| OpenAPI parity for every export | Done | All 21 already listed in `openapi.ts`; enriched query params on clients/sites/auth-events exports |
| No missing export paths to add | Done | Diff route→OpenAPI: 0 missing / 0 orphans |
| User guide: server CSV, Copy view link, RuntimeDebug integrity, SSE export, bulk serial | Done | `docs/user-guide.md` — Working the tables; inventory bulk lookup; SSE export note; new Runtime debug section |
| Typecheck openapi/server | Done | `npm run typecheck -w server` |

### Loop 45 (2026-08-04) — Compliance + AlertsRules depth

| Item | Status | Anchors |
|---|---|---|
| Compliance drill-down (device count → Devices) | Verified + tested | `findingDevicesPath`; multi-device `?names=` / single device detail |
| Compliance **Export CSV** + live **Download server CSV** | Verified + tested | client filtered findings; `GET /api/compliance/export` (no full diff) |
| Compliance **Copy filter link** (`?baseline=`) | Verified + tested | header action; deep-link seeds Select |
| Compliance VisualReference + recommendations | Verified + tested | service `compliance` + **Compliance recommendations** |
| AlertsRules client **Export CSV** | Done + tested | `device-down-rules.csv` (no secrets; no server export needed) |
| Alerts Policy **Copy policy link** + `?tab=policy` | Done + tested | rules + windows sections; deep-link opens Policy tab |
| Maintenance windows client **Export CSV** + share | Done + tested | `maintenance-windows.csv`; same policy link |
| Docs | Done | user-guide Compliance + device-down + maintenance; this Loop 45 row |
| Tests + typecheck | Done | `Compliance.test.tsx`, `AlertsRules.test.tsx`, `AlertsMaintenance.test.tsx` |

### Loop 44 (2026-08-04) — Topology filters, licences renewals CSV, Alerts share, GreenLake export

| Item | Status | Anchors |
|---|---|---|
| Topology filters + share query params | Done | `q` / `plane` / `ghosts` / `view` / `focus` URL sync; filter bar; Copy view link builds share URL; `filterTopologyGraph` helper |
| Licences renewals CSV (client + server) | Done | `Export renewals CSV`; `GET /api/licenses/export?part=renewals`; idle share `?idle=1` |
| Alerts Copy view link | Done | `q` / `plane` / `sev` / `site` / `unacked` / `cleared` / `tab` share + hydrate |
| GreenLake server CSV + section deep link | Done | `GET /api/greenlake/export?part=users\|locations\|roles`; `?section=` scroll anchors |
| OpenAPI | Done | licenses export part enum; greenlake inventory + export |
| Focused tests + typecheck | Done | licensesExport, greenlakeExport, Topology/Licenses/Alerts/GreenLake tests |

### Loop 46 (2026-08-04) — GreenLake routes check + Recommendations deep-link

| Item | Status | Anchors |
|---|---|---|
| GreenLake API extract to `greenlakeScreen.ts` | Skipped (clean) | `routes/greenlake.ts` already dedicated (~167 LOC: inventory/export/actions); not a screens god-file path |
| Full-page Recommendations route | Done | `/recommendations` under Change; `View` + nav + crumbs; filters `?device=&site=&client=` |
| Panel **Copy panel context link** | Done | `ConfigRecommendationsPanel` → canonical `/recommendations?…` via `recommendationsPath` |
| Panel URL filter fallback | Done | props override; else reads `device`/`site`/`client` search params |
| Full-page **Download server CSV** | Done | header → `/api/recommendations/export` with current filters (L27 panel export retained) |
| Never auto-apply | Verified | panel meta + page alert; API `readOnly` note unchanged |
| Tests + docs | Done | panel + Recommendations screen + nav path tests; user-guide + this row |

### Loop 47 (2026-08-04) — Configure queue polish

| Item | Status | Anchors |
|---|---|---|
| Client **Export queue CSV** (summary cols only) | Done + tested | `Export queue CSV` → `configure-queue.csv` via `queueExportRows` — id/state/what/where/ticket/expiresAt; never rendered payloads |
| **Copy view link** with `?section=` | Done + tested | `ssids` / `ports` / `vlans` / `queue` / `targets`; defaults to `queue` (or `targets` in lab); `configure-section-*` anchors + scroll |
| Honest empty queue state | Done + tested | Broker empty ≠ failed read; SSIDs apply directly and never enter the broker queue |
| History **Download server CSV** | Verified | `GET /api/configure/history/export` already present; drawer button via `downloadApiCsv` |
| No auto-apply of recommendations/changes | Verified | Recommendations panel remains read-only; queue push stays explicit |
| Docs | Done | user-guide Configure queue share/export; this Loop 47 row |
| Tests + typecheck | Done | `Configure.test.tsx` queue polish block; web/server typecheck |

### Loop 48 (2026-08-04) — residual export/share audit + 3 gaps

Presence matrix (web screens / panels — Export CSV · Download server CSV · Copy view/filter link):

| Surface | Copy | Client CSV | Server CSV | Notes |
|---|---|---|---|---|
| Overview | Y | Y | Y (live) | |
| Sites | Y | Y | Y (live) | |
| SiteDetail | Y | devices (+ **rogues** L48) | — | section deep-link |
| Site applications | — | Y | Y (live) | under SiteDetail |
| Devices | Y | Y | Y (live) | |
| DeviceDetail | Y | summary/ports | — | |
| Clients | Y | sessions | Y (live) | label “Export sessions” |
| Inventory | Y | Y | Y (devices export) | |
| Alerts (+ rules/maint) | Y / policy | Y | Y (live) | |
| Tickets | ticket link | Y | Y (live) | |
| AuthEvents | Y | Y | Y (live) | |
| Topology | Y | Y | Y nodes+edges | |
| Mist | Y (+audit/devices L49) | Y (devices+rogues+APs+**audit** L49) | Y devices + **audit** L49 | |
| Central | Y | Y multi | Y (live) | subsections via header |
| ClearPass | filter | Y | Y (live) | |
| UXI | filter | Y | Y (live) | |
| Compliance | filter | Y | Y (live) | |
| Licenses | Y | Y (+renewals) | Y | |
| GreenLake | Y | Y | Y (live) | |
| Configure | Y section | queue | history (live) | |
| Systems | Y | — | — | plane deep-link |
| Notifications | section | Y | Y | |
| RuntimeDebug | Y | integrity | Y (live) | |
| SSE inventory | Y | Y | Y (live) | |
| SearchPanel | — | Y | — | ephemeral |
| ConfigRecommendations | panel context | **Y L48** | Y | client CSV added; server retained |
| Recommendations page | filter | Y (via panel) | Y | `/recommendations` |
| Central webhooks | **Y L48** | **Y L48** | — | no secrets; Systems `?plane=central&tab=config` |
| CentralWebhooks receivers/events | — | — | — | intentionally outcomes-only UI |
| Firmware/Sites/Alerts/WLANs subsections | **Y L49** | **Y L49** | via Central | per-section share + client CSV |

| Item | Status | Anchors |
|---|---|---|
| Residual presence matrix | Done | table above |
| ConfigRecommendationsPanel client **Export CSV** | Done + tested | alongside existing server CSV; real fields, no auto-apply |
| SiteRogueAps **Export CSV** | Done + tested | `site-rogues.csv` sorted on-wire first; same cols as Mist estate export |
| CentralWebhooksPanel **Copy view link** + **Export CSV** | Done + tested | `/systems?plane=central&tab=config`; summary cols only (no HMAC/secrets) |
| Systems `?tab=` deep-link | Done + tested | `summary` / `activity` / `config` with `?plane=`; strips after open |
| Docs | Done | user-guide recommendations + rogues + webhooks; this Loop 48 row |
| Tests + typecheck | Done | ConfigRecommendationsPanel, RogueAps, CentralWebhooksPanel, Systems tests |

**Still open (next loops):** remaining connector-integrity plan checkboxes, deeper connector form audit; optional server CSV for mist rogues `part=`; DeviceDetail clients export.

### Loop 49 (2026-08-04) — Mist audit export/share + Central section export + Mist devices CSV

| Item | Status | Anchors |
|---|---|---|
| Mist org audit log **Export CSV** + **Copy section link** | Done + tested | `mist/audit.tsx` (`/mist?section=audit`); Systems Mist drawer reuses same section |
| Mist audit **Download server CSV** | Done + tested | `GET /api/mist/audit-log/export` — id/at/admin/message/site/before/after; portal-redacted; OpenAPI |
| Central subsection **Copy section link** + **Export CSV** | Done + tested | Sites / Firmware / WLANs / Recent alerts; `?section=sites|firmware|wlans|alerts` scroll |
| Mist devices client CSV | Done + tested | Header Export includes `mist-devices.csv`; Firmware section export of claimed inventory |
| Docs | Done | user-guide Mist audit + Central sections; this Loop 49 row |
| Tests + typecheck | Done | Mist.test, Central.test, MistSection.test, mistExport.test |

**Still open (next loops):** remaining connector-integrity plan checkboxes; optional server CSV for mist rogues `part=`; DeviceDetail clients export.

### Loop 50 (2026-08-04) — a11y labels + honest empty states

| Item | Status | Anchors |
|---|---|---|
| DataTable `ariaLabel` audit | Verified | All 35 production `<DataTable>` call sites already pass a required `ariaLabel` |
| Compound `Table` + high-traffic labels | Done + tested | `Table.ariaLabel` (DsGallery sample devices); Search results listbox; Ticket queue; recommendations list |
| Global search honest failure | Done + tested | Failed inventory search → "Inventory search unavailable — …", never a clean miss |
| Alerts ack ticket queue envelope error | Done | `apiError` blocks ack with named failure + Retry (never "no open ticket") |
| Clients CoA ticket queue envelope error | Done | Same honesty on session write authorising ticket |
| Inventory node selection error | Done | Failed `getInventoryNode` → EmptyState with reason (detail panel stays open) |
| Recommendations panel empty-on-error | Done + tested | Error alert only — no "No recommendations" empty beside a failed read |
| Docs | Done | user-guide Working the tables + recommendations; this Loop 50 row |
| Tests + typecheck | Done | SearchPanel, Table, ConfigRecommendationsPanel; web typecheck |

**Honesty rule restated:** answered failures and envelope `apiError` never become demo rows or silent empties. Unreachable backends may still use fixtures; named HTTP/API errors do not.

### Loop 52 (2026-08-04) — SLE export/share + Configure inventory CSV + firmware compliance + OpenAPI

| Item | Status | Anchors |
|---|---|---|
| SiteDetail SLE **Copy section link** + **Export CSV** | Done + tested | `siteDetail/Sle.tsx` — `?section=sle`; `site-sle-<id>.csv` metric scores |
| SLE drill **Export drill CSV** | Done + tested | Classifiers + impacted clients/APs only; helpers `sleMetricCsvRows` / `sleDrillCsvRows` |
| Configure SSID / ports / VLANs **Export * CSV** | Done + tested | `configure-ssids/ports/vlans.csv` via `ssidExportRows` / `portExportRows` / `vlanExportRows` (section share L47) |
| Mist firmware **Export compliance CSV** | Done + tested | Behind-train rows → `mist-firmware-compliance.csv`; inventory Export CSV retained |
| Device trends export | Verified | L40 `Export trends` + `trendSeriesExportRows` still present |
| OpenAPI Mist audit JSON + dashboard | Done | `/api/mist`, `/api/systems/mist/audit-log` (+ L49 `/api/mist/audit-log/export`) |
| Docs | Done | user-guide SLE / Configure inventory / Mist firmware; this Loop 52 row |
| Tests + typecheck | Done | Sle, Configure, Mist, mistExport; web/server typecheck |

### Loop 53 (2026-08-04) — Export catalog + shared export parts + screens docs

| Item | Status | Anchors |
|---|---|---|
| Shared multi-slice export `?part=` types | Done | `shared/exports.ts` (topology/licenses/greenlake/clearpass/overview + central section cols) |
| Cumulative **Export catalog** (all server CSV paths) | Done | compact table below |
| Docs: `screens.ts` no longer monolithic | Done | hotspots + API backlog + file map; mount-order shell only |
| Typecheck | Done | monorepo `npm run typecheck` |

#### Export catalog (server CSV)

| Path | Query / notes |
|---|---|
| `GET /api/overview/export` | `part=alerts` (default) |
| `GET /api/devices/export` | `q` / `plane` / `type` / `site` / `state` / `issues` — also Inventory CSV |
| `GET /api/devices/{name}/clients/export` | optional `plane`/`serial` identity; attached sessions only |
| `GET /api/devices/{name}/ports/export` | optional `plane`/`serial`; port/interface rows only (Loop 93) |
| `GET /api/devices/{name}/trends/export` | `part=hardware\|interfaces\|ap` (+ optional `metric`/`plane`/`serial`/window) |
| `GET /api/clients/export` | `q` / `plane` / `medium` / `type` / `site` / `group` / `health` / `problems` (Loop 113 `health`) |
| `GET /api/sites/export` | `q` / `plane` / `health` (list filters) |
| `GET /api/sites/{siteId}/applications/export` | `start`, `end` |
| `GET /api/sites/{siteId}/rogues/export` | Mist rogue/neighbor BSSIDs for one site (poll-time; empty = none heard) |
| `GET /api/sites/{siteId}/sle/export` | polled Mist SLE metric scores for one site |
| `GET /api/sites/{siteId}/sle/{metric}/export` | one SLE metric drill (classifiers + impacted) |
| `GET /api/auth-events/export` | `q` / `plane` / `result` / `service` / `method` / `role` / `range` (Loop 107 `method`; Loop 115 `role`) |
| `GET /api/alerts/export` | active groups; optional `q`/`plane`/`sev`/`site`/`unacked`/`cleared` (Loop 118 queryFlag yes/on/no/off) |
| `GET /api/alerts/{fingerprint}/timeline/export` | occurrence timeline |
| `GET /api/silences/export` | optional `active=` / `q=`; matchers + reason + expiry (Loop 93; Loop 111 `q=`) |
| `GET /api/tickets/export` | `q` / `pri` / `state` (`openish`); no note bodies |
| `GET /api/uxi/export` | sensors; `q` / `status` / `site` / `severity` (Loop 110; Loop 118 queryString/queryOneOf) |
| `GET /api/mist/export` | `part=devices\|rogues\|ap-stats\|sle\|wlans\|licenses` (default devices; Loop 98 `sle`; Loop 104 `wlans`/`licenses`; Loop 115 wlans `q=`/`enabled=`) |
| `GET /api/mist/audit-log/export` | `limit` |
| `GET /api/central/export` | `part=device\|site\|firmware\|wlans\|alerts` (omit/all = combined device+site with `section` col; dedicated slices for firmware/WLANs/alerts) |
| `GET /api/central/webhooks/export` | optional `q=`; webhook summaries only — no secrets/HMAC (Loop 99) |
| `GET /api/clearpass/export` | `q` / `status` / `category` / `enabled` (Loop 115 queryFlag on/off); `part=endpoints\|sessions\|services` (services = dedicated columns) or omit endpoints+sessions |
| `GET /api/topology/export` | `part=nodes\|edges` (default nodes); optional `q` / `plane` / `ghosts` / `type` (Loop 104 `type`; Loop 115 `ghosts` queryFlag yes/on) |
| `GET /api/alert-rules/export` | optional `enabled=` / `deviceType=`; device-down rules on file (Loop 90 `enabled`; Loop 111 `deviceType`) |
| `GET /api/maintenance-windows/export` | optional `enabled=` / `state=` / `q=`; matchers + schedule (Loop 93; Loop 114 `q=`) |
| `GET /api/compliance/export` | findings only (no full diff); optional `baseline`/`sev`/`plane`/`fix`/`q` (Loop 110 `fix`; Loop 122 shared `queryString`) |
| `GET /api/config-backups/export` | optional `drift=` / `q=` / `plane=` / `status=`; roster metadata only — no config bodies (Loop 96/105) |
| `GET /api/licenses/export` | `part=subscriptions\|renewals`; optional `idle=` / `plane=` / `status=` / `q=` on subscriptions (Loop 113 `status`) |
| `GET /api/greenlake/export` | `part=users\|locations\|roles` (+ optional `q=`; users also `status=` — Loop 107) |
| `GET /api/hooks/events/export` | optional `limit` / `source=` / `q=`; received-event summaries — no payloads/secrets (Loop 99) |
| `GET /api/recommendations/export` | device/site/client/category/severity filters (Loop 114 allow-list; unknown severity/category no-op) |
| `GET /api/configure/export` | `part=ssids\|ports\|vlans` (+ optional `q=`); inventory summary only (Loop 95) |
| `GET /api/configure/history/export` | `limit` / optional `kind`/`result`/`ticket` — broker audit (Loop 119 shared `queryString`) |
| `GET /api/notifications/deliveries/export` | outcomes only; optional `result=` / `q=` (Loop 116 `q=`) |
| `GET /api/notifications/outbox/export` | webhook demo-outbox event summaries — never payload bodies (Loop 101; Loop 119 `q=`) |
| `GET /api/notifications/report/export` | fleet-report outbox metadata — subject/recipients only, never email bodies (Loop 101; Loop 119 `q=`) |
| `GET /api/notifications/ssl-hosts/export` | watch list + last probe; optional `q=`; no PEMs (Loop 96; Loop 116 `q=`) |
| `GET /api/diagnostics/history/export` | optional `device`/`plane`/`state`/`q=`; target always redacted (Loop 101; Loop 114 `q=`) |
| `GET /api/metrics/export` | `part=series\|anomalies` (default series); count samples / flags only (Loop 101) |
| `GET /api/debug/runtime/export` | connector-integrity.csv |
| `GET /api/search-index/export` | optional `q`/`kind`; jump-index kind/label/meta/view/arg only (Loop 102; UI kind Select Loop 110; Loop 122 shared `queryString`) |
| `GET /api/sse/objects/{kind}/export` | `q`; summary fields only |
| `GET /api/systems/export` | optional `q`/`health`/`linked` (Loop 118 queryFlag yes/on/no/off on linked); roster summary only — no credentials/notes (Loop 100) |
| `GET /api/visual-references/export` | optional `kind`+`id` (+`plane`); metadata only — never binary assets (Loop 99) |

**Count: 44** server CSV paths (matches `EXPECTED_EXPORTS`, OpenAPI, and route scan; site rogues export landed in Loop 104). No dedicated inventory export route — use devices export. All CSVs omit secrets/raw vendor bodies.

### Loop 54 (2026-08-04) — Topology export split + OpenAPI gaps + Sites filters

| Item | Status | Anchors |
|---|---|---|
| Site diagram **Export CSV** stays client-side | Verified | `SiteTopologyDiagram` → `site-topology-nodes/edges.csv` (no estate API) |
| Estate Topology **Download server CSV** (nodes/edges) | Verified + tested | Live only → `GET /api/topology/export?part=nodes\|edges` |
| OpenAPI recent screen paths | Done | `/api/central`, `/api/clearpass`, `/api/clearpass/endpoints`, `/api/configure`, `/api/search-index`, `/api/devices/{name}`, `/api/clients/{mac}`; sites list `q` |
| Sites filter URL persistence + load-more | Done + tested | `?q=` / `?plane=` write-back; append via `nextCursor` |
| Docs | Done | user-guide topology export split + Sites filters; this Loop 54 row |
| Tests + typecheck | Done | Topology.test, Sites.test, SiteTopologyDiagram; monorepo typecheck |

### Loop 55 (2026-08-04) — Export safety audit

| Item | Status | Anchors |
|---|---|---|
| Grep all `sendCsv` handlers for secret-shaped columns | Done | password/token/secret/body/payload/credential URL — **no column names leak secrets** |
| Tickets CSV omits note bodies | Confirmed | `ticketsScreen` cols `id…inc` only; test + static contract |
| Notifications deliveries CSV omits bodies/URLs/HMAC | Confirmed | outcomes only (`endpoint` = name); test + static contract |
| Mist audit `before`/`after` | Confirmed | portal-scrubbed at `scrubMistAuditSnapshot` before export |
| Defense-in-depth cell redaction | Done | `redactExportCell` in `server/src/lib/csv.ts` — URL userinfo + bearer/password/token assignments on **every** CSV cell |
| Alerts queue CSV header alignment | Fixed | was mislabeled first col `fingerprint` (value was `sev`); now `sev…fingerprint` |
| Tests | Done | `csvExportSafety.test.ts`, `alertsExport`, tickets/notifications export suites |
| Typecheck | Done | monorepo `npm run typecheck` |
| Docs | Done | this Loop 55 row; user-guide export safety note |

**Finding:** No high-confidence secret **columns** to drop. Residual risk is free-text (`detail`/`error`/`message`) accidentally embedding credentials — mitigated by universal cell redaction at `sendCsv`.

### Loop 56 (2026-08-04) — Devices share filters + Clients load-more + Alerts selection export + Systems health CSV

| Item | Status | Anchors |
|---|---|---|
| Devices filter share link completeness | Done + tested | write-back `q`/`type`/`issues`/`plane`/`site`; seed on load; Copy view link uses address bar |
| Clients load-more when `page.nextCursor` | Verified + tested | append via cursor (Sites pattern); `Clients.test` Load more |
| Alerts bulk **Export selected** | Done + tested | multi-select bulk bar → `alerts-selected.csv` |
| Systems plane drawer **Export health summary** | Done + tested | summary tab → field/value CSV (no credentials) |
| Docs | Done | user-guide Working the tables + cookbook; this Loop 56 row |
| Tests + typecheck | Done | Devices/Clients/Alerts/Systems targeted tests; monorepo typecheck |

### Loop 57 (2026-08-04) — Recommendations nav + share/CSV cookbook

| Item | Status | Anchors |
|---|---|---|
| Recommendations in Change nav | Verified + tested | `NAV_GROUPS` Change → Configure, Compliance, **Recommendations**, Licences; crumbs + icon + route already present (L46) |
| Nav regression test | Done | `nav.test.ts` asserts Change menu membership + path round-trip |
| User-guide Navigation IA | Done | Operate / Estate / Change / Platforms (was stale Inventory/Govern) |
| User-guide **Copy view link & server CSV** cookbook | Done | compact major-screen table (share params + server CSV paths) |
| Typecheck + nav tests | Done | monorepo `npm run typecheck`; `nav.test.ts` + `AppShell.test.tsx` |

### Loop 58 (2026-08-04) — Sites health share + Tickets filters + Inventory expand URL

| Item | Status | Anchors |
|---|---|---|
| Sites **health** filter + share | Done + tested | `?health=ok\|warn\|bad\|stale` seed/write-back; Copy filter link includes health with q/plane |
| Tickets queue **pri/state** URL filters | Done + tested | `?pri=` / `?state=` (incl. `openish`); Copy view link carries sel+filters; empty-filter empty state |
| Inventory tree **expand** in URL | Done + tested | `?exp=` comma ids via `InventoryTree` expandedIds/onExpandedChange; preserves `?node=` |
| Docs | Done | user-guide Working the tables + cookbook rows; this Loop 58 row |
| Tests + typecheck | Done | Sites/Tickets/Inventory/InventoryTree targeted tests; monorepo typecheck |

### Loop 59 (2026-08-04) — list paging consistency (Tickets)

| Item | Status | Anchors |
|---|---|---|
| Audit listQuery paging | Done | devices/clients/sites/alerts/auth-events already optional `?limit=&cursor=`; inventory/ClearPass endpoints have dedicated pagers |
| Tickets `listQuery` paging | Done + tested | `applyListPaging` + `sendCachedJson` on `GET /api/tickets`; omit limit = full queue |
| Honest ticket filters | Done + tested | `?q=` via `applyListFilters`; `?pri=` / `?state=` (`openish`) via `applyTicketQueueFilters` (unknown values 400); export uses same filters, no page slice |
| Tickets **Load more** | Done + tested | page size 50; append via `page.nextCursor`; passes pri/state with limit |
| OpenAPI | Done | `/api/tickets` parameters + page envelope |
| Docs | Done | user-guide Work a ticket + Working the tables; this Loop 59 row |
| Tests + typecheck | Done | `ticketsListQuery.test.ts`, `Tickets.test.tsx` load-more; monorepo typecheck |

### Loop 60 (2026-08-04) — numbering continuity (no separate delta)

| Item | Status | Anchors |
|---|---|---|
| Loop id | Skipped | Same pattern as L17 / L41 / L51 — id unused so L61 could own the next multi-screen share/paging batch |
| Code / export paths | Unchanged | No dedicated L60 commit; catalog still the L53 table |
| Docs | Done | this Loop 60 continuity row (filled Loop 69) |

### Loop 61 (2026-08-04) — AuthEvents share + Compliance filters + UXI paging

| Item | Status | Anchors |
|---|---|---|
| AuthEvents filter share completeness | Done + tested | URL write-back `q`/`result`/`service`/`plane` (+ existing `range`); **Copy view link** uses address bar; seed result/service from URL |
| AuthEvents Load more + server filters | Done + tested | `getAuthEvents` passes `q`/`plane` with `limit`/`cursor` so append continues the filtered feed |
| Compliance filter share completeness | Done + tested | Severity + plane Selects; write-back `baseline`/`sev`/`plane`; **Copy filter link** shares all three |
| UXI filters + Load more | Done + tested | Server `q`/`status`/`site` + optional `limit`/`cursor` on `GET /api/uxi` (+ export); UI status/site/q share + page size 100 Load more |
| OpenAPI | Done | `/api/uxi` + export parameters; auth-events already documented |
| Docs | Done | user-guide Working the tables + Compliance + cookbook; this Loop 61 row |
| Tests + typecheck | Done | `AuthEvents`/`Compliance`/`Uxi` screen tests; `uxiListQuery`/`uxiExport`; monorepo typecheck |

### Loop 62 (2026-08-04) — Export route ↔ OpenAPI parity guard

| Item | Status | Anchors |
|---|---|---|
| Server test: every `/export` registration ↔ OpenAPI | Done | `server/tests/exportOpenapiParity.test.ts` scans Express `.get/.post/…` paths under `server/src` (comments stripped) |
| Curated `EXPECTED_EXPORTS` catalog | Done | 23 paths kept in sync with code + `openapi.ts` (bidirectional exact match) |
| Drift fix | None | code, OpenAPI, and `EXPECTED_EXPORTS` already identical (no missing/extra export routes) |
| Docs | Done | this Loop 62 row; Export catalog still authoritative in Loop 53 table |
| Typecheck + test | Done | monorepo `npm run typecheck`; `exportOpenapiParity.test.ts` |

### Loop 63 (2026-08-04) — Export/Copy a11y names + icon control labels

| Item | Status | Anchors |
|---|---|---|
| Primary **Export / Download / Copy** buttons | Verified | Visible text labels already supply accessible names (no icon-only export chrome) |
| Icon-only / compact controls without clear names | Fixed (5) | Rail toggle SVG `aria-hidden`; Platforms toggle `aria-label` expanded/collapsed; DataTable sort `aria-label` (+ sort state); pagination page `aria-label` + `aria-current`; ShiftStrip P1/planes chips action-bearing `aria-label` |
| CSS | Unchanged | Prefer existing classes; no new CSS files |
| Docs | Done | user-guide Working the tables a11y note; this Loop 63 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; DataTable/ShiftStrip/AppShell targeted tests |

### Loop 64 (2026-08-04) — Licences idle URL + ClearPass tab deep links + Central applications section

| Item | Status | Anchors |
|---|---|---|
| Licences `idle` filter URL write-back | Done + tested | `Licenses.tsx` keeps `?idle=1` aligned with spare-capacity switch; **Copy view link** uses live address bar |
| ClearPass tab deep-link completeness | Done + tested | `?tab=endpoints\|auth\|network\|sources\|roles\|enforcement\|users\|services` (default endpoints omits param); write-back for `tab` + endpoint `q`/`status`/`category`; **Copy filter link** |
| Central applications section share | Done + tested | `ApplicationsSection` `central-section-applications` + **Copy section link** (`?section=applications`); `CENTRAL_SECTIONS` includes `applications` |
| Docs | Done | user-guide ClearPass / Central sections / Licences + cookbook; this Loop 64 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Licenses / ClearPass / Central targeted tests |

### Loop 65 (2026-08-04) — Device detail summary CSV safety + config `?tab=` share

| Item | Status | Anchors |
|---|---|---|
| Device summary CSV never ships secrets | Verified + tested | `deviceSummaryCsvRow` / `DEVICE_SUMMARY_HEADERS` inventory-only; drops `claimCode`; `isSecretDeviceField` + `filterPublicFacts` block claim codes, passwords, tokens, running-config bodies |
| Config tabs URL share | Done + tested | DeviceDetail Configuration `?tab=running\|diff\|history` (default running omits param); deep-link + write-back; **Copy view link** carries current tab with `plane`/`serial` |
| Docs | Done | user-guide device detail + cookbook Devices row; this Loop 65 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; `trends.test.tsx` CSV contract; `DeviceDetail.test.tsx` `?tab=` |

### Loop 66 (2026-08-04) — Export catalog parity re-check

| Item | Status | Anchors |
|---|---|---|
| Path set vs code / OpenAPI / `EXPECTED_EXPORTS` | Verified | **23** paths — identical bidirectional set; no add/drop since L62 |
| Catalog query notes refresh | Done | sites `q`/`plane`; tickets `q`/`pri`/`state`; uxi `q`/`status`/`site`; explicit **Count: 23** under L53 table |
| Code changes | None | docs-only |
| Docs | Done | this Loop 66 row |

### Loop 67 (2026-08-04) — User-guide cookbook audit

| Item | Status | Anchors |
|---|---|---|
| Cookbook vs live share/export surfaces | Verified | Devices config `tab`, Licences `idle`, ClearPass tabs, Central `applications`, Tickets pri/state, UXI/AuthEvents load-more already documented (L56–65) |
| Stale IA / missing CSV path | None | Navigation IA + full-path pointer to Export catalog still correct |
| Code changes | None | docs-only continuity |
| Docs | Done | this Loop 67 row; user-guide catalog count pointer |

### Loop 68 (2026-08-04) — ETag/cache consistency (overview)

| Item | Status | Anchors |
|---|---|---|
| Audit `sendCachedJson` list usage | Done | Already on devices, devices/bulk, clients, sites, alerts, tickets, auth-events, uxi |
| Overview envelope ETag/304 | Done + tested | `GET /api/overview` → `sendCachedJson` (weak ETag + `Cache-Control: private, no-cache`) |
| ETag ignores `syncedAt` | Done + tested | `etagPayload` strips wall-clock stamp so demo `new Date()` / poll timestamps do not bust 304 when rows unchanged |
| OpenAPI | Done | `/api/overview` documents 200 ETag + 304 If-None-Match |
| Helper tests | Done | `listQuery.test.ts` covers miss + matching If-None-Match 304 (with syncedAt drift) |
| Docs | Done | this Loop 68 row; backlog overview ETag item closed |
| Typecheck + tests | Done | monorepo `npm run typecheck`; `listQuery` + `overviewExport` |

### Loop 69 (2026-08-04) — Docs hygiene (this pass)

| Item | Status | Anchors |
|---|---|---|
| Ensure L56–L68 rows | Done | L60 + L66–L67 filled; L56–L59 + L61–L65 + L68 already present |
| Export catalog count | Verified | **23** paths; query notes only (no path churn) |
| User-guide | Brief note | cookbook → catalog **23** routes through Loop 69 |

### Loop 70 (2026-08-04) — Clients filter share + device clients export + Recommendations VR

Residual improvements pass (filter URL write-back / sub-table export / VisualReference):

| Item | Status | Anchors |
|---|---|---|
| Clients filter URL write-back completeness | Done + tested | Seed + write-back `q`/`medium`/`type`/`site`/`group`/`plane`/`problems`; open/close drawer preserves list filters (no longer wipes to `?mac=` alone); **Copy view link** (header + drawer) builds from address bar or filter state |
| DeviceDetail **Export clients** sub-table | Done + tested | Live + demo "Clients on this device" → client CSV (`client`/`model`/`mac`/`ip`/`where`/`state`/`detail`); no secrets |
| Recommendations **VisualReferencePanel** | Done + tested | `target={{ kind: 'service', id: 'recommendations' }}` `editable={false}` on full-page hygiene screen |
| Docs | Done | user-guide Clients cookbook + Recommendations VR note; this Loop 70 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Clients / DeviceDetail / Recommendations targeted tests |
| Code | None | docs-only |

### Loop 71 (2026-08-04) — Alerts server q= + site secondary share + Central apps CSV

Residual export/share audit (secondary Copy links / sub-table CSV / server list q=):

| Item | Status | Anchors |
|---|---|---|
| Alerts server list/export `?q=` (+ `?plane=`) | Done + tested | `applyAlertQueueFilters` on nested `latest` fields before paging; UI `getAlerts({ q })` + server CSV `?q=`; OpenAPI params |
| Site secondary **Copy section link** | Done + tested | Site **Rogues** / **Applications** / topology diagram (`?section=rogues\|applications\|topology` + hash); always available even when empty |
| Central applications **Export CSV** | Done + tested | Client CSV of loaded DPI table for selected site (`central-applications-<siteId>.csv`) |
| Docs | Done | user-guide site sections + Alerts cookbook `q=`; this Loop 71 row |
| Typecheck + tests | Done | alertsExport + RogueAps/Applications/Central/SiteTopology/Alerts targeted |

### Loop 72 (2026-08-04) — GreenLake section share + Alerts sev URL + Topology view param

Residual share/filter URL completeness (distinct from Loop 70 Clients/DeviceDetail/Recommendations):

| Item | Status | Anchors |
|---|---|---|
| GreenLake section share completeness | Done + tested | Per-section **Copy section link** on users / roles / locations (`?section=` + `#greenlake-section-*` hash); header **Copy view link** uses shared builder; helpers `sectionFromParam` / `sectionToParam` / `sectionDomId` / `buildGreenLakeShareUrl` |
| Alerts severity filter URL write-back | Done + tested | Seed + write-back `sev` / `plane` / `site` / `q` / `unacked` / `cleared` / `tab`; address-bar re-seed on external nav; **Copy view link** prefers live search string |
| Topology `view` param persistence | Done + tested | Missing `view` → write resolved default (`3d` with WebGL, else `2d`); 3D/2D toggle keeps `view=3d|2d` in the address bar; share URL still carries filters + focus |
| Docs | Done | user-guide Copy view cookbook + Topology/Alerts/GreenLake notes; this Loop 72 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; GreenLake / Alerts / Topology targeted tests |

### Loop 74 (2026-08-04) — Inventory search share + Mist section share + Overview health share

Residual share/filter URL completeness (distinct from L70–72 Clients/DeviceDetail/Alerts/Topology/GreenLake):

| Item | Status | Anchors |
|---|---|---|
| Inventory **search** URL share | Done + tested | Seed + write-back `?q=` (min 2 chars) with `node`/`exp`; **Copy view link** via `buildInventoryShareUrl`; short queries drop `q` |
| Mist **section** share completeness | Done + tested | All poll-time sections + audit: `sle` / `rogues` / `ap-health` / `wlans` / `devices` / `licenses` / `audit`; per-section **Copy section link** + `#mist-section-*`; helpers in `mist/share.ts` (`parseMistSection` aliases firmware→devices, ap→ap-health) |
| Overview **sites health** share | Done + tested | Sites preview `?health=ok\|warn\|bad\|stale` seed/write-back + filter Select; **Copy view link** / section hand-off to `/sites?health=`; helpers `parseOverviewHealthFilter` / `buildOverviewShareUrl` |
| Docs | Done | user-guide cookbook Inventory `q`, Overview `health`, Mist full section list; this Loop 74 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Inventory / Mist / Overview targeted tests |

### Loop 75 (2026-08-04) — Tickets notes honesty + export filters + Compliance server filters

Independent residual pass (tickets notes honesty / compliance — distinct from L72 share params and L48 systems drawer tabs):

| Item | Status | Anchors |
|---|---|---|
| Tickets draft-note honesty | Done + tested | Clearing the note box when the workspace ticket changes so a half-written note cannot POST against the wrong id |
| Tickets export filter + `noteCount` | Done + tested | UI **Download server CSV** passes `pri`/`state`; CSV adds `noteCount` (count only — never note bodies); OpenAPI params |
| Compliance server `baseline`/`sev`/`plane` | Done + tested | `applyComplianceFindingFilters` on list + export; stats/baselines stay full; UI download passes active filters; unknown sev → 400 |
| Docs | Done | user-guide Tickets + Compliance + cookbook rows; this Loop 75 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Tickets / Compliance / ticketsExport / complianceExport |

### Loop 77 (2026-08-04) — AuthEvents result/service server filters + Licences idle export + Search recent

Residual pass on AuthEvents / Licences / SearchPanel (avoided Inventory/Mist/Overview/Tickets/Compliance):

| Item | Status | Anchors |
|---|---|---|
| AuthEvents server `result`/`service` | Done + tested | `applyAuthEventExactFilters` on list + export (after q/plane); UI Load more + **Download server CSV** pass both; OpenAPI params; unknown `result` is a no-op |
| Licences export `idle` parity | Done + tested | Default subscriptions CSV hides idle zero-assignment (UI match); `?idle=1` includes; UI download follows spare-capacity switch; renewals unaffected |
| SearchPanel recent + meta CSV | Done + tested | sessionStorage recent queries when the panel opens empty; Clear; export columns `label,kind,meta,path` |
| Docs | Done | user-guide cookbook Auth events / Licences + this Loop 77 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; authEventsExport / licensesExport / AuthEvents / SearchPanel targeted |

### Loop 78 (2026-08-04) — Devices bulk share + Site SLE metric deep-link + GreenLake review honesty

Independent of Loop 77 — different files (Devices / SiteSle / GreenLake):

| Item | Status | Anchors |
|---|---|---|
| Devices bulk selection bar | Done + tested | Unified-table selection raises **Export selected** / **Copy selection link** (`?names=`) / Clear — same contextual bar as Alerts |
| SiteDetail SLE metric share | Done + tested | `?section=sle&metric=<wire>` opens the drill drawer; **Copy drill link** shares both tokens; close drops `metric` only |
| GreenLake write review honesty | Done + tested | Hardened mode requires the review checkbox before any write sends `reviewConfirmed:true`; lab keeps direct writes; actions stay disabled until armed |
| Docs | Done | user-guide Devices bulk + SLE metric + GreenLake review + cookbook; this Loop 78 row |
| Typecheck + tests | Done | Devices / siteDetail/Sle / GreenLake targeted |

### Loop 79 (2026-08-04) — sendCsv column re-audit + tickets noteCount contract

Post-L75 residual safety pass (export column honesty / static contracts — no new export routes):

| Item | Status | Anchors |
|---|---|---|
| Re-grep all `sendCsv` sites | Done | No secret-shaped **column names** (`password`/`token`/`secret`/`body`/`payload`/`notes`/`credential`/HMAC). Residual free-text cells (`detail`/`message`/`error`/`before`/`after`) still covered by `redactExportCell` |
| Tickets `noteCount` only | Confirmed + fixed contract | Export still maps `Array.isArray(t.notes) ? t.notes.length : 0` — never note text. Comment restored to **no note bodies**; `csvExportSafety` allows `noteCount` + `.length` only |
| OpenAPI export parity | Pass | `exportOpenapiParity` 7/7 — catalog unchanged |
| csvExportSafety | Pass (after fix) | Was red on L75 drift (`/no note bodies/` phrase + blanket `\bnotes?\b` vs `t.notes.length`); 5/5 green |
| Docs | Done | this Loop 79 row |

**Finding:** No new risky columns to drop. Only fix was the L75 static-contract drift in `csvExportSafety.test.ts` + tickets export comment.

### Loop 81 (2026-08-04) — Sites health/plane server filters + deliveries result + Configure history kind/result

Independent residual pass (Sites / Notifications deliveries / Configure history — avoided L78–80 Devices/SiteSle/GreenLake/tickets CSV contracts):

| Item | Status | Anchors |
|---|---|---|
| Sites `q`/`plane`/`health` server filters | Done + tested | `applySiteListFilters` matches `planes[]` badge names + `tone`; list + export; UI Load more + **Download server CSV** pass all three; OpenAPI params |
| Notifications deliveries `result` | Done + tested | `filterDeliveryAttempts` on list + export (`delivered`/`failed`/`demo`; unknown = no-op); UI outcome Select + CSV query; OpenAPI |
| Configure history `kind`/`result` | Done + tested | `applyConfigureHistoryFilters` on list + export; drawer kind Select + result Input; server CSV carries filters; OpenAPI |
| Docs | Done | user-guide Sites / Delivery log / Change history + cookbook; this Loop 81 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; sitesListQuery / sitesExport / notificationsDeliveriesExport / configureHistory + Sites / NotificationsSection / Configure targeted |

### Loop 80 (2026-08-04) — Topology / ClearPass / AlertsRules export filter parity

Independent residual pass (export filter honesty — distinct from L78 Devices/SLE/GreenLake and L79 sendCsv audit):

| Item | Status | Anchors |
|---|---|---|
| Topology server CSV filter parity | Done + tested | Shared `filterTopologyGraph` (`shared/topologyGraph.ts`); `GET /api/topology/export` honours `q`/`plane`/`ghosts`; UI **Download server CSV** passes active filters; OpenAPI params |
| ClearPass export status/category + tab `part` | Done + tested | `applyClearPassEndpointExactFilters` on export; UI passes `status`/`category` and `part=endpoints\|sessions` from active tab; OpenAPI params |
| AlertsRules server CSV | Done + tested | `GET /api/alert-rules/export` (ahead of `/:id`); Policy tab **Download server CSV** when backend reachable (hidden on demo fallback); OpenAPI + `EXPECTED_EXPORTS` |
| Docs | Done | user-guide Topology/ClearPass/device-down cookbook + this Loop 80 row |

### Loop 83 (2026-08-04) — Devices/Clients server filters + Recommendations severity share

Independent residual pass (Devices / Clients / Recommendations — avoided L80–81 Topology/ClearPass/Sites/deliveries/history and L84 Alerts):

| Item | Status | Anchors |
|---|---|---|
| Devices `q`/`plane`/`type`/`site`/`state`/`issues` server filters | Done + tested | `applyDeviceListFilters` on list + export (comma OR on plane/site/state; claimedBy); UI Load more + **Download server CSV** pass active filters; OpenAPI |
| Clients `q`/`plane`/`medium`/`type`/`site`/`group`/`problems` server filters | Done + tested | `applyClientListFilters` on list + export (sources plane match); UI Load more + **Download server CSV**; OpenAPI |
| Recommendations severity share | Done + tested | UI severity Select + `?severity=` seed/write-back; path/export/panel pass-through (server already filtered) |
| Docs | Done | user-guide Devices/Clients/Recommendations cookbook + this Loop 83 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; devicesListQuery / clientsListQuery / devicesExport / clientsExport + Recommendations targeted |

### Loop 84 (2026-08-04) — Alerts sev/site server filters + recommendations export tests + export-part contracts

Independent tests+docs stream (Alerts / Recommendations / shared exports — avoided L83 Devices/Clients filters and L80–81 Topology/ClearPass/Sites/deliveries/history):

| Item | Status | Anchors |
|---|---|---|
| Alerts server `sev`/`site` (+ multi `plane`) | Done + tested | `applyAlertQueueFilters` OR-within-key comma tokens on `latest.sev` / `siteName|siteId` / `plane`; list + export; UI **Download server CSV** passes `q`/`plane`/`sev`/`site` from search + FacetFilter (list facets stay client-side for counts); OpenAPI params |
| Recommendations export filter tests | Done + tested | `GET /api/recommendations/export` CSV contract + severity/category/device parity with JSON list (limit ignored on export) |
| shared export `?part=` catalogs | Done + tested | `server/tests/sharedExports.test.ts` locks topology/licenses/greenlake/clearpass/overview/central part sets from `@hpe/shared` |
| Docs | Done | user-guide Navigation chrome (Shift/Incident strips) + Alerts cookbook `sev`/`site`; docs/README improvements-report link; this Loop 84 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; alertsExport / recommendations / exports + Alerts targeted |

### Loop 85 (2026-08-04) — Export catalog hygiene (24 paths)

Docs hygiene / export parity re-check after L80 added `GET /api/alert-rules/export`:

| Item | Status | Anchors |
|---|---|---|
| Export catalog (L53 table) | Verified | **24** paths including `GET /api/alert-rules/export`; explicit **Count: 24** |
| Path set vs code / OpenAPI / `EXPECTED_EXPORTS` | Verified | Identical bidirectional set (24) — `exportOpenapiParity` green |
| User-guide cookbook pointer | Done | catalog **24** routes through Loop 85 (was 23 through L69) |
| Code changes | None | docs-only continuity |
| Typecheck + test | Done | monorepo `npm run typecheck`; `exportOpenapiParity.test.ts` |

### Loop 86 (2026-08-04) — ClearPass endpoint filters + Licences plane + Central export part

Independent residual pass (ClearPass / Licences / Central — avoided L83–85 Devices/Clients/Alerts/Recommendations and L87 Mist/Device clients):

| Item | Status | Anchors |
|---|---|---|
| ClearPass endpoint page `q`/`status`/`category` | Done + tested | `filterClearPassEndpointRows` on `GET /api/clearpass/endpoints`; demo filters full fixture then pages; live filters vendor page only; UI passes filters on Next/Prev; OpenAPI |
| Licences `plane` filter share/export | Done + tested | UI plane Select + `?plane=` write-back; `applyLicensePlaneFilter` on subscriptions export; **Download server CSV** passes plane (+ idle) |
| Central export `part=device\|site` | Done + tested | `GET /api/central/export?part=`; UI **Download server CSV** sends `part=site` when `section=sites`; OpenAPI |
| Docs | Done | user-guide Licences/Central/ClearPass cookbook + this Loop 86 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; clearpassExport / licensesExport / centralExport + ClearPass / Licenses / Central targeted |

### Loop 87 (2026-08-04) — Mist export parts + device clients CSV + Recommendations category

Independent residual pass (Mist / Device detail / Recommendations — avoided L83–85 Devices/Clients list filters, Alerts, export-catalog hygiene-only):

| Item | Status | Anchors |
|---|---|---|
| Mist `part=devices\|rogues\|ap-stats` server CSV | Done + tested | `MIST_EXPORT_PARTS` in `shared/exports.ts`; `GET /api/mist/export` default devices; UI **Download rogues CSV** / **Download AP health CSV**; OpenAPI + sharedExports |
| Device clients server CSV | Done + tested | `GET /api/devices/{name}/clients/export` (+ optional `plane`/`serial`); DeviceDetail **Download server CSV** beside client Export; OpenAPI + `EXPECTED_EXPORTS` (25) |
| Recommendations category share | Done + tested | UI category Select + `?category=` seed/write-back; path/export/panel pass-through (server already filtered) |
| Docs | Done | user-guide Mist/Device detail/Recommendations cookbook + catalog **25**; this Loop 87 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; mistExport / devicesExport / sharedExports / exportOpenapiParity + Recommendations / nav targeted |


### Loop 89 (2026-08-04) — Overview export parts + RuntimeDebug filter + Tickets q=

Independent residual pass (Overview / Systems RuntimeDebug / Tickets — avoided L86–87 Mist/ClearPass/Licences/Central/device-clients and L90 Alerts/Auth/rules):

| Item | Status | Anchors |
|---|---|---|
| Overview multi-slice server CSV | Done + tested | `OVERVIEW_EXPORT_PARTS` = alerts\|planes\|sites\|changes; `part=sites` honours `health=`; UI **Download server CSV** pulls all four; OpenAPI + sharedExports |
| RuntimeDebug export `?filter=` | Done + tested | `GET /api/debug/runtime/export?filter=linked\|unlinked\|healthy\|degraded\|stale` matches `rtFilter`; integrity tallies always included; UI passes active filter |
| Tickets `q=` search share + server CSV | Done + tested | UI search box seeds/writes `?q=`; list/Load more/export/Copy view pass `q` with `pri`/`state` (server already filtered) |
| Docs | Done | user-guide Overview/Tickets/Runtime cookbook + this Loop 89 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; overviewExport / debugRuntime / sharedExports + Overview / Tickets targeted |

### Loop 90 (2026-08-04) — Alerts unacked/cleared + Auth range + alert-rules enabled

Independent residual pass (queue state / auth time window / policy enabled — avoided L83–87 Devices/Clients/Mist/ClearPass/export-catalog hygiene):

| Item | Status | Anchors |
|---|---|---|
| Alerts `unacked` / `cleared` server filters | Done + tested | `applyAlertQueueFilters` on `GET /api/alerts` + `/export`; UI Load more + **Download server CSV** send `unacked=1` and default `cleared=0`; OpenAPI |
| Auth events `range` server filter | Done + tested | `applyAuthEventRangeFilter` (`15m`/`1h`/`24h`/`7d`; undated rows always pass) on list + export; UI passes `range` on Load more + CSV; OpenAPI |
| Alert-rules `enabled` list/export filter | Done + tested | `filterAlertRulesByEnabled` on `GET /api/alert-rules` + `/export`; OpenAPI |
| Docs | Done | user-guide Alerts/Auth events/Policy cookbook + this Loop 90 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; alertsExport / authEventsExport / alertRules targeted |

### Loop 92 (2026-08-04) — SiteDetail devices CSV + Compliance q= + Inventory export q

Independent residual pass (SiteDetail / Compliance / Inventory — avoided L89–90 Overview multi-slice, RuntimeDebug filter, Tickets q, Alerts unacked/cleared, AuthEvents range, alert-rules enabled):

| Item | Status | Anchors |
|---|---|---|
| SiteDetail devices **Download server CSV** | Done + tested | live header → `GET /api/devices/export?site=<id\|name>` via `siteDevicesExportPath`; client **Export devices** unchanged; demo hides server download |
| Compliance `q=` findings search | Done + tested | `applyComplianceFindingFilters` substring on title/detail/rule/device/plane/baseline; list + export; UI Search + `?q=` share + CSV path; stats stay full; OpenAPI |
| Inventory **Download server CSV** honours search `q` | Done + tested | when explorer search ≥2 chars, UI passes `q=` to `/api/devices/export` (same Devices substring filter) |
| Docs | Done | user-guide Site detail / Compliance / Inventory cookbook + this Loop 92 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; complianceExport + SiteDetail / Compliance / Inventory targeted |

### Loop 93 (2026-08-04) — Silences + maintenance windows + device ports server CSV

Independent residual pass (suppression inventory + device port CSV — avoided L89–92 Overview/Tickets/Runtime/queue-filters/auth-range/rules-enabled/SiteDetail/Compliance/Inventory):

| Item | Status | Anchors |
|---|---|---|
| Silences server CSV + `active=` | Done + tested | `GET /api/silences/export` (+ optional `active=0\|1`); list filter parity; Silences tab **Export CSV** + **Download server CSV** (`active=1`); OpenAPI + `EXPECTED_EXPORTS` (28) |
| Maintenance windows server CSV | Done + tested | `GET /api/maintenance-windows/export` (+ optional `enabled=` / `state=`); Policy **Download server CSV** when backend reachable; OpenAPI |
| Device ports server CSV | Done + tested | `GET /api/devices/{name}/ports/export` (+ optional `plane`/`serial`); DeviceDetail demo + live PortsPanel **Download server CSV**; OpenAPI |
| Docs | Done | user-guide Alerts/Devices cookbook + catalog **28**; this Loop 93 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; silences / maintenance / devicesExport / exportOpenapiParity + AlertsMaintenance targeted |

### Loop 95 (2026-08-04) — ClearPass services + Configure inventory CSV + GreenLake q=

Independent residual pass (ClearPass services / Configure SSID inventory / GreenLake search — avoided L92–93 SiteDetail devices CSV, Compliance q, Inventory q, silences, maintenance-windows, device ports):

| Item | Status | Anchors |
|---|---|---|
| ClearPass services `part=services` + `q`/`enabled` | Done + tested | `CLEARPASS_EXPORT_PARTS` includes services; dedicated service-column CSV; Services tab filter bar + URL `enabled=` + **Download server CSV**; OpenAPI |
| Configure inventory server CSV | Done + tested | `GET /api/configure/export?part=ssids\|ports\|vlans` (+ optional `q=`); UI **Download server CSV** beside client exports; OpenAPI + `EXPECTED_EXPORTS` (**31**) |
| GreenLake `q=` filter share/export | Done + tested | workspace search + `?q=` write-back; tables/client CSV filter; server export honours `q=`; share URLs carry `q` |
| Docs | Done | user-guide ClearPass/Configure/GreenLake cookbook + catalog **31**; this Loop 95 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; clearpassExport / configureExport / greenlakeExport / sharedExports / exportOpenapiParity + ClearPass / Configure / GreenLake targeted |

### Loop 96 (2026-08-04) — GreenLake section CSV + SSL hosts + config-backups export


Independent residual pass (workspace/section CSV honesty + certificate watch + drift roster — avoided L89–93 Overview multi-slice, silences/windows/ports, Compliance findings `q`, Alerts queue filters):

| Item | Status | Anchors |
|---|---|---|
| GreenLake **Download server CSV** respects `?section=` | Done + tested | `sectionToExportPart` → `part=users\|locations\|roles`; UI filename follows slice; default users when no section |
| SSL certificate watch server CSV | Done + tested | `GET /api/notifications/ssl-hosts/export` (host/port/probe outcome; no PEMs); Systems Notifications **Download server CSV**; OpenAPI + `EXPECTED_EXPORTS` (30) |
| Config backups drift roster server CSV | Done + tested | `GET /api/config-backups/export` (+ optional `drift=`); Compliance drift section **Download server CSV** sends `drift=1`; roster metadata only — never config bodies; OpenAPI |
| Docs | Done | user-guide GreenLake/Compliance/Systems cookbook + catalog **30**; this Loop 96 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; greenlake / notificationsEmail / configBackup / exportOpenapiParity + GreenLake / Compliance / NotificationsSection targeted |

### Loop 98 (2026-08-04) — Mist SLE + Site SLE + device trends server CSV

Independent residual pass (Mist / Site SLE / Device trends — avoided L95–96 ClearPass services, Configure inventory, GreenLake q/section, SSL hosts, config-backups):

| Item | Status | Anchors |
|---|---|---|
| Mist `part=sle` server CSV | Done + tested | `MIST_EXPORT_PARTS` includes `sle`; estate SLE headlines; UI **Download SLE CSV**; OpenAPI + sharedExports |
| Site SLE metrics + drill server CSV | Done + tested | `GET /api/sites/{siteId}/sle/export` + `…/sle/{metric}/export`; SiteDetail **Download server CSV** on section + drill drawer; OpenAPI |
| Device trends server CSV | Done + tested | `GET /api/devices/{name}/trends/export?part=hardware\|interfaces\|ap` (+ optional `metric`/window/`plane`/`serial`); HardwareTrendsPanel **Download server CSV**; OpenAPI + `DEVICE_TRENDS_EXPORT_PARTS` |
| Docs | Done | user-guide Mist/Site detail/Device trends cookbook + catalog paths; this Loop 98 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; mistExport / siteDetailMist / deviceTrendsRoutes / sharedExports / exportOpenapiParity + Mist / Sle / trends targeted |

### Loop 99 (2026-08-04) — Central webhooks + hooks events + visual-references CSV

Independent residual pass (webhook management / inbound receiver journal / visual reference metadata — avoided L92–96 SiteDetail/Compliance/Inventory/silences/windows/ports/ClearPass services/Configure inventory/GreenLake section/SSL/config-backups):

| Item | Status | Anchors |
|---|---|---|
| Central webhooks server CSV | Done + tested | `GET /api/central/webhooks/export` (+ optional `q=`); summary fields only (no secrets/HMAC); Systems Central config **Download server CSV**; OpenAPI + `EXPECTED_EXPORTS` (**37**) |
| Inbound hooks events server CSV + filters | Done + tested | `GET /api/hooks/events/export` (+ optional `limit`/`source=`/`q=`); list parity filters; Received events **Download server CSV**; OpenAPI |
| Visual references metadata server CSV | Done + tested | `GET /api/visual-references/export` (+ optional `kind`+`id`/`plane`); metadata only — never binary assets; panel **Download server CSV**; OpenAPI |
| Docs | Done | user-guide Systems/webhooks/visual cookbook + catalog **37**; this Loop 99 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; centralWebhooksExport / hooksEventsExport / visualReferences / exportOpenapiParity targeted |

### Loop 100 (2026-08-04) — Systems roster + Licences q= + Tickets site=

Independent residual pass (Systems health roster / Licences text search / Tickets site Select — avoided L98 Mist/Site SLE/device trends and L99 webhooks/hooks/visual):

| Item | Status | Anchors |
|---|---|---|
| Systems roster server CSV | Done + tested | `GET /api/systems/export` (+ optional `q=`/`health=`/`linked=`); name/planeId/kind/health/scope/sync/counts only — no credentials/notes/call paths; Systems **Download server CSV**; OpenAPI + `EXPECTED_EXPORTS` (**42**) |
| Licences `q=` text filter | Done + tested | subscriptions export + UI filter strip write-back `?q=`; name/sku/plane/term/status substring; rides **Download server CSV** |
| Tickets `site=` exact filter | Done + tested | list + export + URL Select write-back; exact siteName/siteId (case-insensitive); Load more / CSV parity |
| Docs | Done | user-guide Systems/Licences/Tickets cookbook + catalog **42**; this Loop 100 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; systemsExport / licensesExport / ticketsExport / exportOpenapiParity + Systems / Licenses / Tickets targeted |

### Loop 101 (2026-08-04) — Diagnostics history + metrics + notification outbox CSV

Independent residual pass (active-diagnostics audit / sparkline samples / demo outbox metadata — avoided L99 webhooks/hooks/visual and L96 SSL/config-backups):

| Item | Status | Anchors |
|---|---|---|
| Diagnostics history server CSV | Done + tested | `GET /api/diagnostics/history/export` (+ optional `device`/`plane`/`state` on list + export); target always `[redacted]`; DiagnosticsPanel **Download server CSV**; OpenAPI |
| Metrics series/anomalies server CSV | Done + tested | `GET /api/metrics/export?part=series\|anomalies` (`METRICS_EXPORT_PARTS`); Overview **Download metrics CSV** (both parts); OpenAPI + sharedExports |
| Notification webhook + fleet-report outbox CSV | Done + tested | `GET /api/notifications/outbox/export` (event summaries — never bodies); `GET /api/notifications/report/export` (subject/recipients only — never text/html); Systems Notifications **Download server CSV**; OpenAPI + `EXPECTED_EXPORTS` (**41** at ship; later **42** with Loop 100 systems roster) |
| Docs | Done | user-guide Diagnostics/Overview/Systems cookbook + catalog **41**; this Loop 101 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; diagnosticsHistoryExport / metricsExport / notificationsOutboxExport / exportOpenapiParity / sharedExports + DiagnosticsPanel / Overview / NotificationsSection targeted |

### Loop 102 (2026-08-04) — Configure history ticket + search-index CSV + Central export parts

Independent residual pass (Configure audit ticket filter / global search server CSV / Central firmware·WLAN·alerts slices — avoided L100 systems/licences-q/tickets-site and L101 diagnostics/metrics/outbox/report):

| Item | Status | Anchors |
|---|---|---|
| Configure history `ticket=` filter | Done + tested | list + export exact case-insensitive ticket; Change history drawer ticket field + **Download server CSV** write-back; OpenAPI |
| Search-index server CSV | Done + tested | `GET /api/search-index/export` (+ optional `q=`/`kind=`); SearchPanel **Download server CSV**; OpenAPI + `EXPECTED_EXPORTS` (**43**) |
| Central export `part=firmware\|wlans\|alerts` | Done + tested | dedicated column sets (no PSKs/secrets); UI **Download server CSV** follows `section=`; `CENTRAL_EXPORT_PARTS` + sharedExports / OpenAPI |
| Docs | Done | user-guide Configure/Search/Central cookbook + catalog **43**; this Loop 102 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; configureHistory / searchIndexExport / centralExport / sharedExports / exportOpenapiParity + Configure / SearchPanel / Central targeted |

### Loop 103 (2026-08-04) — CSV redaction hardening + export docs parity + safety contracts

Independent residual pass (tests + docs focus — avoided new plane feature surface; tightened export safety and catalog drift):

| Item | Status | Anchors |
|---|---|---|
| CSV cell PEM + cookie redaction | Done + tested | `redactExportCell` collapses PEM/private-key blocks and `Cookie:` header material; bare labels untouched; `csvExportSafety` |
| Dual `Content-Disposition` on every CSV | Done + tested | `contentDispositionAttachment` emits ASCII `filename=` + RFC 5987 `filename*=UTF-8''…`; `sendCsv` uses it |
| Export catalog ↔ docs parity | Done + tested | `exportOpenapiParity` asserts docs mention every `EXPECTED_EXPORTS` path (**43**) and invent none; user-guide cookbook count **43** + SSE inventory / search-index rows |
| Expanded column-safety static contracts | Done + tested | systems / metrics / diagnostics history / notification outbox+report / visual-references `sendCsv` headers never ship secrets/bodies/PEMs |
| Shared Central `?part=` catalog coverage | Done + tested | `CENTRAL_EXPORT_PARTS` (`device\|site\|firmware\|wlans\|alerts`) in `sharedExports` + export catalog note |
| Docs | Done | user-guide cookbook + catalog Central row + this Loop 103 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; csvExportSafety / exportOpenapiParity / sharedExports targeted |

### Loop 104 (2026-08-04) — Site rogues CSV + Mist wlans/licenses parts + Topology type=

Independent residual pass (SiteDetail rogues / Mist WLAN+licence slices / Topology device-class filter — avoided L102 configure history ticket, search-index export, Central parts, and L103 CSV redaction):

| Item | Status | Anchors |
|---|---|---|
| Site rogues server CSV | Done + tested | `GET /api/sites/{siteId}/rogues/export` (on-LAN first; empty = nothing heard); SiteRogueAps live **Download server CSV**; OpenAPI + `EXPECTED_EXPORTS` (**44**) |
| Mist `part=wlans\|licenses` | Done + tested | `MIST_EXPORT_PARTS` extended; WLAN inventory (no PSKs) + per-site usage tallies; header **Download WLANs/licences CSV** + section buttons; OpenAPI + sharedExports |
| Topology `type=` filter | Done + tested | Shared `filterTopologyGraph` exact node.type; UI Select + URL write-back; export/share/server CSV parity; OpenAPI `type` param |
| Docs | Done | user-guide Topology/Mist/Site detail cookbook + catalog **44**; this Loop 104 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; siteDetailMist / mistExport / topologyExport / sharedExports / exportOpenapiParity + Topology / Mist / RogueAps targeted |

### Loop 105 (2026-08-04) — Shared query helpers + backup filters + CSV Basic/JWT redaction

Independent residual pass (query parse hygiene / config-backup filter parity / free-text CSV redaction; catalog remains **44** after Loop 104 site-rogues path):

| Item | Status | Anchors |
|---|---|---|
| Shared query helpers | Done + tested | `server/src/lib/query.ts` — `queryString` / `queryFlag` / `queryOneOf` (unknown → honest no-op); `queryHelpers` |
| Config-backups `q`/`plane`/`status` | Done + tested | list + `GET /api/config-backups/export` share `filterConfigBackupRows`; summary stays unfiltered estate rollup; OpenAPI params; `configBackup` |
| CSV Basic / JWT / Set-Cookie redaction | Done + tested | `redactExportCell` collapses `Basic <b64>`, compact `eyJ…` JWTs, and `Set-Cookie:`; bare "basic"/"cookie" labels untouched; `csvExportSafety` |
| Docs | Done | user-guide Compliance cookbook + catalog config-backups row + this Loop 105 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; queryHelpers / configBackup / csvExportSafety / exportOpenapiParity targeted |

### Loop 107 (2026-08-04) — Systems roster UI filters + Auth method= + GreenLake user status=

Independent residual pass (filter parity on Systems / Auth events / GreenLake; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Systems roster triage bar | Done + tested | UI `q`/`health`/`linked` write-back; client match mirrors export; **Download server CSV** forwards filters; `Systems.tsx` helpers + `Systems.test` |
| Auth events `method=` | Done + tested | exact case-insensitive on list+export; UI Select + URL + Load more; OpenAPI; `authEventsScreen` / `AuthEvents` / `authEventsExport` |
| GreenLake user `status=` | Done + tested | export users exact status; UI Select + share URL; OpenAPI; `greenlake.ts` helpers / `GreenLake` / export tests |
| Docs | Done | user-guide cookbook Auth/Systems/GreenLake rows + this Loop 107 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; targeted auth/systems/greenlake tests |

### Loop 108 (2026-08-04) — CSV formula neutralization + queryInt + column-safety contracts

Independent residual pass (tests + docs focus — no new export routes; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| CSV formula-injection neutralization | Done + tested | `neutralizeCsvFormula` prefixes `= + - @` / TAB / CR lead-ins after redaction; pure signed numbers untouched; `csvLines` pipeline; `csvExportSafety` |
| Shared `queryInt` helper | Done + tested | `server/src/lib/query.ts` — positive int / optional `max` / garbage → null; hooks events list + export adopt it; `queryHelpers` |
| Expanded column-safety contracts | Done + tested | hooks events / central webhooks / config-backups / ssl-hosts static contracts + whole-tree `sendCsv` header scan forbids secret-shaped column names; `csvExportSafety` |
| Docs | Done | security CSV section formula note; user-guide cookbook Loop 108; this Loop 108 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; csvExportSafety / queryHelpers / exportOpenapiParity / hooksEventsExport targeted |

### Loop 110 (2026-08-04) — Search kind + Compliance fix= + UXI severity=

Independent residual pass (SearchPanel / Compliance / UXI filter parity; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| SearchPanel `kind=` filter | Done + tested | UI Result kind Select filters local + inventory hits; **Download server CSV** forwards `kind=` (server already had export filter); `SearchPanel` helpers + `SearchPanel.test` |
| Compliance `fix=` filter | Done + tested | list+export exact fix-class (`auto`/`manual`/`window`/`ssh scan`); unknown → 400; UI Select + URL write-back + server CSV; OpenAPI; `complianceScreen` / `Compliance` / `complianceExport` |
| UXI `severity=` filter | Done + tested | list+export sensors with ≥1 issue of severity (`critical`/`warning`/`info`); unknown → no-op; UI Select + URL + Load more; OpenAPI; `uxiScreen` / `Uxi` / `uxiListQuery` / `uxiExport` |
| Docs | Done | user-guide cookbook Compliance/UXI/Search rows + this Loop 110 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; targeted SearchPanel / Compliance / UXI web+server tests |

### Loop 111 (2026-08-04) — queryTokens + silences q= + alert-rules deviceType=

Independent residual pass (shared multi-value query parse / silence triage text filter / rule device-type filter; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Shared `queryTokens` helper | Done + tested | `server/src/lib/query.ts` — comma-split / trim / lowercase; empty → `[]` (honest no-op); Alerts `plane`/`sev`/`site` adopt it; `queryHelpers` |
| Silences `q=` list/export filter | Done + tested | `filterSilencesByActive` + `queryFlag`/`queryString` on id/plane/device/titleContains/reason; OpenAPI; `silences` |
| Alert-rules `deviceType=` list/export filter | Done + tested | `filterAlertRulesByEnabled` + `normalizeDeviceTypeFilter` aliases; unknown → no-op; `queryFlag` for enabled; OpenAPI; `alertRules` |
| Docs | Done | user-guide Alerts cookbook + alert-rules prose; export catalog rows; this Loop 111 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; queryHelpers / silences / alertRules / exportOpenapiParity targeted |

### Loop 113 (2026-08-04) — Clients health= + Licences status= + Devices query helpers

Independent residual pass (Clients session health filter / Licences status Select / Devices adopt shared query parsers; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Clients `health=` filter | Done + tested | list+export exact case-insensitive health word; UI Select + URL + Load more + server CSV; OpenAPI; `clientsScreen` / `Clients` / `clientsListQuery` |
| Licences `status=` filter | Done + tested | subscriptions export + UI Select write-back `?status=`; exact after idle-hide; OpenAPI; `licensesScreen` / `Licenses` / `licensesExport` |
| Devices shared query helpers | Done + tested | `applyDeviceListFilters` uses `queryTokens`/`queryString`/`queryFlag` (replaces local `csvQueryTokens`); issues accepts yes/on; `devicesListQuery` |
| Docs | Done | user-guide Clients/Licences cookbook + export catalog rows; this Loop 113 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; clientsListQuery / licensesExport / devicesListQuery targeted |

### Loop 114 (2026-08-04) — maintenance q= + diagnostics q= + recommendations queryOneOf

Independent residual pass (Policy window triage text / diagnostics history text filter / honest rec severity·category allow-lists; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Maintenance windows `q=` list/export | Done + tested | `filterMaintenanceWindows` + `queryFlag`/`queryOneOf`/`queryString` on id/reason/plane/device/site/titleSubstring; OpenAPI; `maintenance` |
| Diagnostics history `q=` list/export | Done + tested | `filterDiagnosticHistoryEntries` + shared `queryString`; substring on id/device/serial/plane/operation/state; OpenAPI; `diagnosticsHistoryExport` |
| Recommendations severity/category allow-list | Done + tested | `parseRecQuery` via `queryString`/`queryOneOf`; unknown severity/category → no-op; non-int limit → 400; OpenAPI enums; deliveries `result=` also on `queryOneOf`; `recommendations` |
| Docs | Done | user-guide cookbook Alerts/Policy + diagnostics + recommendations rows; export catalog; this Loop 114 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; maintenance / diagnosticsHistoryExport / recommendations / exportOpenapiParity targeted |

### Loop 115 (2026-08-04) — Auth role= + Mist WLANs q/enabled + ClearPass enabled queryFlag

Independent residual pass (Auth events role Select / Mist WLAN triage filters / ClearPass services enabled on/off parity; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Auth events `role=` filter | Done + tested | list+export exact case-insensitive role; UI Select + URL + Load more + server CSV; OpenAPI; `authEventsScreen` / `AuthEvents` / `authEventsExport` |
| Mist WLANs `q=` + `enabled=` | Done + tested | `filterMistWlanRows` + `queryString`/`queryFlag`; UI strip + share + header/section CSV; OpenAPI; `mistScreen` / `mist/wlans` / `mistExport` |
| ClearPass services `enabled` queryFlag | Done + tested | `on`/`off`/`yes`/`no` parity via shared `queryFlag`; endpoint filters via `queryString`; OpenAPI; `clearpassScreen` / `ClearPass` / `clearpassExport` |
| Docs | Done | user-guide Auth/Mist/ClearPass cookbook + export catalog rows; this Loop 115 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; targeted auth/mist/clearpass/topology tests |

### Loop 116 (2026-08-04) — deliveries q= + ssl-hosts q= + Sites/Tickets/Topology query helpers

Independent residual pass (Notifications triage text filters / residual shared query parsers; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Deliveries `q=` list/export | Done + tested | `filterDeliveryAttempts` + `queryString` on endpoint/title/error/eventKind/fingerprint/result/httpCode/test; UI Search + server CSV; OpenAPI; `notificationsDeliveriesExport` / `NotificationsSection` |
| SSL-hosts `q=` list/export | Done + tested | `filterSslHosts` + `queryString` on host/port/probe error/notAfter/ok\|fail; UI Search + server CSV; OpenAPI; `notificationsEmail` / `NotificationsSection` |
| Sites/Tickets/Topology shared query helpers | Done + tested | Sites `queryString`/`queryOneOf` health; Tickets `queryString` pri/state/site; Topology `queryString`/`queryFlag`/`queryOneOf` part (ghosts accepts yes/on); `sitesListQuery` / `ticketsListQuery` / `topologyExport` |
| Docs | Done | user-guide Systems cookbook + export catalog rows; this Loop 116 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; targeted notifications / sites / tickets / topology / NotificationsSection tests |

### Loop 118 (2026-08-04) — Alerts/Systems/UXI shared query helpers

Independent residual pass (flag vocabulary parity + residual shared parsers; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Alerts `unacked`/`cleared`/`q` query helpers | Done + tested | `applyAlertQueueFilters` uses `queryString`/`queryFlag`/`queryTokens`; unacked accepts yes/on; cleared accepts yes/on/no/off; OpenAPI; `alertsScreen` / `alertsExport` |
| Systems roster shared query helpers | Done + tested | `applySystemsRosterFilters` uses `queryString`/`queryOneOf`/`queryFlag`; linked accepts yes/on/no/off; OpenAPI; `systemsScreen` / `systemsExport` |
| UXI sensor shared query helpers | Done + tested | `applyUxiSensorFilters` uses `queryString`/`queryOneOf` for status/site/severity; unknown → no-op; `uxiScreen` / `uxiListQuery` |
| Docs | Done | user-guide Alerts/Systems/UXI cookbook + export catalog rows; this Loop 118 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; targeted alertsExport / systemsExport / uxiListQuery |

### Loop 119 (2026-08-04) — outbox q= + report outbox q= + Configure history queryString

Independent residual pass (Notifications demo-outbox triage text / Configure audit shared parser; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Webhook demo outbox `q=` list/export | Done + tested | `filterNotificationOutbox` + `queryString` on endpoint/title/eventKind/fingerprint/plane/device/site/sev/id — never payload bodies; OpenAPI; `notificationsOutboxExport` |
| Fleet-report outbox `q=` export | Done + tested | `filterReportOutbox` + `queryString` on subject/recipients/id — never email text/html; OpenAPI; `notificationsOutboxExport` |
| Configure history shared `queryString` | Done + tested | `applyConfigureHistoryFilters` kind/result/ticket via `queryString` (non-string → honest no-op); `configureHistory` |
| Docs | Done | user-guide Systems/Configure cookbook + export catalog rows; this Loop 119 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; targeted outbox + configureHistory tests |

### Loop 121 (2026-08-04) — Overview / GreenLake / Configure export queryString

Independent residual pass (Overview/GreenLake/Configure inventory CSV shared parsers; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Overview export `part`/`health` queryString | Done + tested | `parseOverviewHealth(req)` + `queryString` on part (empty → alerts); unknown still 400; `overviewExport` |
| GreenLake export `part`/`q`/`status` queryString | Done + tested | `greenlake.ts` export route; non-string → honest default/no-op; `greenlakeExport` |
| Configure inventory export `part`/`q` queryString | Done + tested | `parseConfigureExportPart(req)` + `queryString` q; singular aliases kept; `configureExport` |
| Docs | Done | user-guide cookbook + catalog note; this Loop 121 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; targeted overviewExport / greenlakeExport / configureExport |

### Loop 122 (2026-08-04) — Compliance / Search / listQuery shared queryString

Independent residual pass (shared parser parity on Compliance findings, global search-index CSV, and the multi-screen `applyListFilters` helper; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Compliance findings shared `queryString` | Done + tested | `applyComplianceFindingFilters` baseline/sev/plane/fix/q via `queryString` (non-string → honest no-op; unknown sev/fix still 400); `complianceScreen` / `complianceExport` |
| Search-index shared `queryString` | Done + tested | `applySearchIndexFilters` q/kind via `queryString`; unknown kind → empty; `searchScreen` / `searchIndexExport` |
| Shared list `applyListFilters` queryString | Done + tested | `listQuery.applyListFilters` q/plane via `queryString` (AuthEvents/Tickets/UXI/ClearPass + inventory lists); `listQuery` |
| Docs | Done | user-guide Compliance/Search cookbook + export catalog notes; this Loop 122 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; targeted complianceExport / searchIndexExport / listQuery |

### Loop 124 (2026-08-04) — Systems section shares + sessions/alerts export

Independent residual pass (user-visible share/export polish; catalog stays **44** — client-side CSVs only):

| Item | Status | Anchors |
|---|---|---|
| Systems section **Copy section link** | Done + tested | Portal / Identity / Assistant / Notifications share `?section=` + `#systems-section-*`; aliases (`oidc`→identity, `chat`→assistant, `runtime`→runtime-debug); `systems/share` + Identity/Notifications tests |
| DeviceDetail **Export sessions** | Done + tested | RecordedSessions metadata CSV (`openedAt`/`user`/`target`/`device`/`file` basename only — never transcript bodies); `RecordedSessions` |
| SiteDetail **Export alerts** + section share | Done + tested | Open-here open+silenced summary CSV + **Copy section link** (`section=alerts`); `siteOpenAlertsExportRows` / `SiteDetail` |
| Docs | Done | user-guide Systems/Device/Site cookbook; this Loop 124 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; targeted systems share / RecordedSessions / SiteDetail / IdentityProvider |

### Loop 125 (2026-08-04) — Overview last-hour strip + shell theme/density

Independent residual pass (user-visible chrome — avoided further queryString migrations; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Overview **Last hour** delta strip | Done + tested | `overviewHourDeltas` from metrics plane series; chips → Devices/Alerts/Clients; hidden when no span; `Overview.tsx` / `overviewDeltas` |
| Topbar light/dark theme toggle | Done + tested | `hpe-nt.theme` + `html[data-nd-theme]`; `AppShell` helpers + button |
| Shell-wide density attribute | Done + tested | `SettingsProvider` sets `html[data-nd-density]` from Comfortable/Compact |
| Docs | Done | user-guide Overview/shell notes; this Loop 125 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; overviewDeltas + AppShell theme + Settings density + Overview strip |

### Loop 127 (2026-08-04) — Clients bulk + Live badge honesty + AuthEvents polish

Independent residual pass (user-visible list/auth polish; catalog stays **44** — client-side CSVs only):

| Item | Status | Anchors |
|---|---|---|
| Clients **Export selected** bulk bar | Done + tested | Keyboard `x` selection raises bulk bar (Export selected + Clear); filtered empty offers **Clear filters**; `Clients.tsx` |
| **LIVE badge honesty** (Clients + Auth events) | Done + tested | Badge when `sectionLive` (pure live **or** blend), not blend-only; pure live no longer omits LIVE |
| Auth events filter chips + subtable export + bulk | Done + tested | Removable `nt-filter-chips` + Clear all / empty **Clear filters**; fail-reasons + policy-services **Export CSV**; selection bulk Export selected; `?` keyboard overlay; `AuthEvents.tsx` |
| Docs | Done | user-guide Clients/Auth keyboard + cookbook notes; this Loop 127 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Clients + AuthEvents Loop 127 tests |

### Loop 128 (2026-08-04) — Overview licence chip + search screen jumps + shift freshness

Independent residual pass (three operator-visible chrome improvements; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Overview **licences ≤60d** attention chip | Done + tested | `overviewLicenceChip` / `overviewActionChips`; chip → `/licenses`; strip shows with or without hour deltas; `Overview.tsx` / `overviewDeltas` |
| ⌘K **Go to screen** jumps | Done + tested | `matchScreenJumps` from `NAV_GROUPS` + aliases (`go licences`, `recs`, …); screen hits rank above estate; `screenJumps.ts` / `SearchPanel` |
| Shift strip **relative freshness** + polite ARIA live | Done + tested | `Fresh 4m ago` via `relativeAge`; `shiftStatusSummary` in `aria-live=polite`; `ShiftStrip.tsx` |
| Docs | Done | user-guide Navigation + filter cookbook; this Loop 128 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; overviewDeltas / Overview / screenJumps / SearchPanel / ShiftStrip |

### Loop 134 (2026-08-04) — Clients/Auth Copy MACs + Shift P1 severity deep-link

Independent residual pass (three operator-visible list/chrome improvements; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Clients bulk **Copy MACs** | Done + tested | newline-joined unique inventory MACs from selection (Devices **Copy serials** pattern); `Clients.tsx` bulk bar |
| Auth events bulk **Copy MACs** | Done + tested | unique endpoint MACs from selection for NAC paste; `AuthEvents.tsx` bulk bar |
| Shift strip **P1 → `/alerts?sev=P1`** | Done + tested | critical chip lands on severity-filtered queue (not bare Alerts); `ShiftStrip.tsx` |
| Docs | Done | user-guide Navigation + Clients/Auth cookbook rows; this Loop 134 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Clients / AuthEvents / ShiftStrip Loop 134 tests |

### Loop 131 (2026-08-04) — ⌘K quick actions + action deep-link cues + plane poll deltas

Independent residual pass (three operator-visible chrome improvements; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| ⌘K **quick actions** (raise ticket / silence / diagnostic) | Done + tested | `matchQuickActions` → `/alerts?…&action=ticket\|silence`, `/devices?action=diagnostics`; ranks above screen jumps; `quickActions.ts` / `SearchPanel` |
| **Action deep-link cues** on Alerts + Devices | Done + tested | one-shot `?action=` consume + dismissible info banner (`actionDeepLink.ts`); Alerts tab seeds queue/silences; Devices diagnostics cue |
| Shift strip **plane poll delta** ARIA | Done + tested | `planePollDeltaAnnouncement` enter/leave; second polite live region; baseline not announced; `planePollDelta.ts` / `ShiftStrip` |
| Docs | Done | user-guide Navigation + ⌘K cookbook + Shift strip; this Loop 131 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; quickActions / actionDeepLink / planePollDelta / SearchPanel / ShiftStrip |

### Loop 130 (2026-08-04) — Sites health chips + Alerts/Devices bulk polish

Independent residual pass (three operator-visible list improvements; catalog stays **44**):

| Item | Status | Anchors |
|---|---|---|
| Sites **Health** filter chips | Done + tested | chip row counts ok/warn/bad/stale over plane+q universe; toggles same `?health=` as header Select; `Sites.tsx` |
| Alerts bulk **Copy selection link** (`?fps=`) | Done + tested | bulk bar + clearable fps chip; fingerprint deep-link filters queue; `Alerts.tsx` |
| Devices bulk **Copy serials** | Done + tested | newline-joined inventory serials from selection; skips rows without serial; `Devices.tsx` |
| Docs | Done | user-guide Copy view link + cookbook rows; this Loop 130 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Sites / Alerts / Devices Loop 130 tests |

### Loop 133 (2026-08-04) — Tickets / Compliance / Licences filter chips

Independent residual pass (three operator-visible list improvements; catalog stays **44** — avoided Sites health chips, Alerts fps, Devices serials, ⌘K quick actions, action landing cues, plane poll ARIA):

| Item | Status | Anchors |
|---|---|---|
| Tickets **Priority** chips | Done + tested | P1/P2/P3 counts over q+state+site universe; toggles same `?pri=`; empty **Clear filters**; `Tickets.tsx` |
| Compliance **Severity** chips | Done + tested | High/Med/Low counts over baseline+plane+fix+q; toggles same `?sev=`; empty **Clear filters**; `Compliance.tsx` |
| Licences **Status** chips | Done + tested | status counts over plane+q+idle universe; toggles same `?status=`; empty **Clear filters**; `Licenses.tsx` |
| Docs | Done | user-guide Tickets / Licences / cookbook + Copy view link notes; this Loop 133 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Tickets / Compliance / Licenses Loop 133 tests |

### Loop 136 (2026-08-04) — ClearPass / GreenLake / Overview filter chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Tickets pri, Compliance sev, Licences status, Clients/Auth Copy MACs, Shift P1, and UXI/Recommendations/Topology chips from adjacent loops):

| Item | Status | Anchors |
|---|---|---|
| ClearPass endpoint **Status** chips | Done + tested | Known/Unknown/Disabled counts over q+category universe; toggles same `?status=`; `ClearPass.tsx` endpoints tab |
| GreenLake member **Status** chips | Done + tested | VERIFIED/PENDING/… counts over q universe; toggles same `?status=`; `GreenLake.tsx` |
| Overview Sites preview **Health** chips | Done + tested | ok/warn/bad/stale counts over sites preview; toggles same `?health=` as Select; `Overview.tsx` |
| Docs | Done | user-guide Overview / ClearPass / GreenLake cookbook rows; this Loop 136 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; ClearPass / GreenLake / Overview Loop 136 tests |

### Loop 137 (2026-08-04) — UXI / Recommendations / Topology filter chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Sites health, Tickets priority, Compliance severity, Licences status chips already shipped):

| Item | Status | Anchors |
|---|---|---|
| UXI **Status** chips | Done + tested | Online/Offline/Idle/Issues/Unknown counts over loaded q+site+severity; toggles same `?status=`; empty **Clear filters** includes severity; `Uxi.tsx` |
| Recommendations **Severity** chips | Done + tested | Warning/Suggestion/Info counts over device+site+client+category universe; toggles same `?severity=`; header **Clear filters**; `Recommendations.tsx` |
| Topology **Type** chips | Done + tested | Device-class counts over q+plane+ghosts; toggles same `?type=`; **Clear filters** also drops `type`; `Topology.tsx` |
| Docs | Done | user-guide Topology / Recommendations / UXI cookbook rows; this Loop 137 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Uxi / Recommendations / Topology Loop 137 tests |

### Loop 140 (2026-08-04) — Clients health / Tickets state / Mist WLAN enabled chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Sites plane, Auth result, Systems health from Loop 139 and UXI/Recommendations/Topology chips from Loop 137):

| Item | Status | Anchors |
|---|---|---|
| Clients **Health** chips | Done + tested | Dynamic health-word counts over non-health filters; toggles same `?health=`; `Clients.tsx` |
| Tickets **State** chips | Done + tested | Open queue/Open/In progress/Waiting/Resolved counts over q+pri+site; toggles same `?state=`; `Tickets.tsx` |
| Mist WLANs **Enabled** chips | Done + tested | Enabled/Disabled counts over q universe; toggles same `?enabled=`; `mist/wlans.tsx` |
| Docs | Done | user-guide Clients / Tickets / Mist cookbook rows; this Loop 140 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Clients / Tickets / Mist Loop 140 tests |

### Loop 142 (2026-08-04) — Licences plane / Topology plane / ClearPass category chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Sites plane, Auth result, Systems health, Clients health, Tickets state, Mist enabled chips from Loops 139–140):

| Item | Status | Anchors |
|---|---|---|
| Licences **Plane** chips | Done + tested | Dynamic plane counts over status+q+idle universe; toggles same `?plane=`; `Licenses.tsx` |
| Topology **Plane** chips | Done + tested | Plane badge counts over q+type+ghosts; toggles same `?plane=`; **Clear filters** drops `plane`; `Topology.tsx` |
| ClearPass endpoint **Category** chips | Done + tested | Category counts over q+status universe; toggles same `?category=`; `ClearPass.tsx` endpoints tab |
| Docs | Done | user-guide Topology / Licences / ClearPass cookbook rows; this Loop 142 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Licenses / Topology / ClearPass Loop 142 tests |

### Loop 143 (2026-08-04) — Clients medium / Auth method / Compliance plane chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Licences/Topology/ClearPass category from Loop 142 and Clients health / Tickets state / Mist enabled from Loop 140):

| Item | Status | Anchors |
|---|---|---|
| Clients **Medium** chips | Done + tested | Wired/Wireless counts over non-medium filters; toggles same `?medium=`; `Clients.tsx` |
| Auth events **Method** chips | Done + tested | Dynamic method counts over q+result+service+role+plane+range; toggles same `?method=`; `AuthEvents.tsx` |
| Compliance **Plane** chips | Done + tested | Plane badge counts over baseline+sev+fix+q; toggles same `?plane=`; `Compliance.tsx` |
| Docs | Done | user-guide Clients / Auth events / Compliance cookbook rows; this Loop 143 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Clients / AuthEvents / Compliance Loop 143 tests |

### Loop 145 (2026-08-04) — Devices issues / Alerts severity / Systems linked chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Licences plane / Topology plane / ClearPass category, Clients medium / Auth method / Compliance plane from Loop 143):

| Item | Status | Anchors |
|---|---|---|
| Devices **Issues** chips | Done + tested | Issues/Clean counts over type+q+names+state; toggles same `?issues=` (`1`/`0`) as Switch; server `applyDeviceListFilters` honours clean-only; `Devices.tsx` |
| Alerts **Severity** chips | Done + tested | Dynamic P1/P2/… counts over non-facet universe; toggles same `sev` facet / `?sev=`; `Alerts.tsx` |
| Systems roster **Linked** chips | Done + tested | Linked/Unlinked counts over q+health; toggles same `?linked=`; `Systems.tsx` |
| Docs | Done | user-guide Devices / Alerts / Systems cookbook rows; this Loop 145 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Devices / Alerts / Systems Loop 145 tests |

### Loop 139 (2026-08-04) — Sites plane / Auth result / Systems health chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided ClearPass/GreenLake/Overview health chips, UXI status, Topology type, Recommendations severity):

| Item | Status | Anchors |
|---|---|---|
| Sites **Plane** chips | Done + tested | plane badge counts over health+q universe; toggles same `?plane=` as header Select; `Sites.tsx` |
| Auth events **Result** chips | Done + tested | Accept/Reject/Timeout counts over q+service+method+role+plane+range; toggles same `?result=`; `AuthEvents.tsx` |
| Systems roster **Health** chips | Done + tested | Healthy/Warning/Degraded/Unlinked counts over q+linked; toggles same `?health=`; `Systems.tsx` |
| Docs | Done | user-guide Sites / Auth events / Systems cookbook rows; this Loop 139 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Sites / AuthEvents / Systems Loop 139 tests |

### Loop 146 (2026-08-04) — Recommendations category / UXI severity / Compliance fix chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Clients medium / Auth method / Compliance plane from Loop 143 and Licences/Topology/ClearPass category from Loop 142):

| Item | Status | Anchors |
|---|---|---|
| Recommendations **Category** chips | Done + tested | Dynamic category counts over device+site+client+severity; toggles same `?category=`; `Recommendations.tsx` |
| UXI **Severity** chips | Done + tested | Critical/Warning/Info counts over loaded q+site+status; toggles same `?severity=`; `Uxi.tsx` |
| Compliance **Fix** chips | Done + tested | Auto/Manual/Window/SSH scan counts over baseline+sev+plane+q; toggles same `?fix=`; `Compliance.tsx` |
| Docs | Done | user-guide Recommendations / UXI / Compliance cookbook rows; this Loop 146 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Recommendations / Uxi / Compliance Loop 146 tests |

### Loop 148 (2026-08-04) — Auth service / Topology ghosts / Tickets site chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Devices issues / Alerts sev / Systems linked, Recommendations category / UXI severity / Compliance fix):

| Item | Status | Anchors |
|---|---|---|
| Auth events **Service** chips | Done + tested | Dynamic service counts over q+result+method+role+plane+range; toggles same `?service=`; `AuthEvents.tsx` |
| Topology **Ghosts** chips | Done + tested | Ghosts count over q+plane+type; toggles same `?ghosts=1` as Switch; `Topology.tsx` |
| Tickets **Site** chips | Done + tested | Site name counts over q+pri+state; toggles same `?site=`; `Tickets.tsx` |
| Docs | Done | user-guide Auth events / Topology / Tickets cookbook + narrative; this Loop 148 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; AuthEvents / Topology / Tickets Loop 148 tests |


### Loop 149 (2026-08-04) — Auth role / Clients problems / ClearPass service enabled chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Auth service / Topology ghosts / Tickets site from Loop 148 and Recommendations category / UXI severity / Compliance fix from Loop 146):

| Item | Status | Anchors |
|---|---|---|
| Auth events **Role** chips | Done + tested | Dynamic role counts over q+result+service+method+plane+range; toggles same `?role=`; `AuthEvents.tsx` |
| Clients **Problems** chips | Done + tested | Problems/Clean counts over non-problems filters; chips + Switch share `?problems=` (`1`/`0`); server `queryFlag` clean-only; `Clients.tsx` + `clientsScreen.ts` |
| ClearPass services **Enabled** chips | Done + tested | Enabled/Disabled counts over loaded q; toggles same `?enabled=`; `ClearPass.tsx` |
| Docs | Done | user-guide Auth events / Clients / ClearPass cookbook rows; this Loop 149 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; AuthEvents / Clients / ClearPass Loop 149 tests |

### Loop 151 (2026-08-04) — Licences idle / Alerts plane / UXI site chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Auth service/role, Topology ghosts, Tickets site, Clients problems, ClearPass services enabled from Loops 148–149):

| Item | Status | Anchors |
|---|---|---|
| Licences **Idle** chips | Done + tested | Idle zero-assignment count over plane+status+q; chips + Switch share `?idle=1`; `Licenses.tsx` |
| Alerts **Plane** chips | Done + tested | Dynamic plane counts over non-facet universe; toggles same `plane` facet / `?plane=`; `Alerts.tsx` |
| UXI **Site** chips | Done + tested | Dynamic site counts over loaded q+status+severity; toggles same `?site=`; `Uxi.tsx` |
| Docs | Done | user-guide Licences / Alerts / UXI cookbook + narrative; this Loop 151 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Licenses / Alerts / Uxi Loop 151 tests |


### Loop 152 (2026-08-04) — Auth plane / Clients plane / Compliance baseline chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Auth role / Clients problems / ClearPass service enabled from Loop 149 and Alerts plane / Licences idle / UXI site from Loop 151):

| Item | Status | Anchors |
|---|---|---|
| Auth events **Plane** chips | Done + tested | Dynamic plane counts over q+result+service+method+role+range; toggles same `?plane=`; `AuthEvents.tsx` |
| Clients **Plane** chips | Done + tested | Plane counts over non-plane filters (incl. multi-source rows); toggles same `?plane=`; `Clients.tsx` |
| Compliance **Baseline** chips | Done + tested | Baseline counts over sev+plane+fix+q; toggles same `?baseline=`; `Compliance.tsx` |
| Docs | Done | user-guide Auth events / Clients / Compliance cookbook + narrative; this Loop 152 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; AuthEvents / Clients / Compliance Loop 152 tests |

### Loop 153 (2026-08-04) — Devices type / Configure history kind / SearchPanel kind chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Licences idle / Alerts plane / UXI site from Loop 151 and Auth plane / Clients plane / Compliance baseline from Loop 152):

| Item | Status | Anchors |
|---|---|---|
| Devices **Type** chips | Done + tested | Dynamic type counts over issues+q+names+state; toggles same `?type=` as Select; taxonomy label/tone when available; `Devices.tsx` |
| Configure history **Kind** chips | Done + tested | SSID/Port/VLAN counts over loaded result+ticket slice; client-side kind filter; CSV still sends `kind=`; `Configure.tsx` |
| SearchPanel **Kind** chips | Done + tested | Dynamic kind counts over query universe; toggles same kind Select + server CSV `kind=`; `SearchPanel.tsx` |
| Docs | Done | user-guide Devices / Configure / Search cookbook + narrative; this Loop 153 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Devices / Configure / SearchPanel Loop 153 tests |


### Loop 154 (2026-08-04) — Clients site / Devices state / Alerts unacked chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Auth plane / Clients plane / Compliance baseline from Loop 152 and Devices type chips from adjacent Loop 153 work):

| Item | Status | Anchors |
|---|---|---|
| Clients **Site** chips | Done + tested | Dynamic siteName counts over non-site filters; toggles same `?site=`; `Clients.tsx` |
| Devices **State** chips | Done + tested | Dynamic state counts over type+q+names+issues; toggles same `?state=` deep link; `Devices.tsx` |
| Alerts **Unacked** chips | Done + tested | Open-only count over cleared+q+fps; chips + Switch share `?unacked=1`; `Alerts.tsx` |
| Docs | Done | user-guide Clients / Devices / Alerts cookbook + narrative; this Loop 154 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Clients / Devices / Alerts Loop 154 tests |

### Loop 156 (2026-08-04) — AuthEvents range / Clients group / Devices site chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Clients site / Devices state / Alerts unacked from Loop 154, Devices type / Configure kind / SearchPanel kind from Loop 153, and Devices plane / Alerts site / Configure result from adjacent Loop 157 work):

| Item | Status | Anchors |
|---|---|---|
| AuthEvents **Range** chips | Done + tested | 15m/1h/24h/7d counts over non-range filters; toggles same `?range=` as TimeRangeControl; `AuthEvents.tsx` |
| Clients **Group** chips | Done + tested | Dynamic group counts over non-group filters; toggles same `?group=`; `Clients.tsx` |
| Devices **Site** chips | Done + tested | Dynamic siteId counts (siteName labels) over non-facet universe; toggles same `site` facet / `?site=`; `Devices.tsx` |
| Docs | Done | user-guide Auth events / Clients / Devices cookbook + narrative; this Loop 156 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; AuthEvents / Clients / Devices Loop 156 tests |

### Loop 157 (2026-08-04) — Devices plane / Alerts site / Configure history result chips

Independent residual pass (three operator-visible filter-chip improvements; catalog stays **44** — avoided Clients site / Devices state / Alerts unacked from Loop 154, Devices type / Configure history kind / SearchPanel kind from Loop 153, and AuthEvents range / Clients group / Devices site from adjacent Loop 156 work):

| Item | Status | Anchors |
|---|---|---|
| Devices **Plane** chips | Done + tested | Dynamic plane counts over non-facet universe; toggles same `plane` facet / `?plane=`; `Devices.tsx` |
| Alerts **Site** chips | Done + tested | Dynamic siteId counts (siteName labels) over non-facet universe; toggles same `site` facet / `?site=`; `Alerts.tsx` |
| Configure history **Result** chips | Done + tested | Dynamic exact result counts over loaded kind+ticket slice; client-side like Kind; CSV still sends `result=`; `Configure.tsx` |
| Docs | Done | user-guide Devices / Alerts / Configure cookbook + narrative; this Loop 157 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Devices / Alerts / Configure Loop 157 tests |

### Loop 160 (2026-08-04) — Clients/Auth selection links + Alerts Copy fingerprints

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided filter-chip work from Loops 153–157):

| Item | Status | Anchors |
|---|---|---|
| Clients bulk **Copy selection link** (`?macs=`) | Done + tested | Unique inventory MACs → shareable deep link + clearable chip; `Clients.tsx` |
| Auth events bulk **Copy selection link** (`?macs=`) | Done + tested | Unique endpoint MACs → shareable deep link + clearable chip; `AuthEvents.tsx` |
| Alerts bulk **Copy fingerprints** | Done + tested | Newline-joined fingerprints for ticket/silence paste (Devices **Copy serials** pattern); `Alerts.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Clients/Auth/Alerts cookbook rows; this Loop 160 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Clients / AuthEvents / Alerts Loop 160 tests |

### Loop 159 (2026-08-04) — Tickets share/LIVE · Compliance LIVE · UXI bulk

Independent residual pass (three operator-visible chrome improvements; catalog stays **44** — avoided Auth range, Clients group, Devices site/plane, Alerts site, Configure result chips from adjacent loops; preferred non-chip share / live badge / bulk):

| Item | Status | Anchors |
|---|---|---|
| Tickets **Copy filter link** + **LIVE** | Done + tested | Queue slice share without `sel=`; **Copy view link** keeps selection; LIVE pure+blend; `Tickets.tsx` |
| Compliance **LIVE** badge | Done + tested | Header LIVE pure live + blend; demo stays quiet; `Compliance.tsx` |
| UXI bulk **Export selected** + LIVE blend | Done + tested | DataTable selection bulk bar + Clear; LIVE pure+blend; `Uxi.tsx` |
| Docs | Done | user-guide Tickets / Compliance / UXI cookbook + narrative; this Loop 159 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Tickets / Compliance / Uxi Loop 159 tests |

### Loop 162 (2026-08-04) — Sites selection polish · Licences bulk · ClearPass bulk

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided Tickets copy/LIVE, Compliance LIVE, UXI bulk/LIVE, Clients/Auth macs selection link, Alerts fingerprints):

| Item | Status | Anchors |
|---|---|---|
| Sites **Copy selection link** polish + shortcuts + empty clear | Done + tested | `?ids=` deep link + clearable chip; keyboard shortcuts help; filtered empty **Clear filters**; `Sites.tsx` |
| Licences bulk **Export selected** + **Copy SKUs** | Done + tested | Multi-select bulk bar; unique newline-joined product SKUs (Devices **Copy serials** pattern); `Licenses.tsx` |
| ClearPass endpoints bulk **Export selected** + **Copy MACs** | Done + tested | Multi-select bulk bar on Endpoints tab; unique newline-joined MACs; `ClearPass.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Sites/Licences/ClearPass cookbook; this Loop 162 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Sites / Licenses / ClearPass Loop 162 tests |

### Loop 163 (2026-08-04) — Devices/Sites/Topology LIVE · Sites bulk

Independent residual pass (three operator-visible **non-chip** chrome/bulk improvements; catalog stays **44** — avoided filter-chip work from Loops 153–157; preferred LIVE honesty + Sites bulk):

| Item | Status | Anchors |
|---|---|---|
| Devices header **LIVE** | Done + tested | Pure live + blend (`!isDemo`); demo stays quiet; `Devices.tsx` |
| Sites header **LIVE** + bulk **Export selected** / **Copy selection link** | Done + tested | Pure live + blend badge; multi-select bulk bar (`?ids=`) + Clear; `Sites.tsx` |
| Topology header **LIVE** + blend footer | Done + tested | Pure live + `blended` includes topology; footer provenance matches; `Topology.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Devices/Sites/Topology cookbook; this Loop 163 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Devices / Sites / Topology Loop 163 tests |

### Loop 165 (2026-08-04) — Mist/Configure LIVE · Compliance bulk

Independent residual pass (three operator-visible **non-chip** chrome/bulk improvements; catalog stays **44** — avoided Devices/Sites/Topology LIVE, Sites bulk/ids, Licences bulk, ClearPass endpoints bulk from Loops 162–163; preferred Mist/Configure LIVE honesty + Compliance bulk):

| Item | Status | Anchors |
|---|---|---|
| Mist header **LIVE** | Done + tested | Pure live + mist blend; syncPhrase + server CSV + section live props; `Mist.tsx` |
| Configure header **LIVE** | Done + tested | Pure live + configure blend (`liveMode`); demo stays quiet; `Configure.tsx` |
| Compliance bulk **Export selected** | Done + tested | Findings multi-select bulk bar + Clear; `Compliance.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Mist/Configure/Compliance cookbook; this Loop 165 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Mist / Configure / Compliance Loop 165 tests |

### Loop 166 (2026-08-04) — Licences/Alerts/Central LIVE honesty

Independent residual pass (three operator-visible **non-chip** LIVE-badge improvements; catalog stays **44** — avoided filter-chip work and bulk bars already covered by Loops 159–163):

| Item | Status | Anchors |
|---|---|---|
| Licences header **LIVE** | Done + tested | Pure live + `blended` includes licenses (`sectionLive`); demo stays quiet; `Licenses.tsx` |
| Alerts header **LIVE** | Done + tested | Pure live + alerts blend via `sectionLive` (was blend-only); `Alerts.tsx` |
| Central header **LIVE** blend honesty | Done + tested | Pure live + `blended` includes central; demo stays quiet; `Central.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Licences/Alerts/Central cookbook; this Loop 166 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Licenses / Alerts / Central Loop 166 tests |

### Loop 168 (2026-08-04) — ClearPass/Overview/GreenLake LIVE honesty

Independent residual pass (three operator-visible **non-chip** LIVE-badge improvements; catalog stays **44** — avoided Mist/Configure/Licences/Alerts/Central LIVE and Compliance bulk from Loops 165–166):

| Item | Status | Anchors |
|---|---|---|
| ClearPass header **LIVE** | Done + tested | Pure live + `blended` includes clearpass (`sectionLive`); demo stays quiet; `ClearPass.tsx` |
| Overview header **LIVE** | Done + tested | Pure live header badge (blend keeps per-section LIVE/DEMO); demo stays quiet; `Overview.tsx` |
| GreenLake header **LIVE** | Done + tested | Plane inventory success always stamps LIVE (no fixture path); `GreenLake.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + ClearPass/Overview/GreenLake cookbook; this Loop 168 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; ClearPass / Overview / GreenLake Loop 168 tests |

### Loop 169 (2026-08-04) — UXI Copy serials · Systems LIVE · SiteDetail LIVE

Independent residual pass (three operator-visible **non-chip** chrome/bulk improvements; catalog stays **44** — avoided ClearPass/Overview/GreenLake LIVE from Loop 168 and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| UXI bulk **Copy serials** | Done + tested | Unique newline-joined published sensor serials (Devices **Copy serials** pattern); skips blank/duplicate; `Uxi.tsx` |
| Systems header **LIVE** badge | Done + tested | Pure live + systems blend beside mono `LIVE · SYNCED` stamp; demo stays quiet; `Systems.tsx` |
| SiteDetail header **LIVE** badge | Done + tested | Pure live + sites blend beside provenance mono stamp (both live-gap and profile branches); demo stays quiet; `SiteDetail.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + UXI/Systems/SiteDetail cookbook; this Loop 169 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Uxi / Systems / SiteDetail Loop 169 tests |

### Loop 172 (2026-08-04) — Compliance Copy rules · Licences selection link · GreenLake bulk

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided DeviceDetail/Tickets LIVE·bulk from Loop 171 and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Compliance bulk **Copy rules** | Done + tested | Unique newline-joined rule ids (Devices **Copy serials** pattern); skips blank/duplicate; `Compliance.tsx` |
| Licences bulk **Copy selection link** | Done + tested | `?skus=` deep link + clearable chip (Sites `?ids=` pattern); `Licenses.tsx` |
| GreenLake members bulk **Export selected** + **Copy emails** | Done + tested | Multi-select bulk bar; unique newline-joined usernames; `GreenLake.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Compliance/Licences/GreenLake cookbook; this Loop 172 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Compliance / Licenses / GreenLake Loop 172 tests |

### Loop 174 (2026-08-04) — ClearPass services bulk · Central sites bulk · SiteDetail devices bulk

Independent residual pass (three operator-visible **non-chip** bulk improvements; catalog stays **44** — avoided Inventory/DeviceDetail LIVE, Tickets bulk, Compliance Copy rules, Licences `?skus=` link, GreenLake bulk from Loops 171–172, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| ClearPass services bulk **Export selected** + **Copy names** | Done + tested | Services-tab multi-select bulk bar; unique newline-joined service names; `ClearPass.tsx` |
| Central sites bulk **Export selected** + **Copy names** | Done + tested | Sites section multi-select bulk bar; unique newline-joined site names; `central/SitesSection.tsx` |
| SiteDetail devices bulk **Export selected** + **Copy serials** | Done + tested | Site device table multi-select bulk bar; unique newline-joined serials; `SiteDetail.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + ClearPass/Central/Site detail cookbook; this Loop 174 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; ClearPass / Central / SiteDetail Loop 174 tests |

### Loop 171 (2026-08-04) — Inventory LIVE · DeviceDetail LIVE · Tickets bulk

Independent residual pass (three operator-visible **non-chip** chrome/bulk improvements; catalog stays **44** — avoided ClearPass/Overview/GreenLake LIVE, UXI Copy serials, Systems/SiteDetail LIVE from Loop 169, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Inventory header **LIVE** badge | Done + tested | Non-demo systems registry (`getSystemsState`); offline/demo stay quiet; `Inventory.tsx` + `inventorySectionLive` |
| DeviceDetail header **LIVE** badge | Done + tested | Pure live + devices blend on inventory-only and profile heroes; demo stays quiet; `DeviceDetail.tsx` |
| Tickets bulk **Export selected** / **Copy IDs** | Done + tested | Queue checkboxes independent of workspace `sel=`; unique newline-joined ticket ids; `Tickets.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Inventory/DeviceDetail/Tickets cookbook; this Loop 171 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Inventory / DeviceDetail / Tickets Loop 171 tests |

### Loop 175 (2026-08-04) — UXI/Tickets/ClearPass selection links

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided filter-chip work and LIVE badges already covered by Loops 165–171; preferred selection deep-links on bulk bars that already had Export/Copy):

| Item | Status | Anchors |
|---|---|---|
| UXI bulk **Copy selection link** | Done + tested | `?ids=` sensor ids + clearable chip (Sites `?ids=` pattern); `Uxi.tsx` |
| Tickets bulk **Copy selection link** | Done + tested | `?ids=` ticket ids + clearable chip; independent of workspace `sel=`; `Tickets.tsx` |
| ClearPass endpoints bulk **Copy selection link** | Done + tested | `?macs=` unique inventory MACs + clearable chip (Clients `?macs=` pattern); `ClearPass.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + UXI/Tickets/ClearPass cookbook; this Loop 175 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Uxi / Tickets / ClearPass Loop 175 tests |

### Loop 178 (2026-08-04) — Compliance/GreenLake/Central selection links

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided filter-chip work, LIVE badges, and Mist/Topology bulk from adjacent streams; preferred selection deep-links on bulk bars that already had Export/Copy):

| Item | Status | Anchors |
|---|---|---|
| Compliance bulk **Copy selection link** | Done + tested | `?rules=` unique rule ids + clearable chip (Licences `?skus=` pattern); `Compliance.tsx` |
| GreenLake members bulk **Copy selection link** | Done + tested | `?ids=` member ids + clearable chip (Sites `?ids=` pattern); `GreenLake.tsx` |
| Central sites bulk **Copy selection link** | Done + tested | `?ids=` site ids + `section=sites` + clearable chip; `central/SitesSection.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Compliance/GreenLake/Central cookbook; this Loop 178 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Compliance / GreenLake / Central Loop 178 tests |


### Loop 177 (2026-08-04) — Compliance/GreenLake selection links · Central firmware bulk

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided ClearPass services bulk, Central sites bulk, SiteDetail devices bulk from Loop 174 and UXI/Tickets/ClearPass selection links from Loop 175):

| Item | Status | Anchors |
|---|---|---|
| Compliance bulk **Copy selection link** | Done + tested | `?rules=` unique rule ids + clearable chip (Licences `?skus=` pattern); `Compliance.tsx` |
| GreenLake members bulk **Copy selection link** | Done + tested | `?ids=` member ids + clearable chip (Sites `?ids=` pattern); `GreenLake.tsx` |
| Central firmware bulk **Export selected** + **Copy serials** | Done + tested | Behind-train multi-select bulk bar; unique newline-joined serials; `central/FirmwareSection.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Compliance/GreenLake/Central cookbook; this Loop 177 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Compliance / GreenLake / Central Loop 177 tests |



### Loop 183 (2026-08-04) — Configure bulk polish · SSE inventory bulk · Central WLANs bulk

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided Mist firmware bulk, DeviceDetail clients bulk, Inventory search bulk, and SiteDetail/Central firmware/ClearPass services selection links from Loops 180–181):

| Item | Status | Anchors |
|---|---|---|
| Configure queue bulk polish | Done + tested | **Export selected** + **Copy IDs** + **Copy selection link** (`?ids=` queue row keys + `section=queue`; clearable chip) beside Approve/Reject; `Configure.tsx` |
| Systems SSE inventory bulk | Done + tested | Multi-select **Export selected** + **Copy IDs** + **Copy selection link** (`?sseIds=` + kind/q; clearable chip); `SseInventoryPanel.tsx` |
| Central WLANs bulk | Done + tested | DataTable multi-select **Export selected** + **Copy names** + **Copy selection link** (`?names=` + `section=wlans`; clearable chip); `central/WlanSection.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Configure/Systems/Central cookbook; this Loop 183 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; ConfigureBulk / SseInventoryPanel / Central Loop 183 tests |

### Loop 181 (2026-08-04) — SiteDetail/Central firmware/ClearPass services selection links

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided filter-chip work, LIVE badges, and Mist/Topology bulk from adjacent streams; preferred selection deep-links on bulk bars that already had Export/Copy):

| Item | Status | Anchors |
|---|---|---|
| SiteDetail devices bulk **Copy selection link** | Done + tested | `?names=` unique device names + clearable chip (Devices `?names=` pattern); `SiteDetail.tsx` |
| Central firmware bulk **Copy selection link** | Done + tested | `?serials=` unique inventory serials + `section=firmware` + clearable chip; `central/FirmwareSection.tsx` |
| ClearPass services bulk **Copy selection link** | Done + tested | `?services=` service ids + `tab=services` + clearable chip; `ClearPass.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + SiteDetail/Central/ClearPass cookbook; this Loop 181 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; SiteDetail / Central / ClearPass Loop 181 tests |

### Loop 180 (2026-08-04) — Mist firmware bulk · DeviceDetail clients bulk · Inventory search bulk

Independent residual pass (three operator-visible **non-chip** bulk improvements; catalog stays **44** — avoided Compliance rules link, GreenLake ids link, Central sites/firmware bulk/selection links from Loops 177–181; preferred Mist/Inventory/DeviceDetail bulk bars):

| Item | Status | Anchors |
|---|---|---|
| Mist firmware bulk **Export selected** + **Copy serials** | Done + tested | Behind-train DataTable multi-select bulk bar; unique newline-joined serials; `mist/firmware.tsx` |
| DeviceDetail clients bulk **Export selected** + **Copy MACs** | Done + tested | Clients table multi-select bulk bar; unique newline-joined MACs; `deviceDetail/tables.tsx` ClientTable |
| Inventory search bulk **Export selected** + **Copy serials** | Done + tested | Search-results DataTable multi-select bulk bar; unique newline-joined serials; `Inventory.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Mist/Device detail/Inventory cookbook; this Loop 180 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Mist / DeviceDetail / Inventory Loop 180 tests |

### Loop 187 (2026-08-04) — Mist WLANs/licences bulk · DeviceDetail ports bulk

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided filter-chip work, LIVE badges, and selection links already covered by Loops 175–184; preferred bulk bars on Mist WLANs/licences and device ports):

| Item | Status | Anchors |
|---|---|---|
| Mist WLANs bulk **Export selected** + **Copy names** + **Copy selection link** | Done + tested | DataTable multi-select; `?names=` + `section=wlans` + clearable chip; `mist/wlans.tsx` |
| Mist licences bulk **Export selected** + **Copy site ids** + **Copy selection link** | Done + tested | DataTable multi-select; `?siteIds=` + `section=licenses` + clearable chip; `mist/licenses.tsx` |
| DeviceDetail ports bulk **Export selected** + **Copy ports** + **Copy selection link** | Done + tested | Profile class-block + live `PortTable`; `?ports=` + clearable chip; `DeviceDetail.tsx`, `deviceDetail/tables.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Mist/Device detail cookbook; this Loop 187 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Mist / DeviceDetail Loop 187 tests |

### Loop 184 (2026-08-04) — Mist/DeviceDetail/Inventory selection links

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided filter-chip work, LIVE badges, and selection links already covered by Loops 175–181; preferred selection deep-links on Loop 180 bulk bars):

| Item | Status | Anchors |
|---|---|---|
| Mist firmware bulk **Copy selection link** | Done + tested | `?serials=` unique inventory serials + `section=devices` + clearable chip; `mist/firmware.tsx` |
| DeviceDetail clients bulk **Copy selection link** | Done + tested | `?macs=` unique session MACs + clearable chip (Clients pattern); `deviceDetail/tables.tsx` ClientTable |
| Inventory search bulk **Copy selection link** | Done + tested | `?ids=` search-node ids + clearable chip (Sites `?ids=` pattern); `Inventory.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Mist/Device detail/Inventory cookbook; this Loop 184 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Mist / DeviceDetail / Inventory Loop 184 tests |

### Loop 186 (2026-08-04) — Topology bulk · Recommendations bulk · Sites Copy names

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided Configure queue bulk, SSE bulk, Central WLANs bulk, Mist/DeviceDetail/Inventory selection links from Loops 183–184, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Topology nodes bulk | Done + tested | Filtered **Nodes** DataTable multi-select **Export selected** + **Copy serials** + **Copy selection link** (`?ids=` node ids; clearable chip); `Topology.tsx` |
| Recommendations bulk | Done + tested | Card multi-select **Export selected** + **Copy IDs** + **Copy selection link** (canonical `/recommendations?ids=`; clearable chip; never auto-applies); `ConfigRecommendationsPanel.tsx` + `Recommendations.tsx` preserves `ids=` |
| Sites bulk **Copy names** | Done + tested | Unique newline-joined site names (Central sites pattern); `Sites.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Topology/Recommendations/Sites cookbook; this Loop 186 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Topology / ConfigRecommendationsPanel / Sites Loop 186 tests |

### Loop 189 (2026-08-04) — Systems plane bulk · SearchPanel recent bulk · Overview empty polish

Independent residual pass (three operator-visible **non-chip** improvements; catalog stays **44** — avoided Topology bulk, Recommendations bulk, Sites Copy names, Mist WLANs/licences bulk, DeviceDetail ports bulk from Loops 186–187, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Systems plane roster bulk | Done + tested | Multi-select **Export selected** + **Copy plane ids** + **Copy selection link** (`?ids=` registry plane ids; clearable chip; drawer `?plane=` stays independent); `Systems.tsx` + `systemsPlaneKey` |
| SearchPanel recent bulk | Done + tested | Recent multi-select **Export selected** + **Copy queries** + **Remove selected** + **Clear** beside Clear-all; `SearchPanel.tsx` |
| Overview empty polish | Done + tested | Actionable empty CTAs (Open Alerts / Connected systems / Inventory / Open Configure / Clear health filter) + clearer live copy; `Overview.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Overview/Systems/⌘K cookbook; this Loop 189 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Systems / SearchPanel / Overview Loop 189 tests |

### Loop 190 (2026-08-04) — Overview alerts/sites bulk · Central webhooks bulk

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided Systems plane bulk, SearchPanel recent bulk, Overview empty polish from Loop 189, Topology/Recommendations bulk from Loop 186, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Overview Needs-you-now bulk | Done + tested | Multi-select **Export selected** + **Copy devices** + **Copy selection link** (`?devices=`; clearable chip); stable `overviewAlertKey`; `Overview.tsx` |
| Overview Sites preview bulk | Done + tested | Multi-select **Export selected** + **Copy names** + **Copy selection link** (`?siteIds=`; clearable chip); `Overview.tsx` |
| Central webhooks list bulk | Done + tested | Multi-select **Export selected** + **Copy names** + **Copy selection link** (`/systems?plane=central&tab=config&webhookIds=`; clearable chip; summary fields only — never secrets); `CentralWebhooksPanel.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Overview/Systems cookbook; this Loop 190 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Overview / CentralWebhooksPanel Loop 190 tests |

### Loop 192 (2026-08-04) — Topology/Licences/UXI keyboard help + empty CTAs

Independent residual pass (three operator-visible **non-chip** a11y/empty improvements; catalog stays **44** — avoided Systems plane bulk, SearchPanel recent bulk, Overview empty CTAs, Overview needs-you/sites bulk, Central webhooks bulk from Loops 189–190, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Topology keyboard help + empty CTAs | Done + tested | Nodes table `KeyboardShortcuts` (`DATATABLE_ROW_SHORTCUTS`); empty graph **Clear filters** / **Inventory** / **Connected systems**; `Topology.tsx` |
| Licences keyboard help + live empty CTA | Done + tested | Header `KeyboardShortcuts`; live empty subscriptions **Connected systems**; `Licenses.tsx` |
| UXI keyboard help | Done + tested | Sensors table `KeyboardShortcuts`; `Uxi.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Topology/Licences/UXI cookbook; this Loop 192 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Topology / Licenses / Uxi Loop 192 tests |

### Loop 193 (2026-08-04) — Mist/Site rogues bulk · Mist audit bulk

Independent residual pass (three operator-visible **non-chip** bulk/share improvements; catalog stays **44** — avoided Overview/Central webhooks bulk from Loop 190, Systems/SearchPanel bulk from Loop 189, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Mist estate Rogue & neighbor APs bulk | Done + tested | Multi-select **Export selected** + **Copy BSSIDs** + **Copy selection link** (`?bssids=` + `section=rogues`; clearable chip); `mist/rogues.tsx` `EstateRogueAps` |
| SiteDetail Rogue & neighbor APs bulk | Done + tested | Multi-select **Export selected** + **Copy BSSIDs** + **Copy selection link** (`?bssids=` + `section=rogues`; clearable chip); `siteDetail/RogueAps.tsx` |
| Mist org audit log bulk | Done + tested | Multi-select **Export selected** + **Copy admins** + **Copy selection link** (`?auditIds=` + `section=audit`; clearable chip; redacted before/after only); `mist/audit.tsx` `AuditLogSection` |
| Docs | Done | user-guide keyboard/bulk narrative + Mist/SiteDetail cookbook; this Loop 193 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Mist / SiteRogueAps Loop 193 tests |

### Loop 196 (2026-08-04) — GreenLake roles/locations bulk · Tickets keyboard help

Independent residual pass (three operator-visible **non-chip** bulk/a11y improvements; catalog stays **44** — avoided Mist/Site rogues + Mist audit bulk from Loop 193, Topology/Licences/UXI keyboard help from Loop 192, GreenLake members keyboard/empty from Loop 195, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| GreenLake role grants bulk | Done + tested | Multi-select **Export selected** + **Copy principals** + **Copy selection link** (`?roleIds=` + `section=roles`; clearable chip); `GreenLake.tsx` |
| GreenLake locations bulk | Done + tested | Multi-select **Export selected** + **Copy names** + **Copy selection link** (`?locationIds=` + `section=locations`; clearable chip); `GreenLake.tsx` |
| Tickets keyboard help | Done + tested | Header `KeyboardShortcuts` (`DATATABLE_ROW_SHORTCUTS`); `Tickets.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + Tickets/GreenLake cookbook; this Loop 196 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; GreenLake / Tickets Loop 196 tests |

### Loop 195 (2026-08-04) — ClearPass/Configure/GreenLake keyboard help + GreenLake empty CTA

Independent residual pass (three operator-visible **non-chip** a11y/empty improvements; catalog stays **44** — avoided Topology/Licences/UXI keyboard from Loop 192, Mist/Site rogues bulk and Mist audit bulk from Loop 193, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| ClearPass keyboard help | Done + tested | Endpoints table `KeyboardShortcuts` (`DATATABLE_ROW_SHORTCUTS`); `ClearPass.tsx` |
| Configure keyboard help | Done + tested | Queue table `KeyboardShortcuts` when rows present; `Configure.tsx` |
| GreenLake keyboard help + filtered empty CTA | Done + tested | Members table `KeyboardShortcuts`; filtered empty **Clear filters** (q/status/ids); `GreenLake.tsx` |
| Docs | Done | user-guide keyboard/bulk narrative + ClearPass/Configure/GreenLake cookbook; this Loop 195 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; ClearPass / Configure / GreenLake Loop 195 tests |

### Loop 198 (2026-08-04) — Inventory/Mist/Central keyboard help

Independent residual pass (three operator-visible **non-chip** a11y improvements; catalog stays **44** — avoided ClearPass/Configure/GreenLake keyboard from Loop 195, GreenLake roles/locations bulk + Tickets keyboard from Loop 196, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Inventory keyboard help | Done + tested | Explorer header `KeyboardShortcuts` (`DATATABLE_ROW_SHORTCUTS`) for search-result grid; `Inventory.tsx` |
| Mist keyboard help | Done + tested | Header `KeyboardShortcuts` for estate tables (rogues/WLANs/firmware/licences/audit); `Mist.tsx` |
| Central keyboard help | Done + tested | Header `KeyboardShortcuts` for sites/firmware/WLANs grids; `Central.tsx` |
| Docs | Done | user-guide keyboard narrative + Inventory/Mist/Central cookbook; this Loop 198 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Inventory / Mist / Central Loop 198 tests |

### Loop 199 (2026-08-04) — Compliance/DeviceDetail/SiteDetail keyboard help

Independent residual pass (three operator-visible **non-chip** a11y improvements; catalog stays **44** — avoided Inventory/Mist/Central keyboard from Loop 198, GreenLake bulk + Tickets keyboard from Loop 196, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Compliance keyboard help | Done + tested | Header `KeyboardShortcuts` (`DATATABLE_ROW_SHORTCUTS`) for findings multi-select grid (selection-only Enter); `Compliance.tsx` |
| DeviceDetail keyboard help | Done + tested | Hero `KeyboardShortcuts` for ports/clients tables (live + profile); `DeviceDetail.tsx` |
| SiteDetail keyboard help | Done + tested | Header `KeyboardShortcuts` for devices/rogues grids (live + profile); `SiteDetail.tsx` |
| Docs | Done | user-guide keyboard narrative + Compliance/Device/Site detail cookbook; this Loop 199 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Compliance / DeviceDetail / SiteDetail Loop 199 tests |

### Loop 201 (2026-08-04) — Overview/SSE inventory/Central webhooks keyboard + empty CTAs

Independent residual pass (three operator-visible **non-chip** a11y/empty improvements; catalog stays **44** — avoided Inventory/Mist/Central keyboard from Loop 198, Compliance/DeviceDetail/SiteDetail keyboard from Loop 199, ClearPass/Configure/GreenLake keyboard + GreenLake roles/locations bulk + Tickets keyboard from Loops 195–196, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Overview keyboard help | Done + tested | Header `KeyboardShortcuts` (`DATATABLE_ROW_SHORTCUTS`) for Needs-you-now + Sites preview multi-select grids; `Overview.tsx` |
| SSE inventory keyboard + empty CTAs | Done + tested | Toolbar `KeyboardShortcuts`; filtered empties **Clear selection filter** / **Clear search**; `SseInventoryPanel.tsx` |
| Central webhooks keyboard + empty CTA | Done + tested | Header `KeyboardShortcuts` for webhooks multi-select grid; search empty **Clear search**; `CentralWebhooksPanel.tsx` |
| Docs | Done | user-guide keyboard/empty narrative + Overview/SSE/webhooks cookbook; this Loop 201 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Overview / SseInventoryPanel / CentralWebhooksPanel Loop 201 tests |

### Loop 202 (2026-08-04) — Devices/Systems empty CTAs · SearchPanel keyboard help

Independent residual pass (three operator-visible **non-chip** a11y/empty improvements; catalog stays **44** — avoided Overview/SSE/Central webhooks keyboard + empty CTAs from Loop 201, Compliance/DeviceDetail/SiteDetail keyboard from Loop 199, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Devices filtered empty CTA | Done + tested | Filtered empty **Clear filters** resets q/type/issues/facets/`names`/`state`; `Devices.tsx` |
| Systems roster filtered empty CTA | Done + tested | Roster empty **Clear filters** resets q/health/linked/`ids`; `Systems.tsx` |
| SearchPanel keyboard help | Done + tested | Panel `KeyboardShortcuts` (`SEARCH_PANEL_SHORTCUTS` — ⌘K / arrows / Enter / Esc); `SearchPanel.tsx` |
| Docs | Done | user-guide keyboard/empty narrative + Devices/Systems/⌘K cookbook; this Loop 202 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Devices / Systems / SearchPanel Loop 202 tests |

### Loop 205 (2026-08-04) — Configure ports/queue empty CTAs · Recommendations selection empty CTA

Independent residual pass (three operator-visible **non-chip** empty improvements; catalog stays **44** — avoided Devices/Systems/SearchPanel from Loop 202, Alerts/Mist WLANs Clear filters from concurrent Loop 204, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Configure ports filtered empty CTA | Done + tested | Port filter empty **Clear filters** resets `portQuery`; `Configure.tsx` |
| Configure queue selection-empty CTA | Done + tested | Queue `?ids=` empty **Clear selection filter** drops deep link; `Configure.tsx` |
| Recommendations selection-empty CTA | Done + tested | Panel `?ids=` empty **Clear selection filter**; `ConfigRecommendationsPanel.tsx` |
| Docs | Done | user-guide empty narrative + Configure/Recommendations cookbook; this Loop 205 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Configure / ConfigRecommendationsPanel Loop 205 tests |
### Loop 204 (2026-08-04) — Alerts/Mist WLANs/Inventory empty CTAs

Independent residual pass (three operator-visible **non-chip** empty CTAs; catalog stays **44** — avoided Overview/SSE/Central webhooks keyboard + empty CTAs from Loop 201, Devices/Systems empty CTAs + SearchPanel keyboard from Loop 202, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Alerts filtered empty CTA | Done + tested | Filtered empty **Clear filters** resets q/sev·plane·site facets/unacked/`fps`; `Alerts.tsx` |
| Mist WLANs filtered empty CTA | Done + tested | q/enabled empty **Clear filters**; `mist/wlans.tsx` |
| Inventory search empty CTA | Done + tested | Empty search **Clear search** clears q; `Inventory.tsx` |
| Docs | Done | user-guide keyboard/empty narrative + Alerts/Mist/Inventory cookbook; this Loop 204 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Alerts / Mist / Inventory Loop 204 tests |

### Loop 207 (2026-08-04) — Central sites/WLANs · DeviceDetail ports selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** empty improvements; catalog stays **44** — avoided Alerts/Mist/Inventory empty CTAs from Loop 204, Configure ports/queue + Recommendations ids empty from Loop 205, Topology/SiteDetail/Inventory selection-empty from concurrent Loop 208, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Central sites selection-empty CTA | Done + tested | Sites `?ids=` empty **Clear selection filter**; `central/SitesSection.tsx` |
| Central WLANs selection-empty CTA | Done + tested | WLANs `?names=` empty **Clear selection filter**; `central/WlanSection.tsx` |
| DeviceDetail ports selection-empty CTA | Done + tested | Profile + live `?ports=` empty **Clear selection filter**; `DeviceDetail.tsx` / `deviceDetail/tables.tsx` |
| Docs | Done | user-guide empty narrative + Central/Devices cookbook; this Loop 207 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Central / DeviceDetail Loop 207 tests |

### Loop 208 (2026-08-04) — Topology/SiteDetail/Inventory selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** selection-empty CTAs; catalog stays **44** — avoided Configure/Recommendations selection-empty from Loop 205, Alerts/Mist WLANs/Inventory search-empty from Loop 204, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Topology nodes selection-empty CTA | Done + tested | Nodes `?ids=` empty **Clear selection filter**; `Topology.tsx` |
| SiteDetail devices selection-empty CTA | Done + tested | Devices `?names=` empty **Clear selection filter**; `SiteDetail.tsx` |
| Inventory search selection-empty CTA | Done + tested | Search hits `?ids=` empty **Clear selection filter**; `Inventory.tsx` |
| Docs | Done | user-guide selection-empty narrative + Topology/Site detail/Inventory cookbook; this Loop 208 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Topology / SiteDetail / Inventory Loop 208 tests |

### Loop 211 (2026-08-04) — Mist rogues/WLANs · Central firmware selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** selection-empty CTAs; catalog stays **44** — avoided Topology/SiteDetail/Inventory selection-empty from Loop 208, Central sites/WLANs + DeviceDetail ports from Loop 207, Mist WLANs q/enabled Clear filters from Loop 204, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Mist rogues selection-empty CTA | Done + tested | Rogues `?bssids=` empty **Clear selection filter**; `mist/rogues.tsx` |
| Mist WLANs selection-empty CTA | Done + tested | WLANs `?names=` empty **Clear selection filter**; `mist/wlans.tsx` |
| Central firmware selection-empty CTA | Done + tested | Firmware `?serials=` empty **Clear selection filter**; `central/FirmwareSection.tsx` |
| Docs | Done | user-guide selection-empty narrative + Mist/Central cookbook; this Loop 211 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Mist / Central Loop 211 tests |

### Loop 213 (2026-08-04) — Compliance/ClearPass services/Mist audit selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** selection-empty CTAs; catalog stays **44** — avoided Licenses/Tickets/UXI selection-empty from Loop 210, Mist rogues/WLANs + Central firmware selection-empty from Loop 211, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Compliance selection-empty CTA | Done + tested | Findings `?rules=` empty **Clear selection filter**; `Compliance.tsx` |
| ClearPass services selection-empty CTA | Done + tested | Services `?services=` empty **Clear selection filter**; `ClearPass.tsx` |
| Mist audit selection-empty CTA | Done + tested | Audit `?auditIds=` empty **Clear selection filter**; `mist/audit.tsx` |
| Docs | Done | user-guide selection-empty narrative + Compliance/ClearPass/Mist cookbook; this Loop 213 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Compliance / ClearPass / Mist Loop 213 tests |

### Loop 210 (2026-08-04) — Licenses/Tickets/UXI selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** selection-empty CTAs; catalog stays **44** — avoided Topology/SiteDetail/Inventory selection-empty from Loop 208, Central sites/WLANs + DeviceDetail ports selection-empty from Loop 207, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Licenses selection-empty CTA | Done + tested | Subscriptions `?skus=` empty **Clear selection filter**; `Licenses.tsx` |
| Tickets selection-empty CTA | Done + tested | Queue `?ids=` empty **Clear selection filter**; `Tickets.tsx` |
| UXI selection-empty CTA | Done + tested | Sensors `?ids=` empty **Clear selection filter**; `Uxi.tsx` |
| Docs | Done | user-guide selection-empty narrative + Licences/Tickets/UXI cookbook; this Loop 210 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Licenses / Tickets / Uxi Loop 210 tests |

### Loop 214 (2026-08-04) — Sites/Devices/Clients selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** selection-empty CTAs; catalog stays **44** — avoided Licenses/Tickets/UXI selection-empty from Loop 210, Mist rogues/WLANs + Central firmware from Loop 211, Topology/SiteDetail/Inventory from Loop 208, ClearPass/GreenLake concurrent stream, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Sites selection-empty CTA | Done + tested | Sites `?ids=` empty **Clear selection filter**; `Sites.tsx` |
| Devices selection-empty CTA | Done + tested | Inventory `?names=` empty **Clear selection filter**; `Devices.tsx` |
| Clients selection-empty CTA | Done + tested | Roster `?macs=` empty **Clear selection filter**; `Clients.tsx` |
| Docs | Done | user-guide selection-empty narrative + Sites/Devices/Clients cookbook; this Loop 214 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Sites / Devices / Clients Loop 214 tests |

### Loop 216 (2026-08-04) — GreenLake members/roles/locations selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** selection-empty CTAs; catalog stays **44** — avoided Sites/Devices/Clients selection-empty from Loop 214, Compliance/ClearPass services/Mist audit from Loop 213, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| GreenLake members selection-empty CTA | Done + tested | Members `?ids=` empty **Clear selection filter**; `GreenLake.tsx` |
| GreenLake roles selection-empty CTA | Done + tested | Role grants `?roleIds=` empty **Clear selection filter**; `GreenLake.tsx` |
| GreenLake locations selection-empty CTA | Done + tested | Locations `?locationIds=` empty **Clear selection filter**; `GreenLake.tsx` |
| Docs | Done | user-guide selection-empty narrative + Mist/GreenLake cookbook; this Loop 216 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; GreenLake Loop 216 tests |

---

### Loop 217 (2026-08-04) — Mist firmware/licences · DeviceDetail clients selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** selection-empty CTAs; catalog stays **44** — avoided Sites/Devices/Clients selection-empty from Loop 214, Mist rogues/WLANs + Central firmware from Loop 211, Compliance/ClearPass/Mist audit from Loop 213, GreenLake members/roles/locations from Loop 216, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Mist firmware selection-empty CTA | Done + tested | Firmware `?serials=` empty **Clear selection filter**; `mist/firmware.tsx` |
| Mist licences selection-empty CTA | Done + tested | Licence usage `?siteIds=` empty **Clear selection filter**; `mist/licenses.tsx` |
| DeviceDetail clients selection-empty CTA | Done + tested | Clients `?macs=` empty **Clear selection filter**; `deviceDetail/tables.tsx` |
| Docs | Done | user-guide selection-empty narrative + Mist/Device detail cookbook; this Loop 217 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Mist / DeviceDetail Loop 217 tests |

### Loop 219 (2026-08-04) — Systems/AuthEvents/ClearPass endpoints selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** selection-empty CTAs; catalog stays **44** — avoided GreenLake members/roles/locations from Loop 216, Mist firmware/licences + DeviceDetail clients from Loop 217, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Systems selection-empty CTA | Done + tested | Plane roster `?ids=` empty **Clear selection filter**; `Systems.tsx` |
| AuthEvents selection-empty CTA | Done + tested | Events `?macs=` empty **Clear selection filter**; `AuthEvents.tsx` |
| ClearPass endpoints selection-empty CTA | Done + tested | Endpoints `?macs=` empty **Clear selection filter**; `ClearPass.tsx` |
| Docs | Done | user-guide selection-empty narrative + Systems/Auth/ClearPass cookbook; this Loop 219 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Systems / AuthEvents / ClearPass Loop 219 tests |

### Loop 220 (2026-08-04) — Alerts/Site rogues/Recommendations selection-empty CTAs

Independent residual pass (three operator-visible **non-chip** selection-empty / selection-clear improvements; catalog stays **44** — avoided Systems/AuthEvents/ClearPass endpoints from Loop 219, Mist firmware/licences + DeviceDetail clients from Loop 217, and filter-chip work):

| Item | Status | Anchors |
|---|---|---|
| Alerts selection-empty CTA | Done + tested | Queue `?fps=` empty **Clear selection filter**; `Alerts.tsx` |
| Site Rogues selection-empty CTA | Done + tested | Site rogues `?bssids=` empty **Clear selection filter**; `siteDetail/RogueAps.tsx` |
| Recommendations selection-only header clear | Done + tested | Header **Clear selection filter** when only `?ids=` is active; `Recommendations.tsx` |
| Docs | Done | user-guide selection-empty narrative + Alerts/Site detail/Recommendations cookbook; this Loop 220 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Alerts / SiteRogueAps / Recommendations Loop 220 tests |

### Loop 222 (2026-08-04) — ClearPass services empty/keyboard · Recommendations scope empty

Independent residual pass (three operator-visible **non-chip** empty-filter / keyboard / loading-honesty improvements; catalog stays **44** — avoided Systems/AuthEvents/ClearPass endpoints selection-empty from Loop 219, Alerts fps / Site Rogues / Recommendations ids from Loop 220, and filter-chip work; preferred empty-filter CTAs + keyboard remaining over saturated selection-empty):

| Item | Status | Anchors |
|---|---|---|
| ClearPass services filtered-empty CTA | Done + tested | Services q/enabled empty **Clear filters** (not selection); `ClearPass.tsx` |
| ClearPass services keyboard help | Done + tested | Services table `KeyboardShortcuts` (`DATATABLE_ROW_SHORTCUTS`); `ClearPass.tsx` |
| Recommendations scope-filter empty CTA | Done + tested | Panel scope empty **Clear filters** + loading `aria-busy`; `ConfigRecommendationsPanel.tsx` / `Recommendations.tsx` |
| Docs | Done | user-guide keyboard/empty narrative + ClearPass/Recommendations cookbook; this Loop 222 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; ClearPass / ConfigRecommendationsPanel / Recommendations Loop 222 tests |

### Loop 223 (2026-08-04) — Topology/Inventory Copy names · Configure empty-queue keyboard help

Independent residual pass (three operator-visible **non-chip** bulk/a11y improvements; catalog stays **44** — preferred non-selection-empty residuals; avoided selection-empty CTA streams from Loops 207–220 and ClearPass/Recommendations empty work from Loop 222):

| Item | Status | Anchors |
|---|---|---|
| Topology nodes **Copy names** | Done + tested | Bulk bar unique newline-joined node names beside **Copy serials**; `Topology.tsx` |
| Inventory search **Copy names** | Done + tested | Bulk bar unique newline-joined labels beside **Copy serials**; `Inventory.tsx` |
| Configure queue keyboard help (empty) | Done + tested | `KeyboardShortcuts` stays visible when queue has zero rows; `Configure.tsx` |
| Docs | Done | user-guide Topology/Inventory/Configure cookbook + bulk narrative; this Loop 223 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Topology / Inventory / Configure Loop 223 tests |

### Loop 225 (2026-08-04) — SiteDetail/Central/Mist firmware bulk Copy names

Independent residual pass (three operator-visible **non-chip** bulk hand-off improvements; catalog stays **44** — preferred remaining bulk **Copy names**; avoided ClearPass/Recommendations from Loop 222, Topology/Inventory Copy names + Configure keyboard from Loop 223, and Devices/UXI/Clients Copy names from Loop 226):

| Item | Status | Anchors |
|---|---|---|
| Site detail devices **Copy names** | Done + tested | Bulk bar unique newline-joined device names beside **Copy serials**; `SiteDetail.tsx` |
| Central firmware **Copy names** | Done + tested | Bulk bar unique newline-joined device names beside **Copy serials**; `central/FirmwareSection.tsx` |
| Mist firmware **Copy names** | Done + tested | Bulk bar unique newline-joined device names beside **Copy serials**; `mist/firmware.tsx` |
| Docs | Done | user-guide Site detail/Central/Mist cookbook + bulk narrative; this Loop 225 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; SiteDetail / Central / Mist Loop 225 tests |

### Loop 226 (2026-08-04) — Devices/UXI/Clients bulk Copy names

Independent residual pass (three operator-visible **non-chip** bulk hand-off improvements; catalog stays **44** — preferred non-selection-empty residuals; avoided selection-empty CTA streams from Loops 207–220 and Topology/Inventory Copy names from Loop 223):

| Item | Status | Anchors |
|---|---|---|
| Devices **Copy names** | Done + tested | Bulk bar unique newline-joined device names beside **Copy serials**; `Devices.tsx` |
| UXI sensors **Copy names** | Done + tested | Bulk bar unique newline-joined sensor names beside **Copy serials**; `Uxi.tsx` |
| Clients **Copy names** | Done + tested | Bulk bar unique newline-joined session/hostname labels beside **Copy MACs**; `Clients.tsx` |
| Docs | Done | user-guide Devices/UXI/Clients cookbook + bulk narrative; this Loop 226 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Devices / UXI / Clients Loop 226 tests |

### Loop 228 (2026-08-04) — AuthEvents/Licences/ClearPass endpoints bulk Copy names

Independent residual pass (three operator-visible **non-chip** bulk hand-off improvements; catalog stays **44** — preferred remaining bulk **Copy names**; avoided Devices/UXI/Clients Copy names from Loop 226, SiteDetail/Central/Mist firmware Copy names from Loop 225, and Tickets/Systems/SSE from Loop 229):

| Item | Status | Anchors |
|---|---|---|
| Auth events **Copy names** | Done + tested | Bulk bar unique newline-joined `who` identities beside **Copy MACs**; `AuthEvents.tsx` |
| Licences **Copy names** | Done + tested | Bulk bar unique newline-joined subscription names beside **Copy SKUs**; `Licenses.tsx` |
| ClearPass endpoints **Copy names** | Done + tested | Bulk bar unique newline-joined hostnames beside **Copy MACs**; `ClearPass.tsx` |
| Docs | Done | user-guide Auth/Licences/ClearPass cookbook + bulk narrative; this Loop 228 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; AuthEvents / Licenses / ClearPass Loop 228 tests |

### Loop 229 (2026-08-04) — Tickets/Systems/SSE bulk Copy titles·names

Independent residual pass (three operator-visible **non-chip** bulk hand-off improvements; catalog stays **44** — preferred non-selection-empty residuals; avoided selection-empty CTA streams from Loops 207–220 and Devices/UXI/Clients Copy names from Loop 226):

| Item | Status | Anchors |
|---|---|---|
| Tickets **Copy titles** | Done + tested | Bulk bar unique newline-joined ticket titles beside **Copy IDs**; `Tickets.tsx` |
| Systems planes **Copy names** | Done + tested | Bulk bar unique newline-joined plane display names beside **Copy plane ids**; `Systems.tsx` |
| SSE inventory **Copy names** | Done + tested | Bulk bar unique newline-joined object names beside **Copy IDs**; `SseInventoryPanel.tsx` |
| Docs | Done | user-guide Tickets/Systems/SSE cookbook + bulk narrative; this Loop 229 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Tickets / Systems / SSE Loop 229 tests |

### Loop 232 (2026-08-04) — Alerts/Configure/Device clients bulk Copy titles·names

Independent residual pass (three operator-visible **non-chip** bulk hand-off improvements; catalog stays **44** — preferred remaining bulk **Copy titles** / **Copy names**; avoided Tickets/Systems/SSE from Loop 229, AuthEvents/Licences/ClearPass endpoints from Loop 228, and Devices/UXI/Clients estate Copy names from Loop 226):

| Item | Status | Anchors |
|---|---|---|
| Alerts **Copy titles** | Done + tested | Bulk bar unique newline-joined latest titles beside **Copy fingerprints**; `Alerts.tsx` |
| Configure queue **Copy titles** | Done + tested | Bulk bar unique newline-joined `what` summaries beside **Copy IDs**; `Configure.tsx` |
| Device detail clients **Copy names** | Done + tested | Bulk bar unique newline-joined client hostnames beside **Copy MACs**; `deviceDetail/tables.tsx` |
| Docs | Done | user-guide Alerts/Configure/Device detail cookbook + bulk narrative; this Loop 232 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Alerts / ConfigureBulk / DeviceDetail Loop 232 tests |

### Loop 234 (2026-08-04) — Mist rogues Copy names · Recommendations Copy titles + keyboard help

Independent residual pass (three operator-visible **non-chip** bulk/a11y improvements; catalog stays **44** — preferred remaining bulk **Copy names** / **Copy titles** and keyboard help gaps; avoided Compliance/GreenLake/Mist licences Copy names, Alerts/Configure queue titles, and Device clients names from Loop 232):

| Item | Status | Anchors |
|---|---|---|
| Mist estate rogues **Copy names** | Done + tested | Bulk bar unique newline-joined SSIDs beside **Copy BSSIDs**; `mist/rogues.tsx` |
| Recommendations **Copy titles** | Done + tested | Bulk bar unique newline-joined titles beside **Copy IDs**; `ConfigRecommendationsPanel.tsx` |
| Recommendations keyboard help | Done + tested | Header `KeyboardShortcuts` (`DATATABLE_ROW_SHORTCUTS`); `Recommendations.tsx` |
| Docs | Done | user-guide Mist/Recommendations cookbook + bulk narrative; this Loop 234 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Mist / ConfigRecommendationsPanel / Recommendations Loop 234 tests |


### Loop 235 (2026-08-04) — Site rogues/Mist audit/GreenLake roles bulk Copy names·messages

Independent residual pass (three operator-visible **non-chip** bulk hand-off improvements; catalog stays **44** — preferred remaining bulk **Copy names** / **Copy messages**; avoided Mist estate rogues + ConfigRecommendations from Loop 234, Alerts/Configure/Device clients from Loop 232, and Compliance/GreenLake members/Mist licences from Loop 231):

| Item | Status | Anchors |
|---|---|---|
| Site detail rogues **Copy names** | Done + tested | Bulk bar unique newline-joined broadcast SSIDs beside **Copy BSSIDs**; `siteDetail/RogueAps.tsx` |
| Mist org audit **Copy messages** | Done + tested | Bulk bar unique newline-joined change summaries beside **Copy admins**; `mist/audit.tsx` |
| GreenLake role grants **Copy names** | Done + tested | Bulk bar unique newline-joined role labels beside **Copy principals**; `GreenLake.tsx` |
| Docs | Done | user-guide Site detail/Mist audit/GreenLake cookbook + bulk narrative; this Loop 235 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; RogueAps / Mist / GreenLake Loop 235 tests |

### Loop 237 (2026-08-04) — Overview titles · Device ports neighbours · Central webhooks endpoints

Independent residual pass (three operator-visible **non-chip** bulk hand-off improvements; catalog stays **44** — preferred Overview bulk polish, Central bulk polish, and remaining secondary bulk copy; avoided Mist estate rogues/audit + Recommendations titles/keyboard from Loop 234, Site rogues/GreenLake roles from Loop 235, and ClearPass services / GreenLake locations names already shipped):

| Item | Status | Anchors |
|---|---|---|
| Overview Needs-you-now **Copy titles** | Done + tested | Bulk bar unique newline-joined alert titles beside **Copy devices**; `Overview.tsx` |
| Device ports **Copy neighbours** | Done + tested | Bulk bar unique newline-joined LLDP/CDP far-end names beside **Copy ports**; `deviceDetail/tables.tsx` |
| Central webhooks **Copy endpoints** | Done + tested | Bulk bar unique newline-joined callback URLs beside **Copy names**; `CentralWebhooksPanel.tsx` |
| Docs | Done | user-guide Overview/Device detail/Systems cookbook + bulk narrative; this Loop 237 row |
| Typecheck + tests | Done | monorepo `npm run typecheck`; Overview / DeviceDetail / CentralWebhooksPanel Loop 237 tests |


## 2. Current architecture (baseline)

| Layer | What exists today | Notes |
|---|---|---|
| **UI shell** | `web/src/app/*`, `web/src/nightdesk/*` | Lazy routes, error boundary, auth gate, mobile drawer, NightDesk tokens |
| **Screens** | 20+ routes in `web/src/app/routes.tsx` | Operate / Estate / Change / Platforms grouping |
| **API client** | `web/src/api/*` (barrel `client.ts`) | Honest unreachable→demo fallback; answered failures never become fixtures |
| **Server** | Express routers under `server/src/routes/*` | Health, screens, inventory, configure, diagnostics, webhooks, auth, chat, etc. |
| **Planes** | `server/src/planes/*` + poller | Central, Classic, Mist, ClearPass, UXI, AOS-8/CX, EdgeConnect, OpsRamp, SSE, GreenLake, Local |
| **Shared** | `shared/*` | Types, fixtures, topology, alerts, connectors catalog work |
| **Design archive** | `design/*.dc.html`, `docs/design-reference.md` | Spec source of truth for fidelity |

**Largest hotspots (LOC):**

| File | ~LOC | Risk |
|---|---:|---|
| `server/src/routes/screens.ts` | ~85 | Mount-order shell only (domain routes under `screens/*`) |
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
| **Global command palette polish** | **Done (Loop 128 + 131)** go-to-screen jumps + raise ticket / silence / diagnostic quick actions with deep-link cues | App shell topbar / search | — |
| **Table virtualization** | Devices/Clients/Alerts/ClearPass can grow large; no `react-window` today | `nightdesk/DataTable.tsx` / `Table.tsx` | M |
| **Saved views + column manager everywhere** | Facets/saved views exist as components; not every big table uses them | Wire into Devices, Alerts, AuthEvents, ClearPass, Licenses | M |
| **Topology visual QA + layout presets** | Interaction tests pass; browser visual proof still pending; add density/layout toggles | `Topology.tsx`, `SiteTopology*` | M |
| **Overview actionable “what changed” strip** | **Done (Loop 125 + 128)** last-hour downs/alerts/devices/clients chips + expiring-licence chip from stats | `Overview.tsx`, `web/src/lib/overviewDeltas.ts` | — |
| **Assistant panel status UX** | Provider readiness is nuanced; surface install/auth/model/MCP probe codes as a checklist | `ChatPanel.tsx`, Systems → Assistant | M |

### 4.3 P2 — Design system, a11y, polish

| Improvement | Why | Where | Effort |
|---|---|---|---|
| **Extract mega-screens into feature folders** | Configure/Clients/Alerts/ClearPass/Systems are hard to review and slow to change | `web/src/screens/<feature>/*` (partially started) | L |
| **Focus/keyboard audit on drawers & dialogs** | Mobile drawer is focus-managed; write dialogs/review modals need the same pass | NightDesk `Drawer`, Configure/ClearPass write flows | M |
| **ARIA live regions for poll/sync** | **Done (Loop 128 + 131)** Shift strip polite summary + plane enter/leave poll deltas; broader per-plane activity stream still optional | Shell + plane status | — |
| **Responsive density modes** | **Done (Loop 125)** Portal Comfortable/Compact sets `html[data-nd-density]`; tables already took the prop | tokens + `SettingsContext` | — |
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
| **Split `screens.ts` god-route** | **Done (L18–36)** — `screens.ts` is mount-order shell (~85 LOC); domain handlers under `server/src/routes/screens/*` | keep contract tests when adding routes | — |

### 5.2 P1 — Scale, freshness, and developer ergonomics

| Improvement | Why | Where | Effort |
|---|---|---|---|
| **Cursor pagination on large list screens** | Inventory already has honest cursor paging (`limit` default 25 / max 50). Devices/Clients/Alerts/AuthEvents still tend to ship full envelopes | screen routes + web client | L |
| **Conditional requests / ETag on screen envelopes** | Polling full overview/devices JSON is wasteful; support `If-None-Match` → 304 | **Done (Loop 68):** `sendCachedJson` on overview + major lists (devices/clients/sites/alerts/tickets/auth-events/uxi); remaining static screens optional | S |
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
2. ~~ETag/304 on overview + devices envelopes~~ **Done** — devices (earlier) + overview via `sendCachedJson` (Loop 68).  
3. Table virtualization.  
4. ~~Split `screens.ts` into domain modules~~ **Done** — mount shell + `screens/*`; keep contract tests on new routes.

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
server/src/routes/screens.ts    # mount-order shell only (handlers in screens/*)
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
