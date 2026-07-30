# Archived design reference

> Current implementation note: the historical prototype used Newsreader serif
> display type. Operator feedback replaced that face with a unified Inter sans
> hierarchy. The current shell also uses a 236px desktop sidebar, an off-canvas
> mobile drawer, and lazy paged hierarchy rather than the prototype's fixed flat
> navigation.
>
> A later density pass replaced the prototype's generous card spacing
> throughout. The prototype was drawn against a small demo estate; at real
> scale its per-row padding, 44px page titles and repeated inline labels pushed
> a ten-plane list past 800px of scroll. See
> [Density and scale](#density-and-scale) for the rules that supersede the
> spacing figures quoted in the sections below.

## Overview

A single operations portal for a network estate managed by **many different control planes at once**:
HPE Aruba Networking Central (new), Central Classic (legacy), Mist, GreenLake, AOS-8 mobility
master/local clusters, AOS-10 gateways, ClearPass, UXI sensors, locally-managed CX switches
(SSH only, no cloud plane), and read-only third-party gear.

The product thesis: **an engineer should work on the object, not the console.** The portal
indexes every plane, reconciles the overlaps and gaps, and renders one queue of alerts, one
device inventory, one client list, one auth log, one config surface. Where a plane accepts
writes, the portal pushes (brokered, ticket-stamped, recorded). Where it does not, the portal
hands off to that console with the payload pre-filled.

Primary user: **network engineer making changes** (not a NOC watcher). Scale designed for:
one organisation, 10 sites, ~418 devices, ~4,982 concurrent clients.

## About the design files

The files in `design/` are **design references written in HTML** — clickable prototypes that
show intended layout, hierarchy, copy and behaviour. They are **not production code to copy**.

They are authored as `.dc.html` "Design Components": static markup plus a small logic class,
rendered by a proprietary runtime (`support.js`). **Do not port the runtime.** Read them as
specification: markup = layout, the logic class = state, data shape and behaviour.

Your task is to **recreate these screens in the target codebase's own environment** using its
established patterns. If there is no environment yet, React + TypeScript + Vite is the
appropriate choice — the design system itself is a React library (see below).

### The design system is real and installable

Every visual component comes from **`@nightdesk/ui@0.1.0`**, a published React library
(`window.Nightdesk.*` in the prototypes). If you can install it, do — the component names map
1:1 with what the prototypes use:

`NightdeskProvider`, `AppShell` (+`AppShell.NavItem`), `Stack`, `Card`, `Divider`, `Heading`,
`Text`, `Code`, `Kbd`, `Table` (+`.Head/.Body/.Row/.HeaderCell/.Cell`), `Stat`, `Badge`,
`Avatar`, `Alert`, `EmptyState`, `Progress`, `Spinner`, `Skeleton`, `ToastProvider`,
`Breadcrumbs`, `Pagination`, `Tabs`, `Button`, `Input`, `Textarea`, `Select`, `Combobox`,
`Checkbox`, `RadioGroup`, `Switch`, `Slider`, `DatePicker`, `FormField`, `Dialog`, `Drawer`,
`Popover`, `Tooltip`, `DropdownMenu`, `CommandPalette`.

Wrap the app once in `<NightdeskProvider>` (paints canvas, base typography, copper lamplight
glow) and `<ToastProvider>` inside it.

If you cannot install it, rebuild the primitives from the token table at the bottom — but keep
the **visual grammar** described in "Design language" below. It is the point of the design.

## Fidelity

**High fidelity.** Colours, type, spacing, density, copy and interaction are final and should
be reproduced faithfully. Every value in the prototypes is a design token (`var(--nd-*)`) —
never a hard-coded colour. Exact token values are listed at the end of this document.

Two caveats:
- Data is **fabricated but internally consistent** (a fictional health system, "Meridian
  Health"). Treat names/numbers as realistic fixtures, not requirements.
- The prototype fakes all I/O. No network calls, no auth, no persistence.

## Design language (non-negotiable, it is the whole look)

Dark, editorial, technical. Structure comes from whitespace and hairline rules — **not boxes**.

1. **Current type voices**
   - Sans display (`--nd-font-display`, Inter): page titles, section headings, drawer titles,
     and system identities.
   - Sans body (`--nd-font-body`, Inter) 14px/12.5px: interface prose, table cell text, labels.
   - Mono (`--nd-font-mono`, JetBrains Mono) 10–12.5px: all data — device names, MACs, IPs,
     counts, timestamps, firmware, CLI, and every uppercase micro-label.
2. **Micro-label pattern** (used for every section header and field label):
   `font-family: mono; font-size: 10px; letter-spacing: .12–.14em; text-transform: uppercase;
   color: var(--nd-text-muted)`.
3. **Section header pattern**: micro-label on the left, a mono meta note or a copper text link
   on the right, with `padding-bottom: 8px; border-bottom: 1px solid var(--nd-border-default)`.
4. **Open tables, not cards.** Tables are rules-only (`Table` default "open" frame): 1px
   `--nd-border-subtle` row separators, no outer border, no zebra, first/last cell flush to the
   content edge, 16px interior cell padding (12px in compact density). Numeric columns are mono,
   tabular, right-aligned.
5. **Rows, not tiles.** Any list that would be a card grid elsewhere is a full-width row with a
   bottom hairline, a transparent 2px left border, and on hover: `background:
   var(--nd-bg-surface)` + `border-left-color: var(--nd-accent)`. Rows that open something end
   with a mono copper affordance (`Detail ▸`, `Edit ▸`).
6. **Cards are a last resort.** `Card variant="soft"|"plain"` only; `outlined` effectively never.
   The final design uses no cards at all.
7. **Copper (`--nd-accent`, #d97757) is scarce**: active nav item (on `--nd-accent-subtle`),
   links and drill-down affordances, the primary button, the 2px `Divider variant="flair"`
   section mark, the hanging rule above each `Stat`, and the active segment of a segmented
   control. Never as a background field.
8. **Semantic colour only for state**: `Badge tone="success|warning|danger|info|neutral|accent"`,
   with `dot` for live state. P1 = danger, P2 = warning, P3 = info.
9. **Stats are open** (`Stat` default, not `boxed`): copper hanging rule, mono uppercase label,
   large mono value, small delta line with `▲`/`▼`.
10. **No icons, no emoji, no illustrations.** Arrows (`→ ▸ ↓ ↗ ←`) and `▲▼` are the only glyphs.

## Application shell

Fixed two-part frame, `min-height: 100vh`, `background: var(--nd-bg-canvas)`.

**Sidebar** — 236px desktop / 208px below 1320px (`--nd-sidebar-w`),
`background: var(--nd-bg-surface)`, right border
`1px solid var(--nd-border-subtle)`, `padding: 14px 10px 12px`, sticky full height, own scroll.
Contents top to bottom:
- Wordmark: mono 10px copper `HPE` kicker, then semibold sans `Network Tools`.
  (Original design — deliberately not HPE's real mark. Swap in the real brand asset if licensed.)
- Three nav groups, each a micro-label followed by `AppShell.NavItem`s (12.5px, 500 weight,
  6px/8px padding, `--nd-radius-md`; active = `--nd-accent-text` on `--nd-accent-subtle`;
  hover = `--nd-text-primary` on `--nd-bg-raised`):
  - **OPERATE** — Overview, Alerts, Tickets, Clients, Auth events
  - **INVENTORY** — Inventory explorer, Sites, Devices, Licences
  - **GOVERN** — Configure, Compliance, Connected systems
- Footer block (top border, `margin-top: auto`): micro-label `WORKSPACE`, workspace name +
  mono `GLK`, then mono `2 of 10 systems linked`.

  The sidebar deliberately carries **no** inventory tree. An earlier build put a
  lazy `Browse inventory` tree here as well as on `/inventory`, which meant the
  same hierarchy rendered twice on one screen and cost ~340px of sidebar height
  for a duplicate of the page the user was already looking at. `/inventory` is
  now the single browse surface; the sidebar links to it.

**Topbar** — sticky, `padding: 10px 24px`, bottom border `--nd-border-subtle`, `z-index: 20`:
- `Breadcrumbs` — always `[workspace, group, screen]`; drill-downs append the site/device name.
- Global search, 420px, right-aligned: mono 12px input on `--nd-bg-inset`, placeholder
  "Jump to a site, device, MAC, IP or ticket…", two `Kbd` chips (⌘, K) pinned right.
- Identity: name 12.5px over mono 10px uppercase role, then `Avatar size="sm"`.

**Content** — `flex: 1; padding: var(--nd-content-pad-y) var(--nd-content-pad-x) 40px`
(16px/24px, dropping to `14px 16px 40px` below 820px); `max-width: 1620px`.
Target viewports: 1440 (primary) and 1920 (NOC wall). Layouts are fluid
two-column grids; nothing is fixed-width.

At 820px and below the sidebar is replaced by a left off-canvas drawer with
focus trapping and focus return. At 390px, page actions, fact grids, and system
rows stack without horizontal scrolling.

**Search behaviour** — ⌘K/Ctrl+K focuses the field and opens the panel; Escape closes; typing
combines the local index with bounded server inventory search for systems,
sites, devices, SSE objects, MACs, IPs, tickets, clients and config objects; Enter
opens the first hit; each result row is `[mono uppercase kind | label | mono meta]` and
navigates to the right screen (with the right entity selected). Clicking anywhere in the
content area closes the panel.

## Density and scale

The prototype was drawn against a demo estate of six or seven healthy planes
and a handful of sites. Real deployments are lopsided: one site carries 400
devices and a thousand ports while the next carries two, and most of the ten
supported planes are never credentialed at all. Laid out at prototype spacing
that estate produced screens that were simultaneously **too tall and too
empty** — a ten-plane list ran past 800px, of which 80% was identical
"not linked / never / — / 0" rows.

These rules supersede the individual spacing figures quoted elsewhere in this
document.

**Density tokens.** All row and page rhythm comes from
`web/src/nightdesk/tokens.css`, not from per-screen CSS. Retune here and the
whole portal moves together:

```
--nd-row-h          36px   /* a table/list row, including padding */
--nd-row-pad-y       7px
--nd-row-pad-x      10px
--nd-screen-gap     16px   /* between major blocks on a screen */
--nd-block-gap      10px   /* within a block */
--nd-panel-pad      12px
--nd-content-pad-x  24px   /* content area gutters */
--nd-content-pad-y  16px
--nd-sidebar-w     236px
--nd-topbar-h       48px
```

**Page headers are one band.** `ScreenHeader` renders title + subtitle +
actions on a single row above a hairline. It does **not** paint an overline —
the topbar breadcrumb already says where you are, and printing it twice cost a
whole line on every screen. The path is still emitted as a `data-path`
attribute for tests and for anything that needs the ancestry. `--nd-heading--1`
is 26px, not the prototype's 44px display size. Below 900px the actions drop
under the copy.

**Repeated dead state collapses.** Where a list contains many rows that all say
the same nothing — planes with no credentials, unsupported object kinds — the
rows are partitioned into active and dormant, and the dormant set renders as a
single expandable line (`8 systems not linked · no credentials stored`) with
correct `aria-expanded`. This is a real disclosure, not a filter: expanding
restores every row unchanged. Applied on Connected systems, the Inventory
Explorer tree (server-side, as a `group:dormant` node), the Overview management
rail, and Configure's "Where a change can go".

The partition always reads an **explicit boolean** from the payload
(`OverviewPlaneRow.linked`, `CapabilityRow.linked`), never a regex over
human-facing prose. Copy is free to change wording; identity and state are not.

**Lists are tables, not cards.** A repeated record gets one dense row with a
shared column header, not a card that reprints `LAST SYNC / DEVICES / CALLS
TODAY` as inline labels on every instance. Below 1080px the header is hidden
and the same cells become a labelled wrapped strip — the labels come back via
`data-label` + `::before`, so **no information is dropped at narrow widths**;
it is re-flowed. (An earlier attempt simply hid the cells and lost data.)

**Columns that say nothing collapse too.** The row-level rule above has a
column-level twin, in `web/src/screens/dataColumns.tsx`. A column whose every
row answers identically is dropped from the table and stated once underneath —
`Same on all 39 sessions: Site SecureSSID · Plane CENTRAL · Health connected`.
In a single-site workspace that is four columns of the Clients table spent
repeating one word thirty-nine times; on a healthy access switch it is the
spanning-tree role on all sixteen ports. Left as columns they pushed the health
verdict, the one thing those lists exist to show, off the right edge.

Rules the helper enforces:
- The fact is never hidden, only **stated once** instead of *n* times.
- A single disagreeing row brings the whole column back — that is precisely
  when it starts earning its width.
- Fewer than three rows is never collapsed: with two rows "they agree" is a
  coincidence, not a property of the data.
- A plane's "not reported" marker (`—`) counts as **absent**, so a column no
  row answers drops silently rather than collapsing to the fact `Group —`.
- Collapsing keys on the cell's **text value**, which is also what renders, so
  the two can never drift apart.

Used by the Clients table and the device-detail Ports table.

**One fact per column.** Two values stacked in one cell (type over model, role
over VLAN, auth over authenticator) make every row two lines tall and put
values in a column where they cannot be compared. Give each its own column and
let the collapse above remove the ones that turn out to be constant.

**Panels are content-driven, never fixed-height.** This is the specific lever
that makes a two-device site and a four-hundred-device site both look right.
Panes size to their content with a `max-height` cap (typically
`calc(100vh - var(--nd-topbar-h) - 150px)`) and a small `min-height` floor, and
scroll internally past the cap. A fixed `height` would leave the small estate
staring at a void and the large one at a scrollbar inside a scrollbar.

**Grids auto-fit.** Stat rails are `repeat(auto-fit, minmax(148px, 1fr))`
rather than `repeat(4, 1fr)`, so three stats do not leave a quarter of the row
blank and six do not overflow.

**No horizontal scrolling** at 1440, 1280, 1024, 768 or 390 CSS pixels, on any
route. Verify with an exact-width device-metrics override — note that
`Emulation.setDeviceMetricsOverride` with `mobile: true` reports
`innerWidth: 980` at a 390px device width and will hide real overflow; use
`mobile: false`.

## Screens

Every screen opens with the same header block: `Heading level={2}` with a mono `overline`
("Group / Screen"), one serif-italic 15px subtitle line, and right-aligned actions
(`Button size="sm"`, ghost → secondary → primary, left to right).

### 1. Overview — `design/NtOverview.dc.html`
Single pane of glass. `Stat` row of five (Devices reachable 404/418, Open alerts 7, Config drift
12, Licences ≤60d 34, Planes linked 6/7) → `Divider variant="flair"` → two columns
(`minmax(0,1.5fr) minmax(0,1fr)`, gap 34px).
- Left: **Needs you now** — four alert rows (severity `Badge` + dot in a 34px gutter, title
  14px, mono meta, plane `Badge`, mono age, ghost `Inspect` → device detail); **Sites** — open
  table (Site / Managed by / Devices / Clients / Health / Alerts) with a 64×3px health bar
  (track `--nd-bg-inset`, fill success/warning, `border-radius: 99px`).
- Right: **Management planes** — seven rows (name + mono scope kicker, state `Badge` with dot,
  mono last-sync right-aligned in 52px); **Launchpad** — five hairline rows (label + mono hint,
  copper left-rule on hover) that jump to a console, a terminal or a report; **Change log** —
  four rows (mono time in a 46px gutter, what, who).

### 2. Alerts — `design/NtAlerts.dc.html`
De-duplicated queue across all planes. Header actions: Acknowledge (ghost), Raise ticket
(secondary). A `danger` `Alert` correlates the two worst findings ("Riverside Clinic is dark —
and its plane is stale"). Filter row: severity `Select` (150px), plane `Select` (170px), mono
text `Input` (230px), "Unacknowledged only" `Switch`, right-aligned mono count. Open table:
Sev (`Badge` + dot) / Alert (title + mono detail) / Site / Plane / State / Age (numeric) /
`Inspect`. 12 fixtures spanning P1–P3 and every plane. Empty filter result → `EmptyState`.

### 3. Tickets — `design/NtTickets.dc.html`
Ticket-driven troubleshooting. Two columns (300px / 1fr, gap 32px).
- Left: queue of five tickets as selectable rows — mono id (copper), mono age, title, priority
  `Badge`, mono site. Selected row: `border-left: 2px solid var(--nd-accent)` +
  `background: var(--nd-bg-raised)`.
- Right: the workspace — mono id, priority + state `Badge`s, right-aligned SLA countdown in
  `--nd-warning`; `Heading level={3}` title; a four-up meta grid (Reported by / Site / Owner /
  Planes touched) between hairlines; an `info` `Alert` stating the likely cause; **Evidence,
  gathered across planes** — rows of `[mono time 46px | plane Badge 88px | finding + mono raw |
  ghost button naming the device]`, one per plane, which is the core idea: the portal assembles
  evidence from Mist, ClearPass, local SSH and UXI into one narrative; **Next actions** — three
  ticket-specific buttons + Escalate; a `Textarea` note box that mirrors to ServiceNow.

### 4. Clients — `design/NtClients.dc.html`
Every session, wired and wireless, whichever plane authenticated it. `Stat` row (Clients now
4,982 / Wireless 4,410 / Wired 572 / Failing auth 24 / Poor experience 61). Filters: search,
medium, device type, site, group, plane, "Problems only". Open table, 10 columns:
Client (name + mono MAC) / Type (mono category + model) / Site / Group / Connected to (copper
mono AP-or-switch + where) / Plane / Auth (method + authenticator) / Role / VLAN / Health
(`Badge` + dot) / Session (numeric).

**Client drawer** (`Drawer width="lg"`, title = client, description = role · group · site):
- State `Badge`s + mono session length.
- **Experience** — 3×2 grid of metrics (Signal, SNR, Retries, Throughput, Roams, IP): mono
  micro-label, 15px mono value that turns `--nd-warning` when it misses its target, mono note
  naming the target. Then `Progress` "Connection quality score" and a one-line verdict.
- **Where it is** — Site, Zone (down to bed bay / dock door), Group (and what it inherits),
  Attached to, Wiring (closet · port · PoE draw).
- **Path to the internet** — the client's actual forwarding path as a vertical chain: an 11px
  gutter holding a 9px status dot per hop and a 1px `--nd-border-default` connector; each hop
  shows copper mono device name (clickable → device detail; non-devices are plain), 11.5px role,
  state `Badge`; between hops a mono `↓ link fact` (`5 GHz · ch 36 · −52 dBm · 866 Mbps`,
  `1 Gb access port 1/1/14 · vlan 820`, `20G lag to core`, `transit vlan 12 · 10G to gateway`,
  `2 × 10G to DC1 · rtt 3 ms`). Header meta counts hops and degraded hops. Chains differ by
  path type: wireless via AP → access switch → core → gateway → break-out; AOS-8 wireless
  tunnels through a local controller; wired starts at the access switch; VPN starts at
  residential broadband into the gateway.
- **Session timeline** — assoc → RADIUS decision → DHCP → roam → sensor corroboration →
  portal correlation, each with plane and raw log line. Three variants: healthy, auth-reject,
  DHCP-starved.
- **Actions** — Reauthenticate, Inspect <attach>, Auth history, Block endpoint (danger).

### 5. Auth & policy events — `design/NtAuthEvents.dc.html`
Every RADIUS decision. `Stat` row (Auths/min 412, Accept rate 98.6%, Rejects/hour 24, MAB
fallbacks 61, Known endpoints 4,182). Filters: search, result, service, plane. Open table:
Time (mono) / Endpoint (user + mono MAC, → Clients) / Service / Method / Result (`Badge` + dot)
/ Reason + mono role / NAS device (copper, → device detail) / Plane. Below a `flair` divider,
two columns: **Why authentications failed** — five `Progress` bars (`max=60`) with mono notes;
**Policy services** — six rows with mono auths/hour and a state `Badge`.

### 6. Sites — `design/NtSites.dc.html`
`Stat` row (Sites 10, Devices 418, Clients 4,982, Sites with alerts 4). Filters: plane `Select`,
name `Input`, Add site. Open table: Site (name + mono subnet, → site detail) / Managed by
(**multiple** plane `Badge`s — the point: a site can answer to two planes) / Mix (mono
`96 ap · 42 sw · 6 gw · 4 uxi`) / Devices / Clients / Health (70×3px bar) / Alerts / Last sync.
Ten fixtures including a Classic-managed site whose health is `—` because its inventory is
stale, and a local-only site with no cloud plane. Footer: mono count + `Pagination`.

### 7. Site detail — `design/NtSiteDetail.dc.html`
Header actions: ← All sites, Open in <plane>, Local terminal (primary). Five `Stat`s (Devices,
Clients now, Health, Open alerts, Config drift) → `flair` → two columns (1.6fr / 1fr).
- Left: **Devices at this site**, meta `MIXED PLANES` — open table (Device (copper mono) /
  Model / Managed by / Role / State / Uptime) mixing local switches, cloud APs, controllers,
  sensors and ClearPass in one list.
- Right: **Site facts** (Address, Subnets, WAN, Core, Planes, and a site-specific constraint
  like "Change window 01:00–04:00 only — clinical floors"); **Local reachability** — collector
  state `Badge`, `Progress` "Devices answering directly", mono collector note, and a button
  opening a terminal on the site's core switch; **Open here** — the site's alerts.
- Four authored profiles (Campus-01, Lakeshore AOS-8, Riverside Classic-stale, local-only
  fallback) demonstrate how the screen changes per management model.

### 8. Devices — `design/NtDevices.dc.html`
Unified inventory with **two selectable presentations** (segmented control, top right):
- **Unified table** — one flat list: Device (copper mono) / Model / Type / Site / Managed by /
  State / Firmware (amber when off the approved train) / Licence.
- **Platform lanes** — `repeat(auto-fit, minmax(196px, 1fr))` columns, one lane per plane. Lane
  header: mono plane name, mono shown-count, 2px bottom rule in the plane's colour, sync `Badge`
  + mono note. Lane body: hairline device rows (mono name + 6px state dot, model, site),
  max-height 520px with own scroll. Makes ownership and gaps legible at a glance.
Filters: search, type, plane, site, "Reconciliation issues only". A `warning` `Alert` states the
reconciliation truth: 3 devices claimed by two inventories, 14 by none.

### 9. Device detail — `design/NtDeviceDetail.dc.html`
Header: `Heading` = device name, mono meta line (state `Badge`, plane `Badge`, model · site ·
IP), actions ← Inventory / Open in <plane> / Save config / Reboot (danger). Five `Stat`s vary by
device class. `flair` → a wide telemetry column and a fixed identity rail
(`.nt-device-layout`, `minmax(0, 1fr) minmax(260px, 320px)`, stacking to one column at 1100px).
The telemetry — class block, diagnostics, clients — leads the main column and the identity
key/values sit in the rail; the prototype's proportional split gave the sixteen-port list 434px
of a 1440px screen while the wide column held two "not available" notes.
- Main column, in order: the class block (Ports of interest / Cluster members / Radios & SSIDs /
  Tunnels / Services, chosen by device class), **Active diagnostics**, **Clients on this device**,
  then **Local terminal** — a working canned shell on `--nd-bg-inset` with a titlebar (status
  dot, mono `ssh r.okafor@10.42.8.11 — via collector`, right `AES-256 · idle 14:52`), a 352px
  scroll region (mono 11.5px, line-height 1.65; input lines copper, output secondary, warnings
  amber), a live prompt input, quick-command chips and `clear`. Command sets differ per class:
  CX (`show version|system|interface brief|vlan|lldp neighbor|running-config vlan 812`) and
  AOS-8 (`show version|switches|ap database|datapath tunnel`); `?` lists what the portal can
  proxy; unknown input returns a platform-accurate parse error. Cloud-claimed devices get **no
  shell** — the panel becomes read-only telemetry plus an `info` `Alert` and a
  "request remote shell" affordance. Auto-scrolls to the newest line.
  **Then: Configuration** — segmented control Running / Drift vs. baseline / History.
  Running and Drift render in `Code block` (Drift as a real `-`/`+` diff with
  `← baseline` annotations); History is hairline rows (mono when, what, who + ticket, tag
  `Badge` push/shell/upgrade/baseline). Actions: Snapshot config now, Push baseline fix,
  Download config.
- Rail: **Identity** (serial, role, firmware vs. approved, mgmt IP, base MAC, managed-by,
  location, last change, owner) and **Compliance** — pass/fail `Badge` rows + link to the full
  report. Nothing that needs width belongs here.

### 10. Licences — `design/NtLicenses.dc.html`
GreenLake subscriptions, controller perpetuals and Mist SUBs reconciled against what is racked.
Five `Stat`s. A `warning` `Alert` naming the two gaps that cost money. Open table: Subscription
(name + mono SKU) / Plane / Term / Qty / Assigned / Utilisation (80×3px bar, amber ≥95%) /
Expires / Status. `flair` → two columns: **Renewals, soonest first** (mono date, what, days
coloured by urgency) and **Orphans & gaps** (tag `Badge` + what + mono detail, with Reclaim all).

### 11. Configure — `design/NtConfigure.dc.html`
The write surface. Four `Stat`s (Queued changes, Pushed today, Config objects, Drift open). An
`info` `Alert` explaining the brokered-write model. Two columns (1.55fr / 1fr).
- Left: three open lists, each with an inline `+ Add` link and `Edit ▸` rows —
  **Wireless SSIDs** (name + mono vlan, security, targets, plane `Badge`), **Switch ports**
  (collapsed switch identities with counts/status; 25 port children at a time), **VLANs & roles** (mono id,
  name, mono detail, role).
- Right: **Queued changes** — three entries with state `Badge` (ready / needs window / console),
  what, where, mono ticket, plus Push queue / Discard; **Where a change can go** — the
  capability matrix, one row per plane with a mode `Badge` (brokered / ssh / read only).
- **Edit drawer** (`width="lg"`), form varies by object kind:
  - *SSID*: name, VLAN, security `Select` (WPA3-Enterprise / WPA2-Enterprise / PSK+portal /
    WPA2-PSK / Open), target group `Select`, bands `Select`, and `Switch`es for Broadcast,
    Client isolation, Exclude DFS channels.
  - *Switch port*: switch `Select`, interface, description, mode `Select` (access/trunk), VLAN,
    and `Switch`es for PoE, 802.1X, MAC-auth fallback, Administratively up.
  - *VLAN*: id, name, DHCP helpers (comma list), scope `Select`.
  - All three then show **What gets pushed** — a `Code block` that **regenerates live from the
    form** into plane-accurate syntax (AOS `wlan ssid-profile` + `ap-group`, CX `interface` /
    `vlan` stanzas) with trailing comment lines naming the API call per plane and what stays
    read-only; **Blast radius** (APs reloading, sessions re-authenticating, planes touched, or
    switches in scope / clients on the VLAN / findings resolved); a **required ticket reference**
    that gates the primary button; then Queue the change / Dry run / Cancel and a mono note on
    how that specific push is executed.

### 12. Compliance — `design/NtCompliance.dc.html`
Five `Stat`s (Checks last run 1,842, Devices in scope 404, Findings 12, Sites clean 6/10,
Auto-remediable 7). Baseline `Select` + Diff selected + Run scan now. `flair` → two columns
(1.7fr / 1fr): **Findings** open table (Sev `Badge` / Finding + mono detail / Rule (mono, e.g.
`vlan.tunnel.mtu`) / Plane / Devices (copper count → device detail) / Fix (auto | manual |
window | ssh scan, colour-coded)); right — **Pass rate by baseline** (five `Progress` bars with
mono notes) and **Drift, as text** (`Code block` diff) with Push fix / Accept as exception.

### 13. Connected systems — `design/NtSystems.dc.html`
Header: Sync all (ghost), Connect a system (primary). A `danger` `Alert` about Classic
throttling, dismissible. **Planes** — seven full-width open rows, each: 230px block (serif 16px
name + mono uppercase kicker `cloud · new central · us-west-4`), 96px state `Badge`, a flexible
inline fact strip (Last sync / Devices / Calls today / Token — mono micro-label over mono value,
26px gaps), 180px right-aligned scope `Badge` + mono note, and `Detail ▸`. Hover lights the row
and its copper left rule. Below: `flair` → **Sync history** (mono time, mono system, what,
result `Badge`) and **Permissions model** (prose + four mode rows).
- **Plane detail drawer** — segmented Summary / Activity / Configuration.
  *Summary*: fact grid, **Sites on this plane**, **Live on this plane** (sessions, devices,
  alerts sourced here), and jump-outs to Devices / Clients / Auth events.
  *Activity*: **API calls** (mono time, path, latency, status `Badge` — including the real 429s)
  and **Recent events** (brokered writes, token rotations, cluster changes).
  *Configuration*: **What the portal pulls** (resource, interval, read/write `Badge`), a
  `Code block` of the credential/connection record (vault reference, scopes, rate limit,
  retention, write-broker policy), and Sync now / Re-key credentials / Open console / Retire
  plane (danger).
- **Connect a system drawer** — type `Select` (7 planes), display name, a
  **type-dependent endpoint field** (label, help and placeholder all change with the plane:
  Central API gateway, Mist host + org UUID, Classic tenant URL, GreenLake workspace id, AOS-8
  master address, collector agent address, ClearPass publisher), client id, client secret
  (password), four scope `Checkbox`es (inventory / clients+auth / config+licences / brokered
  write). **Test connection** shows a loading button for ~900ms then a `success` `Alert`
  reporting what was found — and only then does **Save and index** enable.

## Interactions & behaviour

- **Navigation** is client-side view switching held in the shell: `view` plus `siteName` and
  `deviceName` for the two drill-down screens. Nav clicks, breadcrumb context, and every
  in-content affordance (site names, device names, NAS devices, alert Inspect, path hops,
  launchpad rows) all route through the same two callbacks: `openSite(name)`, `openDevice(name)`.
  Implement with a real router; the URL should carry view + entity.
- **Filters** are local, instant, additive (AND), and never paginate away state. Every filtered
  table shows `N of M` in mono. Clearing to zero results shows `EmptyState`, not a blank table.
- **Drawers** are controlled (`open` + `onOpenChange`), portalled, 560px (`width="lg"`), with an
  independently scrolling body, serif title, and a description line. Escape and overlay click
  close. Opening a drawer that navigates away closes it first.
- **Segmented controls** (view toggle, plane detail tabs, config tabs) are plain button pairs or
  triples in a 1px bordered 3px-padded shell; the active button is `--nd-accent-text` on
  `--nd-accent-subtle`, the rest `--nd-text-muted` on transparent.
- **Terminal**: Enter submits; the prompt line echoes copper; responses append; `clear` resets to
  the session banner; quick-command chips submit canned commands; the pane auto-scrolls to the
  bottom on update; switching device resets the buffer.
- **Live preview**: the Configure code block recomputes on every keystroke and toggle. This is
  the screen's whole value — do not defer it behind a "Preview" button.
- **Gating**: Save-and-index requires a successful test; Queue-the-change requires a ticket
  reference. Both are visually disabled until satisfied.
- **Hover** on interactive rows: 120ms `--nd-duration-fast` background + border transition.
- **Density** is a global setting (comfortable / compact) threaded to every `Table`.
- **Platform tags** can be hidden globally (`showTags`) for a quieter, single-plane look.
- Nothing auto-refreshes in the prototype; the design assumes a 30–60s poll with the
  "SYNCED 09:41 · AUTO 60s" line in the Overview header reflecting it.

## State management

Shell state: `view`, `siteName`, `deviceName`, `query`, `searchOpen`; global settings `density`,
`inventoryView`, `showPlatformTags`, `workspaceName`. Per-screen local state: filter values
(`q`, plane, site, group, type, medium, result, service, severity, baseline, issuesOnly,
problemsOnly, unackedOnly), selection (`selectedTicket`, `selectedClientMac`, `detailPlane`),
drawer open flags, terminal (`lines[]`, `cmd`), config tab, and the Configure form models
(`ssid{}`, `port{}`, `vlan{}`) plus `ticket` and `queued`.

In a real build, everything above the filter line is server state (fetch + cache per plane, with
a per-plane freshness stamp, because **staleness is part of the UI**: Classic is 6h behind and
the design says so in five places). Everything below is client state.

## Data model (from the fixtures)

```ts
type Plane = 'CENTRAL' | 'CLASSIC' | 'MIST' | 'GREENLAKE' | 'AOS-8' | 'AOS-10'
           | 'LOCAL' | 'CLEARPASS' | 'UXI' | 'THIRD-PARTY';

interface System {           // a connected control plane
  name: string; kind: string;                    // "cloud · new central · us-west-4"
  state: 'healthy'|'degraded'|'warning'; scope: 'read only'|'read + broker'|'read + ssh';
  scopeNote: string; facts: {k,v}[];             // last sync, devices, calls today, token
  sites: {name,detail}[]; live: {value,label}[];
  calls: {time,path,ms,code,tone}[]; events: {time,what,who}[];
  pulls: {what,every,mode:'read'|'write'|'ssh'}[]; configText: string;
}

interface Site {
  name: string; subnet: string; planes: {name: Plane, tone}[];   // MAY BE MORE THAN ONE
  mix: string; devices: number; clients: string;
  health: string|null; healthPct: string;        // null = inventory stale, cannot assert
  alerts: string; sync: string;                  // "6h" for a throttled plane
}

interface Device {
  name: string; model: string; type: 'switch'|'ap'|'gateway'|'controller'|'sensor'|'policy';
  site: string; plane: Plane; state: string; firmware: string; firmwareApproved: boolean;
  licence: string; reconciliationIssue: boolean; // double-claimed OR in no cloud plane
  localShell: boolean;                           // false for cloud-claimed devices
}

interface Client {
  name: string; model: string; type: 'laptop'|'phone'|'tablet'|'medical'|'imaging'|'voip'
    |'printer'|'kiosk'|'building'|'unknown';
  mac: string; ip: string|'pending'; medium: 'wired'|'wireless';
  site: string; group: string;                   // config group it inherits
  attach: string; where: string;                 // AP or switch + port/zone
  plane: Plane; auth: string; authBy: string; role: string; vlan: string;
  health: string; session: string; problem: boolean;
  link: string; rssi: string; snr: string; retries: string; tput: string; roams: string;
  quality: number;                               // 0-100 score
  zone: string; closet: string;                  // physical location + wiring
}

interface PathHop {           // computed, not stored
  name: string; role: string; state: string; tone: Tone;
  link: string|null;          // fact about the segment to the NEXT hop
  device: boolean;            // clickable through to device detail
}

interface AuthEvent {
  time: string; who: string; mac: string; service: string; method: string;
  result: 'accept'|'reject'|'timeout'; reason: string; role: string;
  nas: string; plane: Plane;
}

interface Alert {
  sev: 'P1'|'P2'|'P3'; title: string; detail: string; site: string; plane: Plane;
  state: 'open'|'acked'|'cleared'; age: string; device: string;
}

interface Ticket {
  id: string; pri: string; state: string; title: string; site: string; age: string;
  reporter: string; owner: string; planes: string; sla: string;
  causeTitle: string; cause: string; action1..3: string;
  evidence: {time, plane, finding, raw, device|null}[];
}

interface Subscription {
  name: string; sku: string; plane: Plane; term: string; qty: string; assigned: string;
  pct: string; expires: string; status: 'active'|'expiring'|'idle'|'retiring';
}

interface Finding {          // compliance
  sev: 'high'|'med'|'low'; title: string; detail: string; rule: string; plane: Plane;
  count: string; fix: 'auto'|'manual'|'window'|'ssh scan'; device: string; baseline: string;
}

interface ConfigObject {     // ssid | port | vlan | role
  kind: 'ssid'|'port'|'vlan'|'role'; /* see Configure screen for each form's fields */
}

interface ChangeRequest {
  object: ConfigObject; ticket: string;          // REQUIRED
  state: 'ready'|'needs window'|'console'; where: string;
  rendered: string;                              // plane-specific payload
}
```

## Integration model (the part that matters most)

| Plane | Read | Write | Notes |
|---|---|---|---|
| HPE Aruba Central | inventory, clients, alerts, config, licences | **brokered** (ticket + 15m lease) | primary write target |
| Local switch collector (SSH agents) | CLI state, running config, MAC tables | **brokered** + recorded shell | only plane for 14 switches |
| AOS-8 mobility master | cluster, APs, clients, datapath | recorded SSH, **change window only** | via jump host |
| Mist | inventory, clients, SLE, alarms, config mirror | **none** — hand off to console with payload | rate-limited 20k/day |
| Central Classic | inventory, alerts (throttled) | none | 429s every third poll; retires 12 Aug |
| GreenLake | subscriptions, assignments, identity | none | licence reconciliation source |
| ClearPass | auth/accounting events, endpoints, policy | none | policy edited in ClearPass |
| UXI | sensor test results | none | corroborating evidence |

Design rules that follow from this and must survive the build:
1. **Never present stale data as current.** A plane that is behind says so, and its devices read
   `unverified` rather than `up`.
2. **Reconcile, don't duplicate.** A device claimed by two planes is one row flagged
   `double-claimed`; a device in no cloud plane is still a first-class row.
3. **No standing write access.** Writes need a ticket reference, hold a short lease, are
   recorded, and keep a rollback snapshot.
4. **Read-only planes are honest.** The portal offers a pre-filled console hand-off, never a
   fake edit form.

## Design tokens (exact values)

```css
/* backgrounds */      --nd-bg-canvas:#0d0f14; --nd-bg-surface:#151821;
                       --nd-bg-raised:#1b1f2b; --nd-bg-inset:#0a0c10;
/* borders (1px)  */   --nd-border-subtle:#232837; --nd-border-default:#2e3547;
                       --nd-border-strong:#3d4560;
/* text */             --nd-text-primary:#eef0f6; --nd-text-secondary:#8b93a7;
                       --nd-text-muted:#5c6478; --nd-text-inverse:#14100d;
/* accent (copper) */  --nd-accent:#d97757; --nd-accent-hover:#e28a6c;
                       --nd-accent-active:#c96845; --nd-accent-text:#e08a66;
                       --nd-accent-subtle:rgba(217,119,87,.14); --nd-glow:rgba(217,119,87,.07);
/* semantic */         --nd-success:#57dc96; --nd-success-subtle:rgba(87,220,150,.12);
                       --nd-warning:#f5c518; --nd-warning-subtle:rgba(245,197,24,.12);
                       --nd-danger:#ff6b6b;  --nd-danger-subtle:rgba(255,107,107,.12);
                       --nd-info:#58b7ff;    --nd-info-subtle:rgba(88,183,255,.12);
/* focus/overlay */    --nd-ring-color:rgba(217,119,87,.4); --nd-overlay-scrim:rgba(5,6,9,.66);
/* type families */    --nd-font-display:"Newsreader",Georgia,"Times New Roman",serif;
                       --nd-font-body:"Inter",-apple-system,system-ui,sans-serif;
                       --nd-font-mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
/* type sizes */       10, 11, 12.5, 14, 16, 18, 22, 26, 34, 44 px
                       (--nd-text-10 … --nd-text-44; note --nd-text-12 is 12.5px)
/* spacing */          4, 8, 12, 16, 20, 24, 32, 40, 48, 64 px (--nd-space-1 … -10)
/* radius */           sm 3px, md 4px, lg 6px, xl 8px, full 999px
/* shadow */           --nd-shadow-raised:0 4px 16px rgba(0,0,0,.35);
                       --nd-shadow-overlay:0 16px 48px rgba(0,0,0,.5);
/* motion */           --nd-duration-fast:120ms; -base:180ms; -slow:240ms;
                       --nd-ease:cubic-bezier(.25,.6,.3,1);
/* z-index */          overlay 100, dropdown 120, toast 140
```

Heading levels: 1 = 44px, 2 = 26px (page titles), 3 = 18px, 4 = 16px — all in the serif face.
Button heights: sm 26px, md 32px, lg 38px. Input/Select heights match.

## Assets

None. No images, icons, logos or illustrations are used anywhere — deliberately. The only
graphics are CSS: hairline rules, 3px progress/health bars, 6–9px status dots, and the copper
`flair` divider. Fonts are Newsreader, Inter and JetBrains Mono (Google Fonts / self-host).

The wordmark is text ("HPE" mono kicker + serif italic "Network Tools") and is an original
placeholder, not HPE's brand mark. Replace with the real licensed asset if you have rights to it.

## Files in this bundle

| File | Screen |
|---|---|
| `design/HpeNetworkTools.dc.html` | App shell — nav, topbar, global search, routing, global settings |
| `design/NtOverview.dc.html` | Overview |
| `design/NtAlerts.dc.html` | Alerts |
| `design/NtTickets.dc.html` | Tickets |
| `design/NtClients.dc.html` | Clients + client drawer with the path diagram |
| `design/NtAuthEvents.dc.html` | Auth & policy events |
| `design/NtSites.dc.html` | Sites |
| `design/NtSiteDetail.dc.html` | Site detail |
| `design/NtDevices.dc.html` | Devices — unified table + platform lanes |
| `design/NtDeviceDetail.dc.html` | Device detail — terminal, configuration, clients, compliance |
| `design/NtLicenses.dc.html` | Licences & subscriptions |
| `design/NtConfigure.dc.html` | Configure + SSID / port / VLAN edit drawers |
| `design/NtCompliance.dc.html` | Compliance |
| `design/NtSystems.dc.html` | Connected systems + plane detail drawer + connect drawer |
| `design/ds-base.js` | How the prototypes load the design system (reference only) |

Reading a `.dc.html`: the markup between `<x-dc>` and `</x-dc>` is the layout; `{{ name }}` are
value holes; `<sc-for list="{{ xs }}" as="x">` is a list; `<sc-if value="{{ flag }}">` is a
conditional; `<x-import component-from-global-scope="Nightdesk.Button">` mounts a design-system
component; the `<script data-dc-script>` block at the bottom holds the state, fixtures and
handlers. Ignore `hint-*` attributes — they are streaming placeholders.

## Suggested build order

1. Shell + routing + design system wiring + the token/typography grammar. Get one screen
   (Overview) pixel-right before adding others; every later screen reuses its patterns.
2. Read-only screens against real APIs, in this order: Devices → Sites → Site detail → Device
   detail (without terminal) → Alerts. This forces the multi-plane fetch/reconcile layer early.
3. The reconciliation layer itself: identity matching across planes, double-claim detection,
   no-plane devices, per-plane freshness stamps.
4. Clients + Auth events, then the path computation (topology join: client → AP → switch port →
   core → gateway → edge).
5. Compliance (baselines + diff engine) and Licences (GreenLake reconciliation).
6. Terminal (recorded SSH proxy, session logging) — a security-sensitive component; treat the
   design's recording/lease language as requirements.
7. Configure + the brokered-write pipeline (render per plane, ticket gate, lease, dry run,
   queue, push, rollback snapshot) and the console hand-off for read-only planes.
8. Tickets, then the cross-plane evidence collector that fills them.

---

## Running the app (the build that ships in this repo)

The portal is implemented as an npm-workspaces app: `web/` (React + TypeScript + Vite,
in-repo nightdesk design system), `server/` (Express + TypeScript API, plane adapters,
write broker, SSH terminal bridge, MCP chat), `shared/` (domain types, demo fixtures,
preview/terminal/topology logic shared by both).

```bash
npm install          # installs all workspaces
npm run dev          # web build watch + one UI/API/WebSocket server (:5173)
# or single-port production mode:
npm run build        # builds web → web/dist (server serves it with SPA fallback)
npm start --workspace server   # http://localhost:5173
```

On macOS you can also double-click `start-dev.command` in Finder — it runs
`npm run dev` in a Terminal window and opens http://localhost:5173 once the API
answers (Ctrl+C in that window stops everything).

- **Demo mode** (default): every screen is fully populated from the prototype fixtures.
  Toggle `demoMode` via `PUT /api/settings` or by editing `data/settings.json`.
  With demo mode on, `blendLive: true` (Connected systems → "Blend live sections into
  demo") swaps a screen's section to real poller rows as soon as a linked plane
  reports them — sections without live data stay on fixtures, and the API envelope
  names the swapped sections in `blended`.
- **Per-screen sources**: Connected systems → "Screen sources" pins any screen
  (overview, alerts, clients, auth events, sites, devices, licenses, configure,
  compliance, systems) to demo or live independently of the portal default, via
  `sectionMode` in `data/settings.json`. Each response's `dataSource` reflects
  that screen's effective source, and a live pin keeps the poller active even
  while the rest of the portal remains in demo mode.
- **Live/error behavior**: the web app uses local fixtures only when the API
  server is unreachable. If the server answers with an error, the screen shows
  that error instead of silently substituting demo inventory. Connected systems
  → Sync all triggers an immediate poll of every linked plane.
- **Real planes**: Connected systems → Connect a system. Credentials (Central OAuth,
  GreenLake, ClearPass, local SSH collector) save to `data/settings.json` (0600,
  git-ignored), are only ever returned masked, and "Test connection" validates them for
  real before "Save and index" enables. Live data then merges with per-plane freshness
  stamps; stale planes render their devices `unverified`.
- **SSH terminal**: save `local` plane creds (username + password or privateKey; optional
  jump `host`/`port`). Device detail flips the terminal to `LIVE · recorded` when a
  session opens; commands pass a read-only allow-list and every session is recorded to
  `data/shell-logs/`. Without reachable SSH the pane runs the faithful canned shell.
- **Assistant (⌘J)**: configure MCP (centralmcp streamable HTTP, default
  `http://127.0.0.1:8010/mcp`) and an OpenAI-compatible LLM in Connected systems →
  Assistant. Read-only tools by default; write tools need the server-side write-mode
  switch plus a per-session toggle in the panel.
- **Verification**: `npm run typecheck` · `npm test` · `npm run build` ·
  `bash scripts/smoke.sh` (every API route + SPA route).
