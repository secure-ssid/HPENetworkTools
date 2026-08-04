# Security and operational safeguards

## Access control

The portal brokers configuration writes to production network equipment and
bridges SSH shells to switches. Who may reach it matters as much as any of the
safeguards below.

### Sign-in (OIDC)

Authentication is an Authorization Code + PKCE flow against any OpenID Connect
provider. Configure it either in `data/settings.json` under `auth`:

```json
"auth": {
  "issuer": "https://id.example.com/application/o/hpe-network-tools/",
  "clientId": "…",
  "clientSecret": "…",
  "redirectUri": "https://portal.example.com/api/auth/callback",
  "allowedGroups": ["net-admins"]
}
```

…or in the environment, which keeps the secret out of a file on disk:

```
HPE_OIDC_ISSUER, HPE_OIDC_CLIENT_ID, HPE_OIDC_CLIENT_SECRET,
HPE_OIDC_REDIRECT_URI, HPE_OIDC_ALLOWED_GROUPS   (comma separated, optional)
```

The environment overlay is all-or-nothing and is never written back to the
settings file. A partially-set group of variables is a startup error rather
than a silent fall back to file configuration.

`allowedGroups` is optional. Absent, any account the provider authenticates may
use the portal; present, the `groups` claim must intersect it.

**Authentik.** There is no server-wide discovery document. Create an
OAuth2/OpenID Provider and an Application, then the issuer is
`https://<host>/application/o/<application-slug>/` — including the trailing
slash. Set the provider's redirect URI to exactly the `redirectUri` above.

### Configuring it from the portal

Systems → Identity provider reads, tests and saves the same configuration, so
the first provider can be set up without hand-editing a file. Two distinctions
there are deliberate and worth understanding:

- **Configured is not active.** The guard is installed once, at startup. A
  provider saved into a process that booted without one is recorded but not in
  force, and the portal says so rather than showing a green badge over a server
  that is still answering every route unauthenticated. Restart to apply it.
- **A reachable provider is not a valid client.** *Test provider* fetches the
  discovery document and then presents the client id and secret to the token
  endpoint with a deliberately invalid authorization code. A provider that
  rejects the client answers `invalid_client`; one that accepts it and rejects
  only the code answers `invalid_grant`. The result reports which happened
  instead of calling a reachable provider a working one.

When `HPE_OIDC_*` is set, the environment owns the configuration: the screen
shows it read-only and the API refuses to save over it, because accepting a
write there would leave the portal reporting one provider while signing people
in against another. For the same reason a settings write that disagrees with
the environment overlay is rejected rather than merged, and the overlay is
never persisted — an environment-supplied client secret stays out of
`settings.json` even when something unrelated is saved afterwards.

`GET`/`PUT`/`DELETE /api/auth/config` and `POST /api/auth/test` mount *behind*
the auth guard, unlike the sign-in routes which necessarily precede it. An
unauthenticated caller who could rewrite the issuer could point the portal at
an identity provider of their own.

### What is guarded

With an identity provider configured, every `/api` route requires a session
except `/api/health`, the four `/api/auth/*` endpoints, and the two inbound
webhook receiver posts (`/api/hooks/mist`, `/api/hooks/central`), which
authenticate by HMAC signature instead — see below. The SSH WebSocket
upgrade is authenticated separately, from the same session cookie, because an
upgrade never passes through Express middleware — closing the API while leaving
the shell bridge open would guard the lesser surface.

Sessions are an httpOnly, SameSite=Lax cookie, `Secure` whenever the host is
not loopback, held in memory only. A server restart signs everyone out; that is
deliberate, since persisting sessions would mean another secret at rest.

`/api/auth/login` cannot itself require a session, so it is the one route an
unauthenticated caller can drive at will, and each call parks a PKCE verifier
in memory until the login completes or ages out after ten minutes. In-flight
logins are therefore capped at 256. Past the cap the **oldest** are discarded
rather than the newest refused: refusing would let anyone who can reach the
login route lock every operator out, trading a memory problem for total denial
of the portal. A discarded state fails closed at the callback exactly as an
expired one does, and the discard is logged rather than passed over in silence,
because it means either an attack or a misconfiguration.

### Exposure

`startServer` binds `127.0.0.1` by default. `HPE_BIND_HOST` overrides it.

With no identity provider configured, binding a network-reachable address is
**refused**, not warned about: an unauthenticated portal on a routable address
is an open door to production switches. `HPE_ALLOW_NO_AUTH=1` overrides this
for a deployment with its own perimeter (a private lab segment, a host
firewall, an authenticating reverse proxy). Bound to loopback with no provider,
the server starts and says so on every boot.

### CSRF

State-changing requests must carry a same-origin `Origin`/`Referer`, and this
check runs whether or not authentication is configured — the unauthenticated
case needs it most, since a hostile page can otherwise POST to a loopback port
with no credential at all.

A missing `Origin` header is allowed. Browsers always send one on
state-changing requests and upgrades, so its absence means a non-browser
client, and anything able to omit the header can equally forge it. Origin
bounds browsers; sessions bound everything else.

### `reviewConfirmed` is not an access control

The review gates below require `reviewConfirmed: true` on mutating requests.
This is **misclick protection for a human operator, not authorisation.** Anyone
composing a request directly simply sets the field. Authentication and the
origin check are what stop unauthorised callers; the review gate stops an
operator changing production by accident.

## Credential storage

- Connected-system credentials are stored in `data/settings.json` or the path
  selected by `HPE_SETTINGS_PATH`.
- Settings are written atomically with owner-only permissions.
- API responses return masked secrets.
- Hidden credentials from another system type are cleared before test/save.
- A save is accepted only for the exact credential payload that passed testing.

Protect the host account, settings file, runtime data directory, and backups.
The portal does not replace operating-system or deployment secret management.

### Running-config backups

Snapshots under `data/config-backups/` are full device running-configs, and a
running-config can hold secrets of its own — RADIUS shared secrets, SNMP
communities, local accounts. They are stored owner-only (0600), capped at ten
versions per device, and the audit log records one metadata line per snapshot,
never the config body. The directory lives under `data/`, which is git-ignored:
snapshots must never be committed or copied into source-controlled files, and
the directory deserves the same protection as `data/settings.json`.

### Credentials in transit

A connected system's base URL must be `https://`. A bare hostname is assumed to
be https; any other explicit scheme is refused when the adapter is built.

This is enforced rather than recommended because every plane authenticates:
Central and ClearPass POST a client secret to mint a token, GreenLake and Mist
put a bearer or API token on every request, and AOS-8 posts a password to its
login form. Over `http://` all of that crosses the network in the clear, which
would make the masking described above pointless — the secret is protected in
the logs and then handed to anyone on the path. None of these planes serves
plaintext in the first place, so an `http://` base URL is a configuration
mistake in every case and is reported as one.

`http://` to a loopback address (`127.0.0.0/8`, `localhost`, `[::1]`) is
permitted. Those packets never reach a network interface, so there is nothing
on the path to read them; this is the same distinction browsers draw when they
treat `http://localhost` as a secure context. A hostname that merely begins
with `localhost` does not qualify.

A refused base URL degrades that one plane — shown on Systems as `degraded`
with the reason in its note — and does not prevent the portal from starting or
affect any other plane.

## Review gates

Mutating operations require explicit review confirmation. Device operations are
bound to management plane and serial number. Configuration and webhook reviews
become stale when their authoritative target changes.

## One-time webhook HMAC keys

Central webhook create and HMAC rotation may return a key only once.

- The HMAC key is never written to files, settings, logs, audits, queues,
  browser storage, list responses, detail responses, or toast messages.
- A secret-free owner-only journal records the operation before the provider
  request.
- The journal is bound to the exact Central tenant credentials.
- Credential changes are blocked while a handoff is pending.
- The journal clears only after secure-storage acknowledgement or reviewed
  reconciliation.

If the page closes before the key is stored, the key cannot be recovered from
the portal.

## Callback validation

Webhook callback endpoints:

- Must use HTTPS.
- Must not include embedded credentials or URL fragments.
- Must resolve to public addresses.
- Are rejected if any resolved address is private, loopback, link-local, or
  reserved.
- Are revalidated immediately before create.

## Webhook receivers and notification endpoints

The inbound receiver routes mount ahead of the session guard because a
delivery from Mist or New Central holds no operator session: the per-source
HMAC signature over the raw request bytes is the authentication, and a source
with no stored secret refuses deliveries (503) rather than accept input it
cannot verify. Signing secrets persist write-only in
`data/webhook-receivers.json` (0600) and are never returned by any API or
written to any log. Outbound notification endpoints are the reverse direction
and follow the callback-validation rule above — HTTPS only, never a private,
loopback, or reserved destination — validated when the endpoint is saved and
again before every send. Treat the receiver secrets file and the
accepted-events journal `data/webhook-events.jsonl` like `data/settings.json`:
owner-only, backed up deliberately, never committed.

## Unknown provider outcomes

Timeouts and transport failures after dispatch may leave an unknown provider
state. The portal does not convert these into success or definite failure.
Reservations and recovery journals prevent unsafe immediate retries.

## Diagnostics

Traceroute initiation, polling, and cancellation states remain distinct.
Operator cancellation does not imply upstream cancellation. Reservations remain
until an observed terminal state or the original deadline.

## SSE Commit

SSE object mutation and tenant-wide Commit are separate states. Retry Commit
only when the portal reports a definite Commit rejection. Ambiguous states
require manual reconciliation and cleanup.

## Retention and bounds

Nothing the portal writes or runs is unbounded.

- **Audit and diagnostics logs rotate.** `change-log.jsonl` and
  `diagnostics-history.jsonl` rotate at `HPE_LOG_MAX_BYTES` (16 MB) keeping
  `HPE_LOG_KEEP` (9) generations. Rotation renames, never truncates. Readers
  read across generations, so history does not appear to shrink at a rotation
  boundary. When retention finally discards the oldest generation, a
  `log-retention` tombstone naming that file and the time span it covered is
  appended to the live log first — the gap is part of the record.
- **SSH transcripts are capped** at `HPE_TRANSCRIPT_MAX_BYTES` (32 MB). Reaching
  the cap ends the session, because a shell that keeps running while nothing
  records it is precisely what mandatory recording exists to prevent.
- **Concurrent shells are capped** (10). A refused session says so; switches cap
  their own VTY sessions and an unbounded portal could exhaust one.
- **Terminal dials are bounded** end to end (45 s), as is the wait for the shell
  channel after the transport comes up (20 s). A connection that lands after the
  portal stopped waiting is closed rather than left holding a VTY slot.
- **Plane polls are bounded** at `HPE_POLL_TIMEOUT_MS` (120 s). A pull that does
  not return is reported as a plane failure rather than left as silent
  staleness; the plane's in-flight lock is held until the abandoned call really
  settles, so a second pull never runs alongside it.
- **Shutdown is graceful.** SIGTERM/SIGINT stop the poller, close live shells,
  then close the HTTP server. An uncaught exception or unhandled rejection is
  treated as fatal — the process says what happened, tears down, and exits
  non-zero rather than continuing to broker production writes from an unknown
  state. Shutdown names any step it could not complete instead of reporting a
  clean exit.

## Audit data

Every brokered change records a `who`. With an identity provider configured
that is the signed-in principal's email, or their name when the provider
publishes no email. With none configured it is the literal `operator` — an
honest statement that the portal cannot say who acted, rather than a name it
cannot support.

Audits intentionally omit:

- API tokens and client secrets.
- SSID passphrases.
- Webhook HMAC keys and submitted webhook credentials.
- Raw provider response bodies.
- Diagnostic targets and raw traceroute output.
- Sensitive filesystem paths.

Review deployment log retention and access permissions before using the portal
outside a lab.

## Visual reference storage

Operator visual references are stored under `HPE_DATA_DIR` (default `data/`):

- `visual-references.json` — metadata only (mode 0600)
- `visual-assets/<uuid>` — uploaded bytes (mode 0600; directory 0700)

Asset identifiers are server-generated UUIDs. Upload titles may not contain path
separators. MIME types are allow-listed. The asset stream sets
`Content-Disposition: inline` and never reveals disk paths. Create/delete/upload
events append to the shared change log (`change-log.jsonl`) with ticket `—`
because nothing is pushed to a vendor plane.
