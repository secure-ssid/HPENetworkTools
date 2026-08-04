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
 *
 * Audit multi-select (Loop 193) raises **Export selected**, **Copy admins**
 * (unique newline-joined), **Copy messages** (unique newline-joined change
 * summaries when admin emails alone are sparse for a handoff — Alerts **Copy
 * titles** pattern; Loop 235), **Copy selection link** (`?auditIds=` +
 * section=audit; clearable chip), and Clear. Selection-empty `?auditIds=`
 * offers **Clear selection filter** (Loop 213). before/after snapshots stay
 * redacted-only.
 */

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, DataTable, SectionHeader, Skeleton, useToast } from '../../nightdesk';
import type { DataTableColumn } from '../../nightdesk';
import { apiFetch, isApiError, serverMessage, type ApiResult } from '../../api/client';
import { countOf } from '@hpe/shared';
import type { MistAuditLogLive, MistAuditLogRow, MistWebhookRegistrationStatus } from '@hpe/shared';
import { namesFilterForParam } from '../../app/nav';
import { exportTableCsv } from '../../lib/csv';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import { buildMistShareUrl } from './share';

/** Canonical share target for the org audit log (Mist ops screen). */
export const MIST_AUDIT_SECTION_PATH = '/mist?section=audit#mist-section-audit';

/** Summary columns only — before/after already carry portal redaction markers. */
export function auditLogCsvRows(entries: readonly MistAuditLogRow[]): Array<Array<unknown>> {
  return entries.map((e) => [
    e.id ?? '',
    e.at ?? '',
    e.admin ?? '',
    e.message,
    e.siteId ?? '',
    e.siteName ?? '',
    e.before ?? '',
    e.after ?? '',
  ]);
}

export const AUDIT_LOG_CSV_HEADERS = [
  'id',
  'at',
  'admin',
  'message',
  'siteId',
  'siteName',
  'before',
  'after',
] as const;

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

/** Stable multi-select key — prefer Mist id, else at+message. */
export function auditRowKey(entry: MistAuditLogRow): string {
  return entry.id ?? `${entry.at ?? ''}:${entry.message}`;
}

const auditColumns: Array<DataTableColumn<MistAuditLogRow>> = [
  {
    key: 'at',
    title: 'When',
    hideable: false,
    sortValue: (e) => e.at ?? '',
    render: (entry) => (
      <span className="nt-audit-meta nt-service-note">{stampLabel(entry.at)}</span>
    ),
  },
  {
    key: 'message',
    title: 'Change',
    hideable: false,
    sortValue: (e) => e.message,
    render: (entry) => (
      <div className="nt-stack nt-gap-2">
        <span className="nt-audit-title">{entry.message}</span>
        <span className="nt-service-note nt-fs-10">
          {entry.admin ?? 'admin not reported'}
          {entry.siteName ? ` · ${entry.siteName}` : ' · org-wide'}
        </span>
        {entry.before !== undefined || entry.after !== undefined ? (
          <details>
            <summary className="nt-service-note nt-fs-10 nt-cursor-pointer">before / after</summary>
            {entry.before !== undefined ? (
              <div className="nt-service-note nt-fs-10 nt-break-all">- {entry.before}</div>
            ) : null}
            {entry.after !== undefined ? (
              <div className="nt-service-note nt-fs-10 nt-break-all">+ {entry.after}</div>
            ) : null}
          </details>
        ) : null}
      </div>
    ),
  },
];

/** The org audit log — the latest admin changes, with the read's own
 *  provenance and honest empty/failed/not-reported sentences. */
export function AuditLogSection({ audit, error }: { audit: MistAuditLogLive | null | undefined; error: string | null }) {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  /* Deep link: /mist?section=audit&auditIds=a\nb (bulk Copy selection link). */
  const auditIdsFilter = namesFilterForParam(searchParams.get('auditIds'));

  const allEntries = audit?.entries ?? [];
  const entries =
    auditIdsFilter === null
      ? allEntries
      : allEntries.filter((e) => auditIdsFilter.includes(auditRowKey(e)) || (e.id != null && auditIdsFilter.includes(e.id)));
  const idsPresent =
    auditIdsFilter === null
      ? 0
      : auditIdsFilter.filter(
          (id) => allEntries.some((e) => auditRowKey(e) === id || e.id === id),
        ).length;

  const copySectionLink = () => {
    const url = buildMistShareUrl('audit');
    void navigator.clipboard.writeText(url).then(
      () => toast('Audit log link copied', { description: 'section=audit', tone: 'success' }),
      () => toast('Could not copy link', { description: url, tone: 'warning' }),
    );
  };

  const exportClientCsv = () => {
    if (entries.length === 0) return;
    const n = exportTableCsv('mist-audit-log.csv', [...AUDIT_LOG_CSV_HEADERS], auditLogCsvRows(entries));
    toast(`Exported ${n} audit entr${n === 1 ? 'y' : 'ies'}`, {
      description: 'mist-audit-log.csv — summary fields; secrets already redacted.',
    });
  };

  const exportServerCsv = () => {
    void (async () => {
      const res = await downloadApiCsv('/api/mist/audit-log/export', 'mist-audit-log.csv');
      if (res.ok) {
        toast('Server CSV downloaded', {
          description: 'mist-audit-log.csv — org admin changes (no secrets).',
          tone: 'success',
        });
      } else {
        toast('Server CSV failed', {
          description: res.error ?? 'Could not download export',
          tone: 'warning',
        });
      }
    })();
  };

  return (
    <div id="mist-section-audit" className="nt-stack nt-gap-2">
      <div className="nt-row-between-12">
        <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · Mist audit cinema · org trail</div>
        <SectionHeader
          label="Org audit log"
          meta={
            audit?.entries
              ? auditIdsFilter !== null
                ? `${entries.length} OF ${audit.entries.length} SHOWN · MIST`
                : `${audit.entries.length} SHOWN · MIST`
              : undefined
          }
        />
        <div className="nt-wrap-6">
          <Button variant="ghost" size="sm" onClick={copySectionLink}>
            Copy section link
          </Button>
          {entries.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={exportClientCsv}>
              Export CSV
            </Button>
          ) : null}
          {audit !== undefined && audit !== null ? (
            <Button variant="ghost" size="sm" onClick={exportServerCsv}>
              Download server CSV
            </Button>
          ) : null}
        </div>
      </div>
      {error !== null ? (
        <div className="nt-service-note">The audit log could not be read — {error}</div>
      ) : audit === undefined ? (
        <div className="nt-center-pad-24">
          <div role="status" aria-label="NightDesk · loading audit" className="nt-stack nt-gap-6 nt-debug-wake nt-debug-wake--compact">
            <Skeleton height={12} width="30%" />
            <Skeleton height={28} />
          </div>
        </div>
      ) : audit === null ? (
        <div className="nt-service-note">
          No linked Mist plane can read the org audit log — link Mist on Connected systems.
        </div>
      ) : allEntries.length === 0 ? (
        <div className="nt-service-note">
          {audit.source.sections.logs === 'failed'
            ? `The audit-log read failed${audit.source.note ? ` — ${audit.source.note}` : ''}.`
            : audit.source.sections.logs === 'empty'
              ? 'Mist reported no admin changes for this org.'
              : `The audit log was not fetched${audit.source.note ? ` — ${audit.source.note}` : ''}.`}
        </div>
      ) : (
        <>
          {auditIdsFilter !== null ? (
            <div className="nt-chip-row" role="group" aria-label="Audit selection deep link">
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.delete('auditIds');
                  setSearchParams(next, { replace: true });
                  setSelectedKeys([]);
                }}
                title={auditIdsFilter.join(', ')}
                className="nt-chip nt-chip--active"
              >
                {idsPresent === auditIdsFilter.length
                  ? `${auditIdsFilter.length} selected entr${auditIdsFilter.length === 1 ? 'y' : 'ies'}`
                  : `${idsPresent} of ${auditIdsFilter.length} selected entries present`}
                {' — clear'}
              </button>
            </div>
          ) : null}
          {entries.length === 0 ? (
            <div className="nt-stack nt-gap-8">
              <div className="nt-service-note">
                No audit entries match the selection deep link — clear the selection filter to
                restore the full org trail.
              </div>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const next = new URLSearchParams(searchParams);
                    next.delete('auditIds');
                    setSearchParams(next, { replace: true });
                    setSelectedKeys([]);
                  }}
                >
                  Clear selection filter
                </Button>
              </div>
            </div>
          ) : (
            <DataTable
              ariaLabel="Mist org audit log"
              columns={auditColumns}
              rows={entries}
              rowKey={auditRowKey}
              selectedKeys={selectedKeys}
              onSelectionChange={setSelectedKeys}
            />
          )}
          {selectedKeys.length > 0 ? (
            <div
              className="nt-configure-bulk-bar nt-bulk-glass"
              role="region"
              aria-label="Mist audit selection actions"
            >
              <span className="nt-configure-bulk-bar__count">{`${selectedKeys.length} SELECTED`}</span>
              <span className="nt-configure-bulk-bar__hint">
                export, copy admins or messages, or share a selection link for only the entries you
                marked — full list export stays in the header (secrets already redacted)
              </span>
              <span className="nt-configure-bulk-bar__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const selected = new Set(selectedKeys);
                    const picked = entries.filter((e) => selected.has(auditRowKey(e)));
                    if (picked.length === 0) {
                      toast('No selected audit entries still in view', {
                        description: 'Clear selection or adjust filters.',
                        tone: 'info',
                      });
                      return;
                    }
                    const n = exportTableCsv(
                      'mist-audit-log-selected.csv',
                      [...AUDIT_LOG_CSV_HEADERS],
                      auditLogCsvRows(picked),
                    );
                    toast(`Exported ${countOf(n, 'selected audit entry', 'selected audit entries')}`, {
                      description: 'mist-audit-log-selected.csv — summary fields; secrets already redacted.',
                      tone: 'success',
                    });
                  }}
                >
                  Export selected
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = entries.filter((e) => selected.has(auditRowKey(e)));
                      if (picked.length === 0) {
                        toast('No selected audit entries still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const admins = [
                        ...new Set(
                          picked
                            .map((e) => (e.admin ?? '').trim())
                            .filter((a) => a.length > 0),
                        ),
                      ];
                      if (admins.length === 0) {
                        toast('No admins on the selected entries', {
                          description:
                            'Those rows did not publish an admin — use Copy messages or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = admins.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(admins.length, 'admin')}`, {
                          description:
                            admins.length < picked.length
                              ? `${picked.length - admins.length} selected without an admin skipped`
                              : 'newline-joined · paste into a ticket or change window',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy admins', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy admins
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = entries.filter((e) => selected.has(auditRowKey(e)));
                      if (picked.length === 0) {
                        toast('No selected audit entries still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const messages = [
                        ...new Set(
                          picked
                            .map((e) => (e.message ?? '').trim())
                            .filter((msg) => msg.length > 0),
                        ),
                      ];
                      if (messages.length === 0) {
                        toast('No messages on the selected entries', {
                          description: 'Use Copy admins or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const text = messages.join('\n');
                      try {
                        await navigator.clipboard.writeText(text);
                        toast(`Copied ${countOf(messages.length, 'message')}`, {
                          description:
                            messages.length < picked.length
                              ? `${picked.length - messages.length} selected without a message skipped`
                              : 'newline-joined · paste into a ticket or change window',
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy messages', { description: text, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy messages
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const selected = new Set(selectedKeys);
                      const picked = entries.filter((e) => selected.has(auditRowKey(e)));
                      if (picked.length === 0) {
                        toast('No selected audit entries still in view', {
                          description: 'Clear selection or adjust filters.',
                          tone: 'info',
                        });
                        return;
                      }
                      const ids = [
                        ...new Set(
                          picked
                            .map((e) => (e.id ?? auditRowKey(e)).trim())
                            .filter((id) => id.length > 0),
                        ),
                      ];
                      if (ids.length === 0) {
                        toast('No ids on the selected entries', {
                          description: 'Use Copy messages or export CSV instead.',
                          tone: 'info',
                        });
                        return;
                      }
                      const next = new URLSearchParams(searchParams);
                      next.set('auditIds', ids.join('\n'));
                      next.set('section', 'audit');
                      const qs = next.toString();
                      const path =
                        !window.location.pathname || window.location.pathname === '/'
                          ? '/mist'
                          : window.location.pathname;
                      const url = `${window.location.origin}${path}${qs ? `?${qs}` : ''}#mist-section-audit`;
                      try {
                        await navigator.clipboard.writeText(url);
                        toast('Selection link copied', {
                          description: `${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} · auditIds=`,
                          tone: 'success',
                        });
                      } catch {
                        toast('Could not copy link', { description: url, tone: 'warning' });
                      }
                    })();
                  }}
                >
                  Copy selection link
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelectedKeys([])}>
                  Clear
                </Button>
              </span>
            </div>
          ) : null}
          <div className="nt-service-note nt-fs-105-pt6">
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
        <div className="nt-service-note">{status.error}</div>
      ) : (
        <div className="nt-stack nt-gap-6">
          {status.subscriptions.map((s) => (
            <div key={s.id} className="nt-row-center nt-gap-10 nt-pad-6-0">
              <Badge tone={s.enabled === true ? 'success' : 'neutral'} dot>
                {s.enabled === true ? 'enabled' : s.enabled === false ? 'disabled' : 'unknown'}
              </Badge>
              <span className="nt-flex-1 nt-service-note nt-fs-10">
                {s.url ?? 'url not reported'}
                {` · ${countOf(s.topics.length, 'topic')}`}
                {s.secretConfigured === true ? ' · signed' : ''}
              </span>
            </div>
          ))}
          {status.subscriptions.length === 0 ? (
            <div className="nt-service-note">
              {status.note ?? 'No org webhook subscription points at this receiver yet.'}
            </div>
          ) : null}
          <div className="nt-service-note nt-fs-105 nt-hint-muted">
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
    <div className="nt-stack nt-gap-18">
      <div className="nt-stack nt-gap-2">
        <SectionHeader
          label="Webhook receiver"
          meta={status?.demo === true ? 'DEMO FIXTURE' : status ? (status.subscriptions.length > 0 ? 'REGISTERED' : 'NOT REGISTERED') : undefined}
        />
        {statusError !== null ? (
          <div className="nt-service-note">The registration status could not be read — {statusError}</div>
        ) : status === null ? (
          <div className="nt-center-pad-24">
            <div role="status" aria-label="NightDesk · loading audit" className="nt-stack nt-gap-6 nt-debug-wake nt-debug-wake--compact">
            <Skeleton height={12} width="30%" />
            <Skeleton height={28} />
          </div>
          </div>
        ) : (
          <RegistrationStatusBody status={status} />
        )}
      </div>
      <AuditLogSection audit={audit} error={auditError} />
    </div>
  );
}
