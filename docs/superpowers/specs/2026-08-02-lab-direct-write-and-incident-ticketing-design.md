# Lab Direct Writes and Incident Ticketing Design

## Goal

Make every connected product read/write by default in the lab, with immediate configuration changes and tickets reserved exclusively for detected network incidents.

## Operator policy

| Area | Behavior |
| --- | --- |
| SecureSSID-LAB-Central, SecureSSID-MIST, Central Classic, SecureSSID GreenLake, AOS-8 Mobility Master, AOS-10 via Central, Local switch collector, ClearPass, UXI, HPE Aruba Networking SSE, HPE OpsRamp, EdgeConnect SD-WAN | Read/write by default through the product's configured connector. Selecting Push immediately calls that product's write API. No ticket reference, approval queue, review gate, lease, preflight availability check, or delayed execution. |
| Network incidents | Create and update tickets only when actual network signals identify an incident, including device-down and client health/connectivity failures. Configuration activity never creates, requires, or updates a ticket. |

## Direct-write flow

1. The operator edits a product configuration payload and selects Push.
2. The portal renders the plane-specific payload and immediately sends one request through that product's configured connector. There is no portal-side preflight or product write-mode gate.
3. On a successful response, the portal refreshes the affected record and records a redacted audit event containing target, object kind, result, timestamp, and response status—not the configuration body or credentials.
4. On a failure, the portal keeps the unsent form data visible, reports the exact safe error, and does not create a ticket or a deferred write queue entry.

There is no ticket lookup, ticket reference field, fifteen-minute lease, change queue, approval state, review gate, delayed execution, preflight availability check, or read-only product class in this flow. The Push click immediately starts the write. Product credentials remain server-side and the selected product connector receives the payload; this is delivery routing, not a user-visible blocker.

## Ticket automation

The ticket service remains an incident-management feature. It consumes deduplicated network issue events rather than configuration actions. A ticket automation rule receives the detected source, object identity, site, severity, observed time, and evidence summary; it creates or associates an incident ticket only for device-down or client-health/connectivity conditions. Recovery updates or resolves the corresponding incident according to the existing alert lifecycle. It does not inspect configuration requests and configuration routes do not import ticket services.

## Boundaries and tests

- Remove ticket validation, ticket fields, leases, queue states, review gates, console-handoff-only branches, write-mode switches, and ticket-derived dry-run identifiers from configuration write APIs and their UI.
- Preserve a redacted, append-only configuration audit event without payload bodies or credentials.
- Test immediate success/failure for every product connector and prove no ticket service, lease clock, review gate, or write-mode blocker is called by any configuration path.
- Test each product selects its own authenticated connector/write API and never routes a payload through another product connector.
- Test device-down and client-health events create/deduplicate incident tickets; a configuration write does not create or mutate one.
- Keep connector authentication and exact product routing intact; "lab" removes workflow friction, not correct tenant/product delivery.
