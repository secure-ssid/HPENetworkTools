/**
 * web/src/screens/mist/audit.tsx — the Mist org audit log and the webhook
 * receiver's registration status, as READ-ONLY operational sections.
 *
 * The audit half (rows, section, reads) was extracted from
 * systems/MistSection.tsx — the Systems drawer's Configuration tab, which
 * also carries the REVIEWED register/rotate write — so the Mist screen can
 * show the same log with the same honesty wording without importing the
 * write path. Config stays in Systems: nothing here mutates the org.
 *
 * Both reads stay ON DEMAND (the audit log is a paged org search; the
 * registration status a subscription walk) — they run when the screen
 * mounts, never on the poll cadence.
 *
 * REGISTRATION STATUS. Registered AND delivering are two different facts and
 * the section keeps them separate, exactly as the Systems panel does; the
 * demo world serves the authored registered state and says so.
 */

import { useEffect, useState } from 'react';
import { Badge, SectionHeader, Spinner } from '../../nightdesk';
import { apiFetch, isApiError, serverMessage, type ApiResult } from '../../api/client';
import { countOf } from '@hpe/shared';
import type { MistAuditLogLive, MistAuditLogRow, MistWebhookRegistrationStatus } from '@hpe/shared';
import { noteStyle } from './style';

// ---------------------------------------------------------------------------
// API calls — shared with the Systems panel (this file is their one home):
// a non-OK answer yields the server's own message, an unreachable backend
// yields `offline` — never a fabricated empty state.
// ---------------------------------------------------------------------------

export async function getMistRegistration(): Promise<ApiResult<MistWebhookRegistrationStatus>> {
  try {
    const r = await apiFetch('/api/hooks/mist/registration');
    if (r.ok) return (await r.json()) as MistWebhookRegistrationStatus;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export async function getMistAuditLog(): Promise<ApiResult<MistAuditLogLive | null>> {
  try {
    const r = await apiFetch('/api/systems/mist/audit-log?limit=25');
    if (r.ok) {
      const body = (await r.json()) as { auditLog?: MistAuditLogLive | null };
      return body.auditLog ?? null;
    }
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

/** '26 Jul 11:42' in the reader's own clock; an absent stamp reads '—'. */
export function stampLabel(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function AuditRow({ entry }: { entry: MistAuditLogRow }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '9px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', width: 96, flex: '0 0 96px' }}>
          {stampLabel(entry.at)}
        </span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>
          {entry.message}
        </span>
      </div>
      <div style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', paddingLeft: 106 }}>
        {entry.admin ?? 'admin not reported'}
        {entry.siteName ? ` · ${entry.siteName}` : ' · org-wide'}
      </div>
      {entry.before !== undefined || entry.after !== undefined ? (
        <details style={{ paddingLeft: 106 }}>
          <summary style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', cursor: 'pointer' }}>
            before / after
          </summary>
          {entry.before !== undefined ? (
            <div style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', wordBreak: 'break-all' }}>- {entry.before}</div>
          ) : null}
          {entry.after !== undefined ? (
            <div style={{ ...noteStyle, fontSize: 'var(--nd-text-10)', wordBreak: 'break-all' }}>+ {entry.after}</div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}

/** The org audit log — the latest admin changes, with the read's own
 *  provenance and honest empty/failed/not-reported sentences. */
export function AuditLogSection({ audit, error }: { audit: MistAuditLogLive | null | undefined; error: string | null }) {
  const entries = audit?.entries ?? [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionHeader label="Org audit log" meta={audit?.entries ? `${audit.entries.length} SHOWN · MIST` : undefined} />
      {error !== null ? (
        <div style={noteStyle}>The audit log could not be read — {error}</div>
      ) : audit === undefined ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
          <Spinner size="sm" />
        </div>
      ) : audit === null ? (
        <div style={noteStyle}>
          No linked Mist plane can read the org audit log — link Mist on Connected systems.
        </div>
      ) : entries.length === 0 ? (
        <div style={noteStyle}>
          {audit.source.sections.logs === 'failed'
            ? `The audit-log read failed${audit.source.note ? ` — ${audit.source.note}` : ''}.`
            : audit.source.sections.logs === 'empty'
              ? 'Mist reported no admin changes for this org.'
              : `The audit log was not fetched${audit.source.note ? ` — ${audit.source.note}` : ''}.`}
        </div>
      ) : (
        <>
          {entries.map((entry) => (
            <AuditRow key={entry.id ?? `${entry.at}:${entry.message}`} entry={entry} />
          ))}
          <div style={{ ...noteStyle, fontSize: 10.5, paddingTop: 6 }}>
            Latest admin changes as Mist reports them — secrets in before/after snapshots are redacted
            by the portal.
          </div>
        </>
      )}
    </div>
  );
}

/** The registration status as an operational fact: which subscriptions point
 *  at this receiver, and whether a delivery has actually arrived. No form —
 *  registering or rotating the subscription is the Systems drawer's write. */
function RegistrationStatusBody({ status }: { status: MistWebhookRegistrationStatus }) {
  const delivering = status.lastReceivedAt ?? null;
  return (
    <>
      {status.error ? (
        <div style={noteStyle}>{status.error}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {status.subscriptions.map((s) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
              <Badge tone={s.enabled === true ? 'success' : 'neutral'} dot>
                {s.enabled === true ? 'enabled' : s.enabled === false ? 'disabled' : 'unknown'}
              </Badge>
              <span style={{ flex: 1, minWidth: 0, ...noteStyle, fontSize: 'var(--nd-text-10)' }}>
                {s.url ?? 'url not reported'}
                {` · ${countOf(s.topics.length, 'topic')}`}
                {s.secretConfigured === true ? ' · signed' : ''}
              </span>
            </div>
          ))}
          {status.subscriptions.length === 0 ? (
            <div style={noteStyle}>
              {status.note ?? 'No org webhook subscription points at this receiver yet.'}
            </div>
          ) : null}
          <div style={{ ...noteStyle, fontSize: 10.5 }}>
            {delivering
              ? `last delivery accepted ${stampLabel(delivering)}`
              : 'no delivery accepted yet — registered is not delivering'}
          </div>
        </div>
      )}
    </>
  );
}

/**
 * The Mist screen's ops pair: the webhook receiver's registration status and
 * the org audit log, both read on mount. Registration changes link out to
 * the Systems drawer — this screen operates, it does not configure.
 */
export function MistOpsSections() {
  const [status, setStatus] = useState<MistWebhookRegistrationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [audit, setAudit] = useState<MistAuditLogLive | null | undefined>(undefined);
  const [auditError, setAuditError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([getMistRegistration(), getMistAuditLog()]).then(([statusResult, auditResult]) => {
      if (!live) return;
      if (isApiError(statusResult)) {
        setStatusError(statusResult.error);
      } else {
        setStatus(statusResult);
      }
      if (isApiError(auditResult)) {
        setAuditError(auditResult.error);
      } else {
        setAudit(auditResult);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <SectionHeader
          label="Webhook receiver"
          meta={status?.demo === true ? 'DEMO FIXTURE' : status ? (status.subscriptions.length > 0 ? 'REGISTERED' : 'NOT REGISTERED') : undefined}
        />
        {statusError !== null ? (
          <div style={noteStyle}>The registration status could not be read — {statusError}</div>
        ) : status === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <Spinner size="sm" />
          </div>
        ) : (
          <RegistrationStatusBody status={status} />
        )}
      </div>
      <AuditLogSection audit={audit} error={auditError} />
    </div>
  );
}
