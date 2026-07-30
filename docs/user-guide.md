# User guide

## Navigation

The left navigation is grouped by task:

- **Operate:** overview, alerts, tickets, clients, and authentication events.
- **Inventory:** sites, devices, and licences.
- **Govern:** configuration, compliance, and connected systems.

Use the search field to jump to a site, device, client, IP address, MAC address,
or ticket.

![Operations overview](images/overview.png)

## Inventory and topology

The device inventory reconciles devices from multiple management planes.
Device actions use the management plane and serial number, not only the display
name. Duplicate names therefore do not silently target the wrong device.

![Device inventory](images/devices.png)

Site detail shows only topology reported by a connected source. Wired clients
use Ethernet statistics and are not assigned wireless signal values.

## Create or edit an SSID

1. Open **Configure**.
2. Select **New SSID** or edit an existing wireless profile.
3. Choose a live Central assignment scope.
4. Select the security mode and complete its required fields.
5. Review the generated change and exact scope assignments.
6. Confirm the reviewed operation.
7. Apply and wait for profile and assignment verification.

![Configuration](images/configure.png)

Supported security workflows include WPA2-PSK, WPA3/WPA2 Enterprise, open
networks, and captive-portal profiles when the required Central dependencies
are available.

Passphrases are write-only. They do not appear in review output, audits, or API
responses. A 64-character hexadecimal PSK is sent as hexadecimal; an 8-63
character PSK is sent as a string.

If profile creation succeeds but assignment fails, the result is shown as
partial. Correct the assignment and retry that step rather than recreating the
profile.

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

## Manage HPE Aruba Networking SSE

Open **Connected systems**, select SSE, then open **Configuration**.

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
