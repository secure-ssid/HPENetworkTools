# Configuration

## Start safely with demo data

The default installation starts with `demoMode: true`. Demo mode uses local
fixtures and requires no external credentials.

Use **Connected systems** to control:

- Global demo or live operation.
- Blending live sections into demo pages.
- Per-screen demo/live overrides.
- Configuration policy for ticket requirements.

`configMode` is a manually selected policy. It is not automatic lab detection
and does not weaken secret handling.

## Connect a system

1. Open **Connected systems**.
2. Select **Connect a system**.
3. Choose the system type.
4. Enter its endpoint and credentials.
5. Select the required read or write scopes.
6. Select **Test connection**.
7. Save only after the exact entered credential payload passes.
8. Select **Sync all** and review the resulting inventory.

Changing any tested field invalidates the successful test and requires another
connection test.

![Connected systems](images/connected-systems.png)

## HPE Aruba Networking Central

Provide:

- New Central regional API gateway.
- OAuth client ID.
- OAuth client secret.
- Required read scopes.
- Optional brokered-write scope.

Use the API gateway shown in Central rather than guessing a region. New Central
features such as direct SSID writes, diagnostics, and webhooks require a New
Central gateway; Central Classic is reported as unsupported for those paths.

## HPE Aruba Networking SSE

HPE Aruba Networking SSE was formerly known as Axis Security.

Provide:

- Admin API base URL, normally `https://admin-api.axissecurity.com`.
- Scoped static bearer token.
- Read scopes for the object categories to index.
- Optional direct-write scope.

SSE writes are reviewed operations. A successful object mutation is followed
by tenant-wide Commit. If Commit has an uncertain outcome, use the displayed
recovery workflow instead of replaying the mutation.

## Other connected systems

The portal also models Central Classic, Mist, GreenLake, AOS-8, AOS-10, local
switch collection, ClearPass, UXI, EdgeConnect, and OpsRamp. The connection
form changes to the credential shape supported by each adapter.

AOS-10 is the exception: linking it saves credentials against a deliberate
stub that syncs nothing. AOS-10 gateways are Central-managed, so their
inventory and operations arrive through the Central adapter instead (see
`design/research-notes.md`).

Read-only systems remain read-only. The portal does not fabricate a write path
when an API or permission is unavailable.

## Data-source controls

| Setting | Behavior |
|---|---|
| Demo | Uses fixtures |
| Live | Uses connected-system data and displays failures honestly |
| Blend live | Replaces individual demo sections when live data is available |
| Screen source | Pins a specific page to demo or live |

The response for each screen includes its effective data source.

## Local settings

Settings are stored in `data/settings.json` unless `HPE_SETTINGS_PATH` is set.
The file is git-ignored and written with owner-only permissions.

Do not manually copy settings into source-controlled files. Use the portal or a
protected deployment secret mechanism.

## Runtime data

A running portal also keeps, under `data/` (or `HPE_DATA_DIR`):

- `data/config-backups/` — versioned running-config snapshots, one directory
  per device (`index.json` plus `v<N>.cfg` bodies), written owner-only (0600).
  The newest ten versions per device are kept; older ones are pruned.
- `data/silences.json` — alert silences, written owner-only (0600). Expired
  silences stay on file flagged as expired; only an explicit unsilence removes
  one.
- `data/notifications.json` — outbound alert-notification endpoints (name,
  URL, template, write-only HMAC secret, last delivery outcome), written
  owner-only (0600).
- `data/maintenance-windows.json` — scheduled maintenance windows, written
  owner-only (0600). Expired one-off windows stay on file flagged as expired.
- `data/webhook-receivers.json` — inbound webhook signing secrets per source
  (Mist, New Central), write-only and owner-only (0600).
- `data/webhook-events.jsonl` — append-only journal of accepted inbound
  webhook events, owner-only (0600), rotating with the same retention as
  `change-log.jsonl`.
- `data/alert-rules.json` — device-down alert rules plus the per-device
  tracking snapshot (outage start, alerted state), written owner-only (0600).
  A restart resumes the engine without re-baselining or re-firing alerts.
- `data/notification-center.json` — the notification bell's entries, a feed
  capped at the newest 200, written owner-only (0600).
- `data/notification-email.json` — the email channel: SMTP relay
  configuration (write-only password), the fleet report schedule and its last
  outcome, the SSL certificate watch list, and the expiry ladder's notified
  bands, written owner-only (0600).

`data/settings.json` also carries the web shell's UI preferences: per-table
column layouts (`tableColumns`) and per-screen saved views (`savedViews`). The
browser writes both to localStorage first (`nt-table-columns`,
`nt-saved-views`) and syncs them into settings when the backend answers; the
server stores them as opaque maps it does not interpret.

Snapshots are collected on a sweep: once at startup, then hourly.
`HPE_CONFIG_BACKUP_INTERVAL_MS` overrides the interval in milliseconds; values
below 60000 fall back to the hourly default. Live collection is read-only — a
single allow-listed `show running-config` per device per sweep.

Metrics history is different: it lives in memory only, sampled from the poller
cache every five minutes into per-series ring buffers retained for 24 hours,
and served at `GET /api/metrics` for the table sparklines. A restart starts the
window over and the UI says so. `HPE_METRICS_SAMPLE_MS` overrides the cadence
in milliseconds; values below 1000 fall back to the five-minute default.

Device-down alert rules evaluate on their own 60-second cadence.
`HPE_ALERT_RULES_INTERVAL_MS` overrides the interval in milliseconds; values
below 1000 fall back to the 60-second default.
