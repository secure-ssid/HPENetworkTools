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
switch collection, ClearPass, and UXI. The connection form changes to the
credential shape supported by each adapter.

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
