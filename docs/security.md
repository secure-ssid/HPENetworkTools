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

### What is guarded

With an identity provider configured, every `/api` route requires a session
except `/api/health` and the four `/api/auth/*` endpoints. The SSH WebSocket
upgrade is authenticated separately, from the same session cookie, because an
upgrade never passes through Express middleware — closing the API while leaving
the shell bridge open would guard the lesser surface.

Sessions are an httpOnly, SameSite=Lax cookie, `Secure` whenever the host is
not loopback, held in memory only. A server restart signs everyone out; that is
deliberate, since persisting sessions would mean another secret at rest.

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
