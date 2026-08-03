# Configurable Product Connectors Design

## Goal

Repair the current in-progress worktree and make every supported HPE product
connection independently configurable, honestly validated, and available to
the unified operations views. New Central, Central Classic, and Mist remain
separate products. AOS-10 remains Central-derived rather than a separately
configured connector.

## Scope and Constraints

- Preserve all current tracked, staged, and untracked work. Do not reset,
  clean, or discard `drawer-check.yml` without an explicit user decision.
- Support exactly one connector configuration per product in this iteration.
  A future estate-combination feature may support multiple instances, but it
  must not change today's credentials or connector identity model.
- A connection must only be saved when the same configuration can create a
  real adapter. Accidental stub adapters are rejected.
- AOS-10 is reported as a capability/data origin of New Central. It has no
  standalone credential form, API probe, or poller record.
- A lab may explicitly disable TLS verification per connector, but the UI must
  make this choice visible and warn that credentials can be exposed to an
  untrusted endpoint.
- Secrets remain write-only/masked. Every connector may source secrets from
  protected environment references as well as the owner-only local settings
  file.

## Product Model

The following are independent connectors: New Central, Central Classic, Mist,
GreenLake, ClearPass, UXI, AOS-8, Local AOS-CX, SSE, EdgeConnect, and OpsRamp.
Each connector receives a typed configuration with:

- `enabled`: explicit participation in polling and aggregate views;
- `endpoint`: product-approved default plus constrained base-URL/profile
  override where the product supports it;
- `auth`: product-specific discriminated credential type such as OAuth client
  credentials, bearer token, API key, or username/password;
- `tls`: verify/relaxed policy, with relaxed mode visibly labelled lab-only;
- `polling`: enabled datasets, cadence, and call budget;
- `scopes`: read/write capability choices constrained to the product's actual
  API support.

The shared product manifest owns user-facing metadata, form fields, defaults,
dataset choices, scopes, and the connector's capabilities. Server adapters own
configuration parsing, secret resolution, HTTPS requirements, adapter
creation, and connection probes. The manifest does not contain arbitrary URL
paths or credential-bearing requests.

## Connection Validation

Every adapter implements a product-owned `validateConnection()` operation.
The operation validates the typed configuration, authenticates with the
configured mechanism, and performs one minimal read from the same supported
API family used by the adapter's live pull. It returns a structured outcome:

- authentication and minimal-read success;
- rejected credentials or insufficient scope;
- endpoint/TLS/network failure;
- partial support where authentication succeeded but the optional sample read
  is unavailable.

The API's test-before-save path invokes this operation. Saving an enabled
connector is refused for an incomplete configuration or a failed required
probe. This removes the current generic reachability fallback and guarantees
that Local AOS-CX, EdgeConnect, and OpsRamp cannot save a record that later
becomes a stub.

New Central, Central Classic, and Mist use distinct adapter/probe behavior and
separate UI state. Existing product-specific write restrictions remain
honest: a product is not offered a configuration write merely because it is
configured for reads.

## Client Views

The unified `/clients` view defaults to all enabled client-capable connectors.
It has source filters for each product and continues rendering when one source
fails, while showing that source's failure state. Each result carries source
provenance.

Records matching the same canonical endpoint identity are grouped into one
overview row with source badges and expandable source-specific details; they
are never silently overwritten. Central, Central Classic, and Mist retain
their native client screens, counts, fields, and drill-down behavior.

## Visual Drill-Downs and Configuration Actions

Every selectable operational object (site, device, interface, client, alert,
SSID, connector, and configuration change) opens a source-aware detail view
rather than forcing an operator to infer context from a dense table row. The
view may combine the following references when the product or lab configuration
provides them:

- topology and client-path diagrams, with directly adjacent source/provenance;
- port and interface maps, health/status badges, and configuration-diff views;
- time-series charts and event/history timelines;
- site floorplan or map context and device placement;
- device/product images and operator-supplied reference documents or diagrams;
- native product links and visual identifiers for the selected source.

Visual assets are configured references, not fabricated operating facts. The
lab may upload or link an image, diagram, floorplan, or document to a supported
object. The application records source, attribution/owner, and update time,
renders unavailable assets as an explicit empty state, and never treats an
image or diagram as live telemetry.

The detail view exposes editable fields only when the selected connector's
typed capability manifest declares a compatible write operation. Every push
uses the product's supported API and follows the same staged workflow:

1. select a supported target and editable configuration field;
2. render a source-labelled change preview and validation result;
3. execute a dry run when that product provides one;
4. collect the configured review/ticket confirmation;
5. push the approved change and show the product response, audit event, and
   any partial or uncertain outcome;
6. refresh the affected source data without pretending that another product's
   view was changed.

Read-only, derived, and unsupported products remain visibly non-editable. The
application must not synthesise a generic configuration push for an API that
does not provide that operation.

## Repair Sequence

1. Repair the existing test-suite defects and whitespace issue without
   changing intended product behavior. The Mist demo-clock assertion becomes
   timezone-independent. The HTTP route-boundary tests close test sockets
   deterministically instead of waiting on a keep-alive connection.
2. Introduce the typed connector configuration and shared product manifest.
   Migrate current settings read/write paths without exposing secrets.
3. Move configuration completeness and authenticated validation into every
   adapter. Add real validation for Mist, AOS-8, Local AOS-CX, EdgeConnect,
   and OpsRamp and retain existing authenticated probes where already present.
4. Refactor the Connected Systems form to be manifest-driven and expose all
   supported per-product controls, including TLS, call budget, polling, and
   datasets.
5. Update native product screens and the unified Clients overview so source
   provenance and partial failures are explicit.
6. Add source-aware visual drill-downs, managed visual-reference metadata, and
   capability-gated configuration action panels.
7. Update generated/user documentation and smoke coverage from the same
   manifest-backed contracts where practical.

## Error Handling and Security

Configuration and probe errors are structured and product-labelled. The UI
does not call a connector 'connected' for reachability alone, nor claim that
an unsupported dataset or write is enabled. Aggregate views identify missing
or failed sources without hiding data from healthy sources.

All token, key, password, and secret-reference values remain redacted in API
responses, logs, diagnostics, history, and test failures. Product endpoints
that transmit secrets require HTTPS unless an explicit lab-only TLS policy is
saved and reported. Existing OAuth/SSO, webhook, SMTP, notification, SSH, and
MCP configuration paths retain their present security gates and are covered by
the same masked-settings behavior.

## Testing and Verification

The rewrite is test-driven. For every product, a contract test covers:

1. form payload to typed configuration parsing;
2. configuration completeness and safe masking;
3. authenticated minimal-read connection probe;
4. adapter creation and live pull outcome;
5. read/write capability enforcement;
6. client contribution and source-specific partial failure behavior where the
   connector supplies clients.
7. visual-reference empty, available, and attribution states plus the
   detail-view configuration preview, approval, push, and failure states for
   every supported write capability.

The repair is accepted only after the full typecheck, lint, test, build, and
smoke gates are rerun. Authenticated live probes require disposable lab
credentials and are separate from deterministic mocked contract tests.
