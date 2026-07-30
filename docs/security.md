# Security and operational safeguards

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

Audits intentionally omit:

- API tokens and client secrets.
- SSID passphrases.
- Webhook HMAC keys and submitted webhook credentials.
- Raw provider response bodies.
- Diagnostic targets and raw traceroute output.
- Sensitive filesystem paths.

Review deployment log retention and access permissions before using the portal
outside a lab.
