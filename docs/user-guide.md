# User guide

## Navigation

The desktop navigation is grouped by task:

- **Operate:** overview, topology, alerts, tickets, clients, authentication
  events, ClearPass, Central, Mist, and UXI.
- **Inventory:** Inventory Explorer, sites, devices, and licences.
- **Govern:** GreenLake, configuration, compliance, and connected systems.

Three of those entries are full screens that are easy to miss: **GreenLake**
(subscriptions and workspace inventory) leads the Govern group, while
**ClearPass** (endpoint repository with its auth feed) and **UXI** (sensor
fleet with inline issue detail) close out Operate.

The two richest planes also have their own operational screens. **Central**
(at `/central`) gathers the plane's fleet stats, per-site health, firmware
verdicts, WLAN summary, its alert slice, and site-picked application
visibility. **Mist** (at `/mist`) gathers SLE scores across sites, rogue and
neighbor APs, AP radio and power health, WLANs, firmware, licence usage, and
the org audit log with webhook-registration status. Configuration for both
stays under Connected systems.

The **Assistant** is a chat drawer over the estate, opened from the topbar or
with ⌘J (Ctrl+J on other platforms). It answers through a configured MCP
server and OpenAI-compatible LLM — set both under **Connected systems →
Assistant**; until then the panel says so instead of guessing. Tools stay
read-only unless the server-side write mode and the panel's own per-session
switch are both on. The archived [design reference](design-reference.md)
carries the panel's design notes.

Browsing the estate itself happens on the **Inventory Explorer** page rather
than in the sidebar, so the hierarchy gets the full width of the screen instead
of a 236px column.

At tablet and phone widths, use **Menu** to open the focus-managed navigation
drawer. Escape, the close control, or selecting a destination closes it.

Use the search field to jump to systems, sites, devices, SSE objects, clients,
IP addresses, MAC addresses, or tickets.

On the overview, each stat tile links to the screen whose list its number
summarises — devices, alerts, compliance, licences, or connected systems.

The overview's plane list carries a sparkline per linked plane — devices
reported, sampled every five minutes and retained for 24 hours. A sample the
server flags as unusual for that series (a robust median/MAD z-score over what
the portal retained — statistics over kept samples, never a prediction) is
dotted in the warning tone, and the panel caption then says what the dots mark
and the window they were judged against. A series with too few samples to
judge, or an older server that computes no flags, renders no dots.

Lists that would otherwise repeat the same empty row many times collapse
instead. Connected systems, the Inventory Explorer tree, the overview rail and
Configure all group the planes that hold no credentials behind one line such as
`8 systems not linked`. Select that line to expand the full set; nothing is
hidden permanently, and nothing is filtered away.

![Operations overview](images/overview.png)

## Inventory and topology

![Inventory explorer](images/inventory.png)

Inventory Explorer follows:

`connected system → site or object kind → device or object`

Branches load only when expanded. Statuses distinguish current, stale, denied,
unsupported, failed, empty, and unlinked data. Device links retain their
management plane and serial identity.

The device inventory reconciles devices from multiple management planes.
Device actions use the management plane and serial number, not only the display
name. Duplicate names therefore do not silently target the wrong device.

A `/devices?state=<state>` link narrows the inventory to one exact state —
useful for sharing a filtered view, such as every device currently down. While
it applies, the filter shows as a clearable chip next to the other filters.

![Device inventory](images/devices.png)

Site detail shows only topology reported by a connected source. Wired clients
use Ethernet statistics and are not assigned wireless signal values.

The topology diagram has a focus mode: shift+click a card (or plain-click one
with no other action, such as an unmanaged neighbour) to isolate it with its
1-hop neighbours — everything else dims, cards and edges alike. While a focus
is active, clicking another card moves the focus and navigation is suspended;
Esc, the **Exit focus** chip, or a click on the diagram background restores
the full graph. Edge labels word the wiring in the plane's own terms: LAG
member ports with their bundle named (`1/1/1+1/1/2 (Po2)`), a member port the
plane scored as anything but good (`port 1/1/2 flapping`), STP-blocked links,
manually asserted adjacencies, and stack links.

The **Topology** screen (Operate, after **Overview**) applies the same
honesty estate-wide: one graph over every plane's reported neighbour facts,
built and merged server-side (`GET /api/topology`). An adjacency two planes
report reads as one edge carrying every source's badge, never two guesses;
each edge keeps its provenance — the reporting plane, the evidence word
(LLDP, CDP, VSF, recorded uplink), ports and speed when reported, and a
stale mark when no fresh source still vouches for it. A neighbour that
resolves to no inventory row is a ghost — drawn as reported in a "filed
nowhere" strip, never promoted to a managed device. Sites start collapsed
to one card each and expand on click; shift+click isolates a card with its
1-hop neighbours exactly as the site diagram does, and clicking through
opens the site or the device. Live mode says where the edges came from in
the footer notes: the only poll-carried neighbour dataset today is Mist's
AP-stats LLDP walk, so Central site graphs and AOS-CX port neighbours stay
per-site on-demand reads — open a site for its own graph.

For Mist sites, site detail also offers two deeper views. A floor plan section
renders the site's Mist map with AP and client dots at their reported
positions; a site with no map uploaded says so (floor plans are uploaded in
the Mist dashboard) rather than showing a placeholder. The wireless experience
section lists the site's SLE metrics; clicking one opens a drill-down with
classifiers, impacted clients and APs, and a trend sparkline — each part
fetched on demand and honestly labelled when the org does not score it.
Topology edges reported by an AP's own LLDP neighbour table (for example an
AP uplinking to a CX switch port) are drawn with that provenance.

Site detail also carries a **Rogue & neighbor APs** section: the BSSIDs the
site's APs hear, from Mist's per-site insights report — the only plane that
publishes one, read as one budget-gated walk per site on the poll. The
on-your-wire flag is the alarm half: a rogue whose BSSID resolves to your
wired infrastructure leads the section under a danger callout, because a
rogue on your own wire is the finding to act on and everything else is only
in earshot. Rows sort on-your-wire first, then strongest signal, each with
its SSID (or "SSID not broadcast"), BSSID, channel, signal, and how many of
the site's APs heard it. A row whose flag the report did not carry reads
"not reported", never an assumed safe. A Mist site with nothing in earshot
says so as a real answer, not a failed read; a site no plane publishes a
rogue report for says that instead; a walk that failed is reported
unavailable — never a fabricated all-clear.

For a Central-claimed site, site detail also carries an **Application
visibility** section: the site's DPI application table, read on demand for
the last 24 hours (the Central endpoint refuses a window wider than 7 days).
It opens with the risk strip — suspicious, moderate, low, trustworthy,
unknown, zero counts included — then the watchlist (flagged apps split into
the unclassified ones the plane could not name and the classified ones), the
top talkers ranked by estimated bytes, and a category rollup whose bars are
shares of the *largest* category, never of the total — an app's bytes count
toward every category it carries. Byte totals are DPI estimates, and the
section says so verbatim: "DPI byte totals are estimates — read as a ranking,
not a measurement". The table pages at 200 rows a call against a metered
plane, so it is fetched only when the section opens for a Central-claimed
site; any other site says "not reported" without spending a call.

Opening a Mist AP in the device detail shows its RF and health panel: per-band
channel, power, noise floor and airtime utilisation split, CPU and memory,
uplink port counters, power source with a constrained flag, and environment
readings where the hardware has sensors (an AP without them says "not
reported", never zero). The devices table marks firmware that is behind the
org's recommended train with the target version; wired Mist clients appear in
the Clients screen with their switch port instead of wireless readings.

Opening one client in the Clients screen shows a Client 360 section: every
management plane's own answer for that MAC — its session rows, the ClearPass
endpoint profile and recent auth decisions, Mist site SLE (labelled as
site-level, not per-client), and the site's top applications by DPI bytes —
site-wide, not filtered to the client: Central does not narrow that table to
one client, and the line says so. Planes with nothing to report say why (not
linked, no roster this cycle, no per-client view) rather than staying silent.

The **ClearPass** screen organises the box behind a tab strip. **Endpoints**
is the profiled repository — rows carry their description and Device Insight
tags when the CPPM reports them — and **Auth events** is its RADIUS feed.
Behind those sit the policy inventories: **Network devices** (the NADs that
authenticate to it), **Auth sources**, **Roles**, **Enforcement** (policies,
each with its default profile resolved to the profile row it names — type and
description shown when the name resolves), **Local users** (whitelisted
identity fields only — no password material), and **Services** (which also
lists device groups). Every tab keeps three states distinct: reported rows, a
real empty answer, and "not reported by this CPPM". Services and device
groups are not exposed on every CPPM build; when the box 404s them their
sections say "not available on this CPPM" — stated, never an empty table.

The **Endpoints** and **Local users** tabs also write — the only two CPPM
datasets the portal touches; services, enforcement policies, and roles stay
in ClearPass. **Register endpoint** adds one MAC (normalised however it was
typed, with an optional description, a status — Known, Unknown, or
Disabled — and profiler-style attribute hints); a per-row edit changes the
status and/or the operator note, never the MAC. **Add local user** creates
one with a login, a display name, a role from the reported role inventory,
and an enabled flag; the per-row edit offers the same fields plus a
password reset. Every write runs the reviewed direct-write flow the SSID
editor set: an exact summary, the review checkbox as the authorisation (no
ticket), then apply, read-back verification, and one audit-log line in the
change log. Local-user passwords are write-only end to end — never logged,
audited, echoed, or read back. Demo mode validates and answers a labelled
success without sending anything; live mode re-reads the screen after a
landed write and says so when the refresh could not confirm the lists are
current.

On AOS-CX switches, the device detail port table also carries live traffic
counters (rx/tx bytes and packet error/drop counts) read from the switch's
REST interface statistics. A counter the switch did not report shows as "not
reported", never as zero.

Opening a Central-managed switch or AP in device detail shows a **Hardware
trends** panel, read on demand for that one device — never on the poll —
over a window of 1h, 6h, 24h (the default), 3d, or 7d. A switch gets stat
tiles for CPU, memory, system temperature, and PoE draw against its budget,
each captioned with the timestamp of its latest sample rather than posing as
a live reading; sparklines that break the line wherever samples are missing;
and the interface error counters — each counter that moved earns a row with
its window total, while counters that all stayed at zero are stated once,
together. An AP gets CPU, memory, and throughput trends, each metric with its
own outcome line. A device no claiming plane can answer for says "not
reported" in words.

## Triage the alert queue

Repeated firings of the same problem — same plane, device, and title — collapse
into one row with a ×N badge. The badge counts firings, so a ×3 row is three of
them, and queue totals count firings the same way.

To hush a known problem while it is being worked:

1. Open the alert group's **Silence** action.
2. Choose a duration (1 hour, 8 hours, 24 hours, or 7 days).
3. Enter a reason. It is required, audit-logged, and shown wherever the group
   is hidden from.

Silenced groups leave the active queue but are always listed below it under
**SILENCED (N)**, with the reason, the expiry, and an **Unsilence** action —
suppression is never invisible. A silence expires on its own; an expired one
stops applying but stays on file as a record. Silences are stored in
`data/silences.json` and apply in demo and live mode alike.

A group's **Timeline** action (or Enter with the row focused) opens its
**Occurrence timeline**: first firing, deduped repeats, silences raised and
expired, plus the device's audited changes and running-config drift, joined
server-side from the queue, the silence store, the change log, and the config
backups. Times reconstructed from the queue's age strings are marked
approximate (≈); authored and persisted facts carry exact ones. When firings
followed a change within 30 minutes, the drawer adds one correlation sentence
— a statement about times, never a proven cause.

Where a silence hushes a problem being worked, a **maintenance window**
schedules the hush ahead of time — AP firmware staging every night, an ISP
cutover on Sunday morning. The **MAINTENANCE WINDOWS** section below the
silenced bench lists upcoming and active windows with their matchers and
spans; **New window** opens the create drawer, and each row enables, disables,
or deletes.

A window is one-off (absolute start and end) or weekly (the same wall-clock
span on named weekdays, optionally in an IANA time zone — an end time earlier
than the start runs into the next day). At the window's start the scheduler
raises one ordinary silence — the window's reason stamped on it, ending
exactly at the span's end — so matching, expiry, and the silenced listing run
through the same mechanism as an ad-hoc silence. A group benched by a window
names it (`maintenance window <id>`) instead of offering an Unsilence the
scheduler would undo; deleting the materialized silence overrides the rest of
that occurrence.

A reason is required and audit-logged, and at least one of plane, device, or
title substring must be set (a site narrows those matchers but cannot stand
alone). Expired one-off windows stay on file flagged expired — the record that
suppression was scheduled. Windows are stored in
`data/maintenance-windows.json` and apply in demo and live mode alike; demo
mode adds two authored fixture windows, labelled demo.

## Alert when a device stops reporting

The queue watches what planes report as alerts; a device that silently stops
reporting raises none, so nothing fires. Device-down rules close that gap. A
rule says: alert when a device has been continuously offline for a set number
of minutes, optionally narrowed to one site (id or display name) and one
device type (switch, ap, gateway — absent means all), with a cooldown that
keeps a *different* outage of the same device quiet after an alert.

The **Device-down rules** section below the silenced bench manages them:
every rule listed with its scope and thresholds, an enabled switch per row,
**New rule**, a per-row **Edit**, and **Delete** behind a confirm drawer —
a deleted rule stops paging for devices nothing else watches, so the click
cannot be the decision. The create/edit drawer (site filter, device type,
offline and cooldown minutes) validates with the same function the route
runs, so a refusal names the problem before the round trip in the same
words the 400 would use. Rules are real operator data in demo and live mode
alike — the engine evaluates whichever estate the screen is showing; with
the backend unreachable the authored demo rule stands in, labelled demo,
and creating or changing a rule needs the server.

The REST API remains underneath: `GET /api/alert-rules` lists every rule;
`POST /api/alert-rules` creates one (`offlineMinutes` defaults to 5,
`cooldownMinutes` to 60; both are whole minutes, 1–1440);
`PUT /api/alert-rules/:id` applies a partial edit;
`DELETE /api/alert-rules/:id` removes one. Every mutation is audit-logged.

The engine samples the same device list the screens show, every 60 seconds,
and its judgement calls are conservative:

- First sight is a baseline. A device already offline when first tracked
  never alerts for that outage — its start is unknowable — so pointing the
  portal at a fleet with standing outages pages nobody.
- An outage alerts once. The dedup key names the outage, so the same one
  cannot re-fire and a genuinely new one can.
- A recovery is announced only for an outage that actually alerted — a quiet
  outage ends quietly.
- A device several planes claim is down only when every plane that knows it
  says so.

Fires and recoveries go three places: the notification bell (below), the
outbound webhooks as ordinary fired/resolved transitions, and the change log.
Rules and the per-device tracking state persist in `data/alert-rules.json`,
so a restart neither re-baselines nor re-fires.

### The notification bell

The topbar bell is the in-app notification center: device-down fires and
recoveries land here, plus the subscription and certificate expiry notices
described further down. The badge counts unread entries; the dropdown lists
the newest 15 (the store keeps the last 200 — a feed, not an archive; the
change log is the archive). Clicking an entry marks it read and follows its
link — a device-down entry opens that device's detail page. **Mark all read**
clears the badge. The bell polls every 60 seconds and refreshes when opened;
a backend that stops answering leaves it badge-less and the dropdown says
why, rather than showing a fabricated zero. Demo entries are labelled demo.

## Notify on alert transitions

The queue only reaches the people watching it, so the portal can push
group-level transitions — fired, resolved, escalated — to outbound webhooks.
Open **Connected systems** and scroll to **Notifications** (outbound alert
webhooks). Add an endpoint with a name, an HTTPS URL, a template — generic
JSON, Slack, Microsoft Teams, or ntfy — and an optional HMAC secret.

The notifier watches the same queue the screen shows — a silenced group is
quiet here exactly as it is on screen — and POSTs each transition rendered per
the endpoint's template, signed HMAC-SHA256 in the `x-hpe-signature-256`
header (`sha256=<hex>`, the scheme GitHub webhook receivers already
implement) when a secret is set. Endpoint URLs pass the same SSRF rule as
Central webhook callbacks: HTTPS only, never a private, loopback, or reserved
address — checked when the endpoint is saved and again at send time. The
secret is write-only: the API never serves it back, and clearing one is an
explicit action.

Transitions follow the queue's own rules. A group appearing in the active
queue fires (one arriving already silenced does not). A group leaving the
queue entirely resolves — but a silenced group that clears never paged anyone,
so nobody gets the all-clear. A still-active group whose firing count grew
escalates. The first sample after a server start only baselines what is
already firing, so a boot never re-pages the standing queue. Each endpoint row
keeps its last delivery outcome, HTTP code or transport error included, and
**Test** sends one synthetic event down the real render-sign-POST path — a
green result means the path actually works.

In demo mode nothing is ever sent: would-have-sent payloads land in the
**Demo outbox** below the endpoint list, labelled demo, and the delivery
record says demo, never delivered.

## Send reports by email and watch expiries

The same **Notifications** section of Connected systems carries the email
channel, in three cards below the webhooks.

**Email (SMTP)** holds the one relay configuration: host, port (587 by
default), an optional username, a write-only password (never served back — a
blank field keeps the stored one, the clear checkbox removes it), a from
address, and STARTTLS on or off (off means plaintext, stated plainly for a
loopback relay). **Test** sends one real test email — the default recipient
is the from address — and reports the server's own words. In demo mode
nothing is dialled; the would-have-sent mail lands in the report outbox,
labelled demo.

**Fleet summary report** emails a fleet digest on a schedule: daily, or
weekly on Mondays, at a configured UTC hour (server-local time zones are
deliberately not inherited). A fire must also clear a minimum gap — 20 hours
for daily, 6 days for weekly — so a restart inside the scheduled hour never
double-sends, and a missed window fires at the next one, not every minute.
**Send now** forces a fire that bypasses the clock but not the honesty: no
SMTP relay or no recipients is recorded as skipped with the reason, a failed
send as failed with the server's words, and demo mode renders into the
outbox. **Preview** shows exactly what would send, in any mode — the preview
and the send path share one builder. The subject is
`Fleet Summary Report — YYYY-MM-DD`, and the body carries per-type device
totals, the offline table (first 25, overflow counted), bell alert counts for
the last 24h and 168h, subscriptions expiring within 90 days (first 15,
overflow counted), and a data-gaps section that says what could not be
counted rather than printing a confident zero.

**SSL certificate watch** holds a list of `host[:port]` targets (port 443 by
default, up to 50 hosts). The scheduler probes each host every six hours —
connect, read the certificate's expiry, done; chain verification is
deliberately off, because the question is when the certificate expires, not
whether it is trusted — and a failed probe stays on the row with its error.
**Probe** re-checks one host immediately; demo mode answers without dialling.

Subscriptions (from the licences source) and probed certificate expiries walk
one 90/60/30/15-day ladder: crossing a threshold pushes one bell entry and
one audit-log line, once per band per expiry date. The dedup key names the
expiry date, so a renewal re-arms the whole ladder while a restart re-notifies
nothing. Demo mode adds one labelled demo certificate so the ladder is visible
without credentials.

## Working the tables

The big tables — Devices, Alerts, Clients, Licences, Compliance — share the
same power features:

- **Column manager.** The **View options** dropdown shows, hides, and reorders
  columns; dragging a header edge resizes one. The layout persists per table
  (browser localStorage first, synced into `data/settings.json` when the
  backend answers), and a saved layout that would hide every column is treated
  as corrupt and shows all of them instead.
- **Sorting**, on Clients: every column header is clickable — first click
  sorts ascending, second descending, third clears the sort. A row with no
  value in the sorted column sorts last in both directions, and Session sorts
  by real duration (`2h 14m` outranks `19m`), not alphabetically.
- **Keyboard rows.** On Devices, Alerts, and Clients the rows are a keyboard
  grid: `j`/`↓` and `k`/`↑` move between rows, `Enter`/`→` runs the focused
  row's primary action (open the device, open the group's occurrence timeline,
  open the client), `x` toggles its selection, and `Esc` clears the selection,
  then the row focus. Pressing `?` opens the shortcut overlay. Licences and
  Compliance deliberately stay out of this: their rows have no primary action,
  so there is nothing honest for Enter to do.
- **Faceted filters**, on Devices and Alerts: checklist popovers (plane,
  state, and site, plus severity on Alerts) with live counts. Ticking is OR
  within a facet and AND across facets, and each count is computed over the
  rows that pass every *other* active filter — ticking P1 never zeroes the P2
  count.
- **Saved views**, on the same two screens: the **Views** dropdown names the
  current facet selection, free text, switches, column layout, and density,
  and restores the whole set later. Views persist like the column layouts —
  local first, server-synced. URL deep links such as `/devices?state=` are
  deliberately not captured; those filters belong to the address that explains
  them.

## Filter authentication events by time

The authentication-events filter row carries a quick time-range picker
(15m / 1h / 24h / 7d / All), kept in the URL as `?range=` so a narrowed view is
shareable. The range can only narrow what the feed already holds: a live feed
is the current poller snapshot, minutes of traffic rather than days, so when a
picked range reaches further back than the snapshot the filter row says so.
Rows that carry no timestamp stay shown under any range, and the same note
counts them.

## Review config drift

The portal keeps versioned snapshots of each reachable device's running config,
collected read-only — a single allow-listed `show running-config` over SSH in
live mode, deterministic synthesized configs in demo mode. An unchanged
re-collection stores nothing, so the version list is the device's change
history, and "drift" means the newest snapshot differs from its predecessor —
never a comparison against a golden baseline.

Open **Compliance**:

- The **Config drift** stat counts devices whose latest snapshot differs from
  their previous one, out of the devices that have snapshots.
- **Config drift — running-config snapshots** lists every device with its
  version count and snapshot source; demo snapshots are labelled as such, and
  devices with no read-only config channel (APs, sensors) are listed with the
  reason rather than silently dropped.
- Selecting a drifted device opens a drawer with the unified diff between its
  two newest snapshots.

Up to ten versions are kept per device under `data/config-backups/`; older
ones are pruned. See [Security](security.md) for how to treat these files.

## Create or edit an SSID

1. Open **Configure**.
2. Select **New SSID** or edit an existing wireless profile.
3. Choose the plane and a live assignment scope.
4. Select the security mode and complete its required fields.
5. Review the generated change and exact scope assignments.
6. Confirm the reviewed operation.
7. Apply and wait for profile and assignment verification.

Mist SSIDs are read per site (the Mist API scopes WLANs to sites, not to the
org) and merge across sites when the same SSID exists in several. A
passphrase is never shown: rows carrying one say "PSK set — redacted by the
portal" instead.

Mist SSIDs are written too. When the deployment reports a Mist direct-write
path, the SSID drawer offers Mist as a plane choice, and the apply is a
reviewed direct write: the review checkbox is the authorisation, no ticket is
raised, and one audit-log line records the attempt. Direct writes support
WPA2-PSK and Open only — enterprise and captive-portal modes are refused with
the reason (a Mist enterprise WLAN authenticates against the org's RADIUS
servers, and a captive portal is the WLAN's own portal object; the form can
express neither), so those stay in the Mist dashboard. The passphrase is
write-only end to end: it travels inside the write and is never logged,
audited, echoed, or read back. An update merges the managed fields into the
site's existing WLAN object, so the roughly sixty keys the portal does not
manage (dtim, schedules, portal, RADIUS) pass through exactly as the site has
them, and an apply that would change nothing writes nothing.

![Configuration](images/configure.png)

Switch ports are grouped by exact switch identity and start collapsed. Use the
filter for switch, port, description, VLAN, role, or state; expand only the
switch being changed. Large groups show 25 ports at a time.

![Collapsed switch-port hierarchy](images/configure-ports.png)

Supported security workflows include WPA2-PSK, WPA3/WPA2 Enterprise, open
networks, and captive-portal profiles when the required Central dependencies
are available.

Passphrases are write-only. They do not appear in review output, audits, or API
responses. A 64-character hexadecimal PSK is sent as hexadecimal; an 8-63
character PSK is sent as a string.

If profile creation succeeds but assignment fails, the result is shown as
partial. Correct the assignment and retry that step rather than recreating the
profile.

Queued changes also take a batch. Ticking rows in the queue table (or the
header's select-all; `x` toggles from the keyboard, `Esc` clears) raises a
contextual bar — *N selected — Approve / Reject* — that opens no new path:
it runs the same per-item push or discard one change at a time, so every
change keeps its own brokered review, lease, and audit line, and the
summary names the per-item outcomes — applied, accepted but unconfirmed,
failed (named, never folded into a green count), and skipped (not ready, or
a local row with no broker id). A run in progress locks the bar.

## Run traceroute diagnostics

1. Open an eligible Central-managed AP or AOS-CX device.
2. Open **Diagnostics**.
3. Enter the traceroute destination.
4. Review the exact plane, serial number, and operation.
5. Start the diagnostic.

The portal polls Central's asynchronous task until completion or the original
safety deadline. Cancelling stops operator-facing polling but cannot cancel the
upstream Central task. Capacity remains reserved until Central reports a
terminal state or the deadline expires.

Never retry a diagnostic whose initiation or polling outcome is reported as
unknown until the reservation clears or Central is checked directly.

## Manage Central webhooks

Open **Connected systems**, select the Central system, and open its
configuration tab.

Available operations:

- List and inspect webhooks.
- Edit documented fields with generation conflict protection.
- Delete a reviewed webhook.
- Create a webhook.
- Rotate an HMAC key.

Create and rotation return an HMAC key once. Copy it directly into the
receiver's secure secret store, confirm storage, and then clear the handoff.
The portal does not save the key.

If the response is lost or malformed, use the pending handoff reconciliation.
Do not blindly create or rotate again.

Webhook callback URLs must use HTTPS and resolve only to public addresses.
Local, private, loopback, link-local, and reserved destinations are rejected.

The same configuration tab's **Receivers** section runs the other direction:
Mist and New Central POST signed alert events to this portal at
`/api/hooks/mist` and `/api/hooks/central`. The per-source HMAC signature over
the exact raw bytes is the authentication — a delivery holds no operator
session, so these two routes answer ahead of the sign-in guard. Mist signs
SHA-256 hex in `X-Mist-Signature-v2` (a SHA-1 hex `X-Mist-Signature` is also
accepted); New Central sends an RFC 9421 `Signature` header keyed by the
webhook's HMAC secret. Store each source's signing secret from the panel; it
is write-only and never served back. A source with no secret refuses
deliveries (503) rather than accept input it cannot verify.

Accepted events are recorded — a bounded in-memory ring plus an append-only
`data/webhook-events.jsonl` — deduplicated on vendor redelivery, and they join
the alert queue through the same dedup, grouping, and silence pipeline as
polled alerts, badged with the plane that delivered them. The Mist receiver
normalizes three topics. Alarms take the generic alarm-shaped mapper.
Client-sessions map connects, disconnects, and roams (a delivery naming a
next AP is a roam) with their termination reason, band, signal, and SSID —
session telemetry, so every one lands as a P3 row with the client as the
subject. Device-updowns fire P2 when a device goes down; a device coming
back up lands as a P3 cleared row — the same recovery vocabulary the polled
path uses, so an up never reads as a new problem. In demo mode a public
demo secret keeps the signed path exercisable, and the section's simulate
buttons push a fixture delivery through the real verify-and-record
pipeline, labelled demo; the simulate call also takes a `topic` for the two
newer Mist fixtures.

The Mist system's own drawer closes the setup loop. Its **Webhook receiver**
section lists which of the org's subscriptions point at this receiver and
when a delivery last arrived — registered is not delivering — and can do
the registration itself: enter the public URL (it must end with
`/api/hooks/mist`), optionally a signing secret, tick the review checkbox,
and apply. The write is an upsert keyed on the receiver URL — creating the
org's subscription when none points here, updating the one that does, and
answering "unchanged" with no write at all when the org already says what
was reviewed. The secret is write-only end to end: it rides the write,
re-arms the receiver only after the subscription carries it, and is never
logged, echoed, or served back — the one audit-log line a landed write
records notes only that a secret was rotated, unchanged, or not set.
**Verify** re-reads the org fresh; the result claims verified only when
that re-read confirms the subscription, and a write whose confirming
re-read does not show it is reported unverified, never assumed. Like every
reviewed write here, the review checkbox is the authorisation — no ticket.

The same drawer carries the **Org audit log**: the latest admin changes as
Mist reports them, read on demand — a paged org search is spent only when
the drawer asks, behind the shared cache and call budget. Entries carry the
admin, the change message, the site when it resolves, and before/after
snapshots with every secret-shaped value replaced by a redaction marker (a
long snapshot's truncation is stated). An org with no admin changes is a
real empty; a failed read says so with the reason; with no linked Mist
plane the section says to link one — never an empty table posing as a
quiet org.

## Manage HPE Aruba Networking SSE

Open **Connected systems** and select SSE. Its object inventory opens directly.
SSE kinds and objects are also available in Inventory Explorer and global
search.

The Systems row reports **Objects**, not devices. Fresh readable kinds remain
current even when another kind is denied; denied and unsupported states stay
attached to the affected kind.

The panel groups supported connector zones, connectors, locations, tunnels,
network-range applications, users, groups, and writable category resources.

For a write:

1. Select or create an object.
2. Review the exact change.
3. Confirm the mutation.
4. Wait for the object operation and tenant-wide Commit.
5. Follow the displayed recovery state if Commit is rejected or uncertain.

An uncertain operation must be reconciled. Do not replay it as though it
definitely failed.

## Recorded terminal

For a local switch with configured SSH access:

1. Open the device.
2. Open the terminal.
3. Start the recorded session.
4. Run an allow-listed command.

Sessions are bound to exact device identity and recorded under the configured
data directory. Unsupported commands are rejected.

## Unknown outcomes

For configuration, diagnostic, SSE, or webhook operations, transport failure
does not prove failure at the provider. The portal labels these states as
unknown and supplies a reconciliation path. Always reconcile before retrying.

## Visual references and configuration actions

Site, device, and client detail surfaces carry an operator **Visual references**
panel for floorplans, port maps, documents, and native console links. These are
never treated as telemetry: each card shows source, owner/attribution, and
updated time, and a missing upload is labelled unavailable rather than blank.

Supported uploads are PNG, JPEG, WebP, PDF, plain text, and Markdown, up to
10 MiB. External URL references must be HTTPS (loopback HTTP is allowed in the
lab). Uploaded paths are generated server-side; client-supplied filesystem paths
are rejected.

**Configuration actions** on the same detail surfaces are capability-gated.
Only products with a real preview → review → push path expose a handoff into
Configure (or the product screen). OpsRamp, UXI, EdgeConnect, GreenLake, AOS-8,
and local AOS-CX show an explicit read-only reason instead of a disabled fantasy
Push button.

## Licences table defaults

The licences table hides idle zero-assignment subscriptions by default. Use the
toggle above the table when you need to inspect spare capacity. Export CSV
follows whatever the table currently shows.

## ClearPass connector health

When ClearPass is linked but degraded (auth/TLS failure, stale pull), the
ClearPass screen shows a warning with the connector note and a link to
**Connected systems** so empty tables are not mistaken for an empty CPPM.
