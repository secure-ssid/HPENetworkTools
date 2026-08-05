/**
 * Outbound alert notifications: webhook endpoints, test sends, demo outbox.
 *
 * The portal's alert queue could only reach the people watching it. This
 * section manages the endpoints the notifier (server/src/services/notifier.ts)
 * POSTs group transitions to — fired / resolved / escalated — rendered per
 * endpoint as generic JSON, Slack, Teams or ntfy, signed with HMAC-SHA256
 * when a secret is set.
 *
 * The honesty rules are the screen's whole point:
 *
 *   - DEMO NEVER CLAIMS A SEND. With demo mode on the server makes no network
 *     call; the would-have-sent payloads fill the outbox below, labelled
 *     demo, and the status badge says "nothing is sent" in warning tone —
 *     never a green "delivered" for a byte that never left the process.
 *   - THE SECRET IS WRITE-ONLY. The server never serves it back; the edit
 *     drawer starts blank and says so, and clearing one is an explicit
 *     checkbox, not an empty field an operator can miss.
 *   - A FAILURE STAYS VISIBLE. The last delivery outcome rides on each row —
 *     including the HTTP code or transport error — so a dying endpoint
 *     cannot pass for a quiet one.
 *
 * Below the webhooks, the EMAIL CHANNEL (server/src/services/reports.ts +
 * smtp.ts): the SMTP relay configuration (password write-only, same
 * tri-state as the HMAC secret), the scheduled fleet summary report (daily/
 * weekly, UTC, forced sends and an always-available preview that renders
 * the exact would-be-sent body), and the SSL certificate watch list feeding
 * the 90/60/30/15-day expiry ladder. Demo mode never dials there either —
 * the report renders into a labelled outbox and probes answer honestly.
 */

import { useEffect, useState } from 'react';
import {
  addSslHost,
  createNotificationEndpoint,
  deleteNotificationEndpoint,
  deleteSmtpConfig,
  getNotificationEndpoints,
  getNotificationDeliveries,
  getNotificationOutbox,
  getNotificationStatus,
  getReportPreview,
  getReportSchedule,
  getSmtpConfig,
  getSslHosts,
  probeSslHost,
  putReportSchedule,
  putSmtpConfig,
  removeSslHost,
  sendReportNow,
  testNotificationEndpoint,
  testSmtpConfig,
  updateNotificationEndpoint,
  type NotificationEndpointInput,
  type NotificationOutbox,
  type ReportSchedule,
} from '../../api/notifications';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  ConfirmDialog,
  Drawer,
  FormField,
  Input,
  SectionHeader,
  Select,
  Switch,
  useToast,
} from '../../nightdesk';
import { exportTableCsv } from '../../lib/csv';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import { buildSystemsSectionUrl, systemsSectionDomId } from './share';
import {
  NOTIFICATION_KIND_LABEL,
  NOTIFICATION_TEMPLATE_OPTIONS,
  isNotificationTemplateKind,
  type FleetReport,
  type NotificationEndpointView,
  type NotificationServiceStatus,
  type NotificationTemplateKind,
  type ReportConfig,
  type ReportFrequency,
  type SmtpConfigView,
  type SslProbeHost,
} from '@hpe/shared';

interface Draft {
  name: string;
  url: string;
  template: NotificationTemplateKind;
  secret: string;
  clearSecret: boolean;
  enabled: boolean;
}

const EMPTY: Draft = { name: '', url: '', template: 'generic', secret: '', clearSecret: false, enabled: true };

/** One row's last-attempt line, verbatim from the persisted delivery record. */
function deliveryLine(view: NotificationEndpointView): { text: string; tone: 'success' | 'danger' | 'warning' | 'neutral' } {
  const d = view.delivery;
  if (!d) return { text: 'never attempted', tone: 'neutral' };
  const when = new Date(d.lastAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.lastResult === 'delivered') return { text: `delivered${d.httpCode ? ` HTTP ${d.httpCode}` : ''} · ${when}`, tone: 'success' };
  if (d.lastResult === 'demo') return { text: `demo — nothing sent · ${when}`, tone: 'warning' };
  return { text: `failed — ${d.lastError ?? 'unknown'} · ${when}`, tone: 'danger' };
}

export function NotificationsSection() {
  const { toast } = useToast();
  const [pendingRemove, setPendingRemove] = useState<NotificationEndpointView | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [endpoints, setEndpoints] = useState<NotificationEndpointView[] | null>(null);
  const [status, setStatus] = useState<NotificationServiceStatus | null>(null);
  const [outbox, setOutbox] = useState<NotificationOutbox | null>(null);
  const [deliveries, setDeliveries] = useState<import('../../api/notifications').NotificationDeliveries | null>(null);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  /** Outcome filter for the live delivery log + server CSV (`delivered|failed|demo`). */
  const [deliveryResult, setDeliveryResult] = useState<'all' | 'delivered' | 'failed' | 'demo'>('all');
  /** Text triage for delivery log + server CSV (Loop 116 `q=`). */
  const [deliveryQ, setDeliveryQ] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<NotificationEndpointView | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = async () => {
    const [eps, st] = await Promise.all([getNotificationEndpoints(), getNotificationStatus()]);
    if ('error' in eps) {
      setEndpoints(null);
      setStatus(null);
      setLoadError(`Notification endpoints could not be loaded: ${eps.error}`);
      setDeliveries(null);
      setDeliveriesError(eps.error);
      return;
    }
    setEndpoints(eps.endpoints);
    setLoadError(null);
    if (!('error' in st)) {
      setStatus(st.status);
      if (st.status.demoMode) {
        const ob = await getNotificationOutbox();
        if (!('error' in ob)) setOutbox(ob.outbox);
      } else {
        setOutbox(null);
      }
      const del = await getNotificationDeliveries();
      if ('error' in del) {
        setDeliveries(null);
        setDeliveriesError(del.error);
      } else {
        setDeliveries(del.deliveries);
        setDeliveriesError(null);
      }
    } else {
      // Status unread → delivery log is unavailable, not "quietly empty".
      setDeliveries(null);
      setDeliveriesError('error' in st ? st.error : 'notification status unavailable');
    }
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      await load();
      if (live) setLoaded(true);
    })();
    return () => {
      live = false;
    };
    // Loaded once; every mutation re-reads through load().
  }, []);

  const offline = loaded && endpoints === null;

  const openAdd = () => {
    setEditing(null);
    setDraft(EMPTY);
    setDrawerOpen(true);
  };

  const openEdit = (view: NotificationEndpointView) => {
    setEditing(view);
    setDraft({
      name: view.name,
      url: view.url,
      template: view.template,
      secret: '',
      clearSecret: false,
      enabled: view.enabled,
    });
    setDrawerOpen(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const base: NotificationEndpointInput = {
      name: draft.name.trim(),
      url: draft.url.trim(),
      template: draft.template,
      enabled: draft.enabled,
    };
    const res = editing
      ? await updateNotificationEndpoint(editing.id, {
          ...base,
          // Write-only secret: blank keeps the stored one; the checkbox is
          // the only way to say "clear it" — an empty field must never mean
          // deletion by accident.
          ...(draft.clearSecret ? { hmacSecret: null } : draft.secret ? { hmacSecret: draft.secret } : {}),
        })
      : await createNotificationEndpoint({
          ...base,
          ...(draft.secret ? { hmacSecret: draft.secret } : {}),
        });
    setSaving(false);
    if ('error' in res) {
      toast(res.error, { tone: 'danger' });
      return;
    }
    toast(editing ? 'Endpoint updated' : 'Endpoint added', {
      description:
        status?.demoMode
          ? 'demo mode — transitions render into the outbox; nothing is POSTed.'
          : 'alert transitions will be POSTed to this endpoint.',
      tone: 'success',
    });
    setDrawerOpen(false);
    await load();
  };

  const remove = (view: NotificationEndpointView) => {
    setPendingRemove(view);
  };

  const confirmRemove = async () => {
    if (!pendingRemove) return;
    setRemoveBusy(true);
    try {
      const res = await deleteNotificationEndpoint(pendingRemove.id);
      if ('error' in res) {
        toast(res.error, { tone: 'danger' });
        return;
      }
      toast(`${pendingRemove.name} removed`, { tone: 'success' });
      await load();
    } finally {
      setRemoveBusy(false);
    }
  };

  const test = async (view: NotificationEndpointView) => {
    if (testingId) return;
    setTestingId(view.id);
    const res = await testNotificationEndpoint(view.id);
    setTestingId(null);
    if ('error' in res) {
      toast(res.error, { tone: 'danger' });
      return;
    }
    // The server's message is the honest one — it distinguishes delivered,
    // refused, HTTP-failed and demo-swallowed. Surface it verbatim.
    toast(res.result.ok ? 'Test delivered' : 'Test failed', {
      description: res.result.message,
      tone: res.result.ok ? (res.result.demo ? 'warning' : 'success') : 'danger',
    });
    await load();
  };

  const set = (key: keyof Draft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  /** Shareable Systems deep-link that scrolls to this section. */
  const copySectionLink = () => {
    void (async () => {
      const url = buildSystemsSectionUrl('notifications');
      try {
        await navigator.clipboard.writeText(url);
        toast('Notifications link copied', {
          description: 'section=notifications',
          tone: 'success',
        });
      } catch {
        toast('Could not copy link', { description: url, tone: 'warning' });
      }
    })();
  };

  return (
    <>
    <div id={systemsSectionDomId('notifications')} className="nt-systems-section nt-section-panel nt-stack nt-gap-14">
      <div className="nt-filter-bar nt-gap-8">
        <SectionHeader label="Notifications" meta="ALERT WEBHOOKS · OUTBOUND" />
        <Button variant="ghost" size="sm" className="nt-ml-auto" onClick={copySectionLink}>
          Copy section link
        </Button>
      </div>

      <div className="nt-filter-bar nt-gap-8">
        {status ? (
          <>
            <Badge tone={status.demoMode ? 'warning' : 'success'} dot>
              {status.demoMode ? 'demo — nothing is sent' : 'live — sends are real'}
            </Badge>
            <Badge tone={status.sampling.running ? 'success' : 'neutral'} dot>
              {status.sampling.running
                ? `watching the alert queue · ${status.sampling.trackedGroups} tracked`
                : 'sampler not running'}
            </Badge>
          </>
        ) : (
          <span className="nt-hint-muted">
            {loadError ?? (offline ? 'backend offline — notification settings unavailable' : 'reading notification status…')}
          </span>
        )}
      </div>

      {status?.demoMode ? (
        <Alert tone="info" title="Demo mode — the outbox is the destination">
          No network call is ever made in demo mode. Would-have-sent payloads land in the demo outbox below,
          rendered exactly as the endpoint would receive them.
        </Alert>
      ) : null}

      {/* ---------------- endpoint rows ---------------- */}
      <div className="nt-stack nt-gap-2">
        {(endpoints ?? []).map((view) => {
          const delivery = deliveryLine(view);
          return (
            <div key={view.id} className="nt-sync-row nt-row-start nt-pad-row">
              <div className="nt-stack nt-stack-col--flex nt-gap-3">
                <div className="nt-filter-bar nt-gap-8">
                  <span className="nt-body-sm nt-text-primary">{view.name}</span>
                  <Badge tone="neutral">{view.template}</Badge>
                  {view.hmacSecretConfigured ? <Badge tone="neutral">signed</Badge> : null}
                  <Badge tone={view.enabled ? 'success' : 'neutral'} dot>
                    {view.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                </div>
                <span className="nt-hint-muted nt-ellipsis">{view.url}</span>
                <span className={`nt-hint-muted ${`nt-tone-${delivery.tone === 'danger' ? 'danger' : delivery.tone === 'success' ? 'success' : delivery.tone === 'warning' ? 'warning' : 'muted'}`}`}>
                  {delivery.text}
                </span>
              </div>
              <Button variant="ghost" size="sm" disabled={offline || testingId !== null} onClick={() => void test(view)}>
                {testingId === view.id ? 'Testing…' : 'Test'}
              </Button>
              <Button variant="ghost" size="sm" disabled={offline} onClick={() => openEdit(view)}>
                Edit
              </Button>
              <Button variant="ghost" size="sm" disabled={offline} onClick={() => void remove(view)}>
                Remove
              </Button>
            </div>
          );
        })}
        {endpoints !== null && endpoints.length === 0 ? (
          <div className="nt-hint-muted nt-pad-row">
            no endpoints yet — the alert queue only reaches this screen until one is added
          </div>
        ) : null}
      </div>

      <div className="nt-filter-bar nt-gap-14">
        <Button variant="primary" size="sm" disabled={offline} onClick={openAdd}>
          Add endpoint
        </Button>
        <span className="nt-configure-row__name-meta">
          HTTPS only · HMAC-SHA256 signature optional · failures stay on the row
        </span>
      </div>

      {/* ---------------- demo outbox ---------------- */}
      {outbox ? (
        <div className="nt-stack nt-gap-8">
          <div className="nt-filter-bar nt-gap-8">
            <SectionHeader label="Demo outbox" meta={`${outbox.entries.length} WOULD-HAVE-SENT · NOTHING LEFT THE PROCESS`} />
            <Button
              variant="ghost"
              size="sm"
              className="nt-ml-auto"
              onClick={() => {
                void (async () => {
                  const res = await downloadApiCsv(
                    '/api/notifications/outbox/export',
                    'notification-outbox.csv',
                  );
                  if (res.ok) {
                    toast('Server CSV downloaded', {
                      description:
                        'notification-outbox.csv — event summaries only (no payload bodies).',
                      tone: 'success',
                    });
                  } else {
                    toast('Server CSV failed', {
                      description: res.error ?? 'Could not download export',
                      tone: 'warning',
                    });
                  }
                })();
              }}
            >
              Download server CSV
            </Button>
          </div>
          {outbox.entries.length === 0 ? (
            <div className="nt-hint-muted">
              empty — nothing has fired, resolved or escalated since the sampler started
            </div>
          ) : (
            outbox.entries.map((entry) => (
              <div
                key={entry.id}
                className="nt-stack nt-gap-6 nt-rule-row-pad"
              >
                <div className="nt-filter-bar nt-gap-8">
                  <Badge tone={entry.event.kind === 'fired' ? 'danger' : entry.event.kind === 'resolved' ? 'success' : 'warning'}>
                    {NOTIFICATION_KIND_LABEL[entry.event.kind]}
                  </Badge>
                  <span className="nt-body-sm nt-text-primary">{entry.endpointName}</span>
                  <Badge tone="neutral">demo</Badge>
                  <span className="nt-hint-muted">
                    {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {entry.contentType}
                  </span>
                </div>
                <Code block>{entry.body}</Code>
              </div>
            ))
          )}
        </div>
      ) : null}

      {/* ---------------- live delivery attempt log (no bodies) ---------------- */}
      {loaded ? (
        <div className="nt-stack nt-gap-8">
          {(() => {
            const qNeedle = deliveryQ.trim().toLowerCase();
            const deliveryRows =
              deliveries?.entries.filter((e) => {
                if (deliveryResult !== 'all' && e.result !== deliveryResult) return false;
                if (!qNeedle) return true;
                const hay = [
                  e.endpointName,
                  e.title,
                  e.error ?? '',
                  e.eventKind,
                  e.fingerprint,
                  e.result,
                  e.httpCode ?? '',
                  e.test ? 'test' : '',
                ]
                  .join(' ')
                  .toLowerCase();
                return hay.includes(qNeedle);
              }) ?? [];
            const narrowed =
              deliveryResult !== 'all' || qNeedle.length > 0;
            return (
          <>
          <div className="nt-filter-bar nt-gap-8">
            <SectionHeader
              label="Delivery log"
              meta={
                deliveries
                  ? `${deliveryRows.length}${
                      narrowed ? ` of ${deliveries.entries.length}` : ''
                    } ATTEMPTS · OUTCOMES ONLY · NO PAYLOADS`
                  : 'OUTCOMES ONLY · NO PAYLOADS · NO URLS · NO SECRETS'
              }
            />
            <div className="nt-w-140">
              <Select
                options={[
                  { value: 'all', label: 'All outcomes' },
                  { value: 'delivered', label: 'Delivered' },
                  { value: 'failed', label: 'Failed' },
                  { value: 'demo', label: 'Demo' },
                ]}
                value={deliveryResult}
                onValueChange={(v) =>
                  setDeliveryResult(
                    v === 'delivered' || v === 'failed' || v === 'demo' ? v : 'all',
                  )
                }
                size="sm"
                aria-label="Filter delivery outcomes"
              />
            </div>
            <div className="nt-w-180">
              <Input
                value={deliveryQ}
                onChange={(e) => setDeliveryQ(e.target.value)}
                placeholder="Search endpoint, title…"
                aria-label="Search delivery log"
                size="sm"
              />
            </div>
            {deliveryRows.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="nt-ml-auto"
                onClick={() => {
                  const n = exportTableCsv(
                    'notification-deliveries.csv',
                    ['at', 'result', 'test', 'endpoint', 'title', 'httpCode', 'error'],
                    deliveryRows.map((e) => [
                      e.at,
                      e.result,
                      e.test ? 'yes' : 'no',
                      e.endpointName,
                      e.title,
                      e.httpCode ?? '',
                      e.error ?? '',
                    ]),
                  );
                  toast(`Exported ${n} attempt${n === 1 ? '' : 's'}`, {
                    description: 'notification-deliveries.csv — outcomes only, no payloads.',
                  });
                }}
              >
                Export CSV
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className={deliveryRows.length > 0 ? undefined : 'nt-ml-auto'}
              onClick={() => {
                void (async () => {
                  const qs = new URLSearchParams();
                  if (deliveryResult !== 'all') qs.set('result', deliveryResult);
                  if (deliveryQ.trim()) qs.set('q', deliveryQ.trim());
                  const suffix = qs.toString() ? `?${qs}` : '';
                  const res = await downloadApiCsv(
                    `/api/notifications/deliveries/export${suffix}`,
                    'notification-deliveries.csv',
                  );
                  if (res.ok) {
                    toast('Server CSV downloaded', {
                      description: 'notification-deliveries.csv — outcomes only, no payloads.',
                      tone: 'success',
                    });
                  } else {
                    toast('Server CSV failed', {
                      description: res.error ?? 'Could not download export',
                      tone: 'warning',
                    });
                  }
                })();
              }}
            >
              Download server CSV
            </Button>
          </div>
          {deliveriesError ? (
            <div className="nt-hint-muted">
              delivery log unavailable — {deliveriesError}
            </div>
          ) : !deliveries || deliveries.entries.length === 0 ? (
            <div className="nt-hint-muted">
              empty — no test or transition delivery has been attempted since this process started
            </div>
          ) : deliveryRows.length === 0 ? (
            <div className="nt-hint-muted">
              no attempts match this filter — clear search or choose All outcomes to widen
            </div>
          ) : (
            deliveryRows.map((entry) => (
              <div
                key={entry.id}
                className="nt-delivery-row nt-filter-bar nt-gap-8 nt-rule-row-pad-sm"
                data-result={entry.result}
              >
                <Badge
                  tone={
                    entry.result === 'delivered'
                      ? 'success'
                      : entry.result === 'demo'
                        ? 'warning'
                        : 'danger'
                  }
                >
                  {entry.result}
                </Badge>
                {entry.test ? <Badge tone="neutral">test</Badge> : null}
                <span className="nt-body-sm nt-text-primary">{entry.endpointName}</span>
                <span className="nt-body-sm nt-body-sec">{entry.title}</span>
                <span className="nt-hint-muted nt-ml-auto">
                  {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  {entry.httpCode != null ? ` · HTTP ${entry.httpCode}` : ''}
                  {entry.error ? ` · ${entry.error}` : ''}
                </span>
              </div>
            ))
          )}
          </>
            );
          })()}
        </div>
      ) : null}

      {/* ---------------- email channel: SMTP, fleet report, SSL watch ---------------- */}
      <SmtpCard demoMode={status?.demoMode ?? null} />
      <ReportCard />
      <SslHostsCard demoMode={status?.demoMode ?? null} />

      {/* ---------------- add / edit drawer ---------------- */}
      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        width="md"
        className="nd-drawer--write-ritual nt-write-ritual"
        dataPhase={saving ? 'executing' : draft.name.trim() && draft.url.trim() ? 'confirm' : 'review'}
        title={editing ? `Edit ${editing.name}` : 'Add notification endpoint'}
        description="Alert queue transitions are POSTed here — fired, resolved, escalated."
      >
        <div className="nt-stack nt-gap-14">
          <FormField label="Name" help="What this destination is called in the list and the audit log.">
            <Input value={draft.name} onChange={set('name')} placeholder="noc-slack" aria-label="Endpoint name" />
          </FormField>
          <FormField
            label="Endpoint URL"
            help="HTTPS only, never a private or loopback address — the same SSRF rule as the Central webhook callbacks."
          >
            <Input
              mono
              value={draft.url}
              onChange={set('url')}
              placeholder="https://hooks.slack.com/services/…"
              aria-label="Endpoint URL"
            />
          </FormField>
          <FormField label="Payload template" help="How the transition is rendered for the receiver.">
            <Select
              options={NOTIFICATION_TEMPLATE_OPTIONS}
              value={draft.template}
              onValueChange={(v) => {
                if (isNotificationTemplateKind(v)) setDraft((d) => ({ ...d, template: v }));
              }}
              aria-label="Payload template"
            />
          </FormField>
          <FormField
            label="HMAC secret"
            help={
              editing?.hmacSecretConfigured
                ? 'A secret is stored. Leave blank to keep it; type to replace it.'
                : 'Optional. Signs every body as x-hpe-signature-256: sha256=<hex>.'
            }
          >
            <Input
              mono
              type="password"
              value={draft.secret}
              onChange={set('secret')}
              placeholder={editing?.hmacSecretConfigured ? '(stored — write-only, never shown)' : '••••••••••••'}
              aria-label="HMAC secret"
            />
          </FormField>
          {editing?.hmacSecretConfigured ? (
            <Checkbox
              checked={draft.clearSecret}
              onChange={(e) => setDraft((d) => ({ ...d, clearSecret: e.target.checked, secret: e.target.checked ? '' : d.secret }))}
              label="Clear the stored signing secret on save"
            />
          ) : null}
          <Switch
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            label="Enabled — a disabled endpoint keeps its config but receives nothing"
          />
          <div className="nt-chip-wrap">
            <Button variant="primary" disabled={saving || !draft.name.trim() || !draft.url.trim()} onClick={() => void save()}>
              {saving ? 'Saving…' : editing ? 'Save endpoint' : 'Add endpoint'}
            </Button>
            <Button variant="ghost" onClick={() => setDrawerOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Drawer>
    </div>
      <ConfirmDialog
        open={pendingRemove != null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title={pendingRemove ? `Remove ${pendingRemove.name}?` : 'Confirm'}
        description={
          pendingRemove
            ? `Alert transitions will no longer be sent to ${pendingRemove.url}.`
            : undefined
        }
        confirmLabel="Remove"
        tone="danger"
        busy={removeBusy}
        onConfirm={confirmRemove}
      />
    </>
  );
}


// ---------------------------------------------------------------------------
// Email channel — SMTP relay, fleet summary report, SSL certificate watch
// ---------------------------------------------------------------------------


function when(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface SmtpDraft {
  host: string;
  port: string;
  user: string;
  password: string;
  clearPassword: boolean;
  from: string;
  tls: boolean;
}

const EMPTY_SMTP: SmtpDraft = { host: '', port: '587', user: '', password: '', clearPassword: false, from: '', tls: true };

/** The SMTP relay card: one config, password write-only, test down the real
 *  path. In demo mode nothing is ever dialled — the test lands in the
 *  report outbox instead. */
function SmtpCard({ demoMode }: { demoMode: boolean | null }) {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [smtp, setSmtp] = useState<SmtpConfigView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<SmtpDraft>(EMPTY_SMTP);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);

  const load = async () => {
    const r = await getSmtpConfig();
    if ('error' in r) {
      setError(`SMTP settings could not be loaded: ${r.error}`);
      return;
    }
    setSmtp(r.smtp);
    setError(null);
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      await load();
      if (live) setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const openEdit = () => {
    setDraft(
      smtp
        ? { host: smtp.host, port: String(smtp.port), user: smtp.user ?? '', password: '', clearPassword: false, from: smtp.from, tls: smtp.tls }
        : EMPTY_SMTP,
    );
    setDrawerOpen(true);
  };

  const save = async () => {
    if (saving) return;
    const port = Number(draft.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      toast('port must be a number between 1 and 65535', { tone: 'danger' });
      return;
    }
    setSaving(true);
    const res = await putSmtpConfig({
      host: draft.host.trim(),
      port,
      ...(draft.user.trim() ? { user: draft.user.trim() } : {}),
      // Write-only password: blank keeps the stored one; the checkbox is the
      // only way to say "clear it".
      ...(draft.clearPassword ? { password: null } : draft.password ? { password: draft.password } : {}),
      from: draft.from.trim(),
      tls: draft.tls,
    });
    setSaving(false);
    if ('error' in res) {
      toast(res.error, { tone: 'danger' });
      return;
    }
    toast('SMTP relay saved', {
      description: demoMode ? 'demo mode — nothing is emailed; sends render into the report outbox.' : `mail goes through ${res.smtp.host}:${res.smtp.port}.`,
      tone: 'success',
    });
    setDrawerOpen(false);
    await load();
  };

  const remove = () => {
    if (!smtp) return;
    setPendingRemove(true);
  };

  const confirmRemove = async () => {
    if (!smtp) return;
    setRemoveBusy(true);
    try {
      const res = await deleteSmtpConfig();
      if ('error' in res) {
        toast(res.error, { tone: 'danger' });
        return;
      }
      toast('SMTP relay removed', { tone: 'success' });
      setPendingRemove(false);
      await load();
    } finally {
      setRemoveBusy(false);
    }
  };

  const test = async () => {
    if (testing) return;
    setTesting(true);
    const res = await testSmtpConfig();
    setTesting(false);
    if ('error' in res) {
      toast(res.error, { tone: 'danger' });
      return;
    }
    // The server's message is the honest one — delivered, refused or
    // demo-swallowed. Surface it verbatim.
    toast(res.result.ok ? 'Test email accepted' : 'Test failed', {
      description: res.result.message,
      tone: res.result.ok ? (res.result.demo ? 'warning' : 'success') : 'danger',
    });
  };

  const set = (key: keyof SmtpDraft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  return (
    <div className="nt-stack nt-gap-8">
      <SectionHeader label="Email (SMTP)" meta="FLEET REPORTS BY EMAIL · OUTBOUND" />
      <div className="nt-filter-bar nt-gap-8">
        {demoMode ? <Badge tone="warning" dot>demo — never dials</Badge> : null}
        {smtp ? (
          <Badge tone={smtp.tls ? 'success' : 'warning'} dot>
            {smtp.tls ? 'STARTTLS' : 'plaintext'}
          </Badge>
        ) : null}
      </div>
      {error ? <span className="nt-hint-muted">{error}</span> : null}
      {!loaded && !error ? <span className="nt-hint-muted">reading SMTP settings…</span> : null}
      {loaded && !error && !smtp ? (
        <div className="nt-filter-bar nt-gap-14">
          <span className="nt-hint-muted">no relay configured — the fleet report renders as a preview and can be emailed nowhere</span>
          <Button variant="primary" size="sm" onClick={openEdit}>
            Configure SMTP
          </Button>
        </div>
      ) : null}
      {smtp ? (
        <div className="nt-row-center nt-gap-10 nt-rule-row">
          <div className="nt-stack-col--flex nt-gap-3">
            <div className="nt-filter-bar nt-gap-8">
              <span className="nt-mono-11 nt-fs-12-primary">
                {smtp.host}:{smtp.port}
              </span>
              {smtp.user ? <Badge tone="neutral">auth as {smtp.user}</Badge> : <Badge tone="neutral">no auth</Badge>}
              <Badge tone="neutral">{smtp.passwordConfigured ? 'password set — write-only' : 'no password'}</Badge>
            </div>
            <span className="nt-hint-muted">from {smtp.from}</span>
          </div>
          <Button variant="ghost" size="sm" disabled={testing} onClick={() => void test()}>
            {testing ? 'Testing…' : 'Test'}
          </Button>
          <Button variant="ghost" size="sm" onClick={openEdit}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void remove()}>
            Remove
          </Button>
        </div>
      ) : null}

      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        width="md"
        className="nd-drawer--write-ritual nt-write-ritual"
        dataPhase={saving ? 'executing' : draft.host.trim() && draft.from.trim() ? 'confirm' : 'review'}
        title={smtp ? `Edit SMTP relay (${smtp.host})` : 'Configure SMTP relay'}
        description="Where fleet reports are emailed from. The password is write-only — never shown back."
      >
        <div className="nt-stack nt-gap-14">
          <FormField label="Host" help="A hostname, not a URL — no scheme, no path.">
            <Input mono value={draft.host} onChange={set('host')} placeholder="smtp.example.com" aria-label="SMTP host" />
          </FormField>
          <FormField label="Port" help="587 is the submission port; STARTTLS below upgrades it.">
            <Input mono value={draft.port} onChange={set('port')} placeholder="587" aria-label="SMTP port" />
          </FormField>
          <FormField label="Username" help="Optional — a relay that takes anonymous submission leaves this blank.">
            <Input mono value={draft.user} onChange={set('user')} placeholder="reports@example.com" aria-label="SMTP username" />
          </FormField>
          <FormField
            label="Password"
            help={
              smtp?.passwordConfigured
                ? 'A password is stored. Leave blank to keep it; type to replace it.'
                : 'Optional. Sent only after STARTTLS when that is on — never logged, never shown back.'
            }
          >
            <Input
              mono
              type="password"
              value={draft.password}
              onChange={set('password')}
              placeholder={smtp?.passwordConfigured ? '(stored — write-only, never shown)' : '••••••••••••'}
              aria-label="SMTP password"
            />
          </FormField>
          {smtp?.passwordConfigured ? (
            <Checkbox
              checked={draft.clearPassword}
              onChange={(e) => setDraft((d) => ({ ...d, clearPassword: e.target.checked, password: e.target.checked ? '' : d.password }))}
              label="Clear the stored password on save"
            />
          ) : null}
          <FormField label="From address" help="The sender reports come from; also the test email's default recipient.">
            <Input mono value={draft.from} onChange={set('from')} placeholder="fleet-reports@example.com" aria-label="From address" />
          </FormField>
          <Switch
            checked={draft.tls}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, tls: v }))}
            label="STARTTLS — upgrade the connection before authenticating (off means plaintext)"
          />
          <div className="nt-chip-wrap">
            <Button variant="primary" disabled={saving || !draft.host.trim() || !draft.from.trim()} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save relay'}
            </Button>
            <Button variant="ghost" onClick={() => setDrawerOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Drawer>
      <ConfirmDialog
        open={pendingRemove}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(false);
        }}
        title={smtp ? `Remove SMTP relay ${smtp.host}:${smtp.port}?` : 'Remove SMTP relay?'}
        description="Scheduled reports will render as previews and go nowhere until a relay is configured again."
        confirmLabel="Remove relay"
        tone="danger"
        busy={removeBusy}
        onConfirm={confirmRemove}
      />
    </div>
  );
}

interface ReportDraft {
  enabled: boolean;
  frequency: ReportFrequency;
  hour: number;
  recipients: string;
}

/** The schedule line's last-outcome wording, verbatim from the config row. */
function reportOutcomeLine(config: ReportConfig): { text: string; tone: 'success' | 'danger' | 'warning' | 'neutral' } {
  if (!config.lastResult || !config.lastAttemptAt) return { text: 'never sent', tone: 'neutral' };
  const at = when(config.lastAttemptAt);
  switch (config.lastResult) {
    case 'sent':
      return { text: `sent · ${at}`, tone: 'success' };
    case 'demo':
      return { text: `demo — rendered to outbox · ${at}`, tone: 'warning' };
    case 'skipped':
      return { text: `skipped — ${config.lastError ?? 'not sent'} · ${at}`, tone: 'warning' };
    default:
      return { text: `failed — ${config.lastError ?? 'unknown'} · ${at}`, tone: 'danger' };
  }
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00 UTC` }));
const FREQUENCY_OPTIONS: { value: ReportFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly (Mondays)' },
];

/** The fleet summary report card: schedule, last outcome, Send now, and the
 *  preview — the exact would-be-sent body, available in every mode. */
function ReportCard() {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [schedule, setSchedule] = useState<ReportSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<ReportDraft>({ enabled: false, frequency: 'daily', hour: 6, recipients: '' });
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<FleetReport | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = async () => {
    const r = await getReportSchedule();
    if ('error' in r) {
      setError(`report schedule could not be loaded: ${r.error}`);
      return;
    }
    setSchedule(r.report);
    setError(null);
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      await load();
      if (live) setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const config = schedule?.config ?? null;

  const openEdit = () => {
    if (config) {
      setDraft({ enabled: config.enabled, frequency: config.frequency, hour: config.hour, recipients: config.recipients.join(', ') });
    }
    setDrawerOpen(true);
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const recipients = draft.recipients.split(/[\s,]+/).filter(Boolean);
    const res = await putReportSchedule({ enabled: draft.enabled, frequency: draft.frequency, hour: draft.hour, recipients });
    setSaving(false);
    if ('error' in res) {
      toast(res.error, { tone: 'danger' });
      return;
    }
    toast('Report schedule saved', {
      description: res.config.enabled
        ? `fires ${res.config.frequency} at ${String(res.config.hour).padStart(2, '0')}:00 UTC.`
        : 'disabled — the schedule is kept but nothing fires.',
      tone: 'success',
    });
    setDrawerOpen(false);
    await load();
  };

  const sendNow = async () => {
    if (sending) return;
    setSending(true);
    const res = await sendReportNow();
    setSending(false);
    if ('error' in res) {
      toast(res.error, { tone: 'danger' });
      return;
    }
    toast(res.result.ok ? 'Report sent' : 'Report not sent', {
      description: res.result.message,
      tone: res.result.ok ? (res.result.demo ? 'warning' : 'success') : 'danger',
    });
    await load();
  };

  const togglePreview = async () => {
    if (previewOpen) {
      setPreviewOpen(false);
      return;
    }
    setPreviewLoading(true);
    const res = await getReportPreview();
    setPreviewLoading(false);
    if ('error' in res) {
      toast(res.error, { tone: 'danger' });
      return;
    }
    setPreview(res.report);
    setPreviewOpen(true);
  };

  const outcome = config ? reportOutcomeLine(config) : null;

  return (
    <div className="nt-stack nt-gap-8">
      <SectionHeader label="Fleet summary report" meta="DAILY/WEEKLY · UTC · BY EMAIL" />
      {error ? <span className="nt-hint-muted">{error}</span> : null}
      {!loaded && !error ? <span className="nt-hint-muted">reading report schedule…</span> : null}
      {config ? (
        <>
          <div className="nt-filter-bar nt-gap-8">
            <Badge tone={config.enabled ? 'success' : 'neutral'} dot>
              {config.enabled ? 'scheduled' : 'disabled'}
            </Badge>
            {schedule?.demoMode ? <Badge tone="warning" dot>demo — renders to outbox</Badge> : null}
            <span className="nt-hint-muted">
              {config.frequency} at {String(config.hour).padStart(2, '0')}:00 UTC →{' '}
              {config.recipients.length > 0 ? config.recipients.join(', ') : 'no recipients'}
            </span>
            {outcome ? (
              <span
                className={`nt-hint-muted ${`nt-tone-${outcome.tone === 'danger' ? 'danger' : outcome.tone === 'success' ? 'success' : outcome.tone === 'warning' ? 'warning' : 'muted'}`}`}
              >
                {outcome.text}
              </span>
            ) : null}
          </div>
          <div className="nt-filter-bar nt-gap-8">
            <Button variant="primary" size="sm" disabled={sending} onClick={() => void sendNow()}>
              {sending ? 'Sending…' : 'Send now'}
            </Button>
            <Button variant="ghost" size="sm" disabled={previewLoading} onClick={() => void togglePreview()}>
              {previewLoading ? 'Rendering…' : previewOpen ? 'Hide preview' : 'Preview'}
            </Button>
            <Button variant="ghost" size="sm" onClick={openEdit}>
              Edit schedule
            </Button>
          </div>
        </>
      ) : null}

      {previewOpen && preview ? (
        <div className="nt-stack nt-gap-6">
          <div className="nt-filter-bar nt-gap-8">
            <span className="nt-body-sm nt-text-primary">{preview.subject}</span>
            {preview.demo ? <Badge tone="warning">demo data</Badge> : null}
            <span className="nt-hint-muted">generated {when(preview.generatedAt)} · the email carries this text part plus an HTML rendering</span>
          </div>
          {preview.notes.length > 0 ? (
            <Alert tone="warning" title="Data gaps in this report">
              {preview.notes.join(' · ')}
            </Alert>
          ) : null}
          <Code block>{preview.text}</Code>
        </div>
      ) : null}

      {schedule?.demoMode && schedule.entries.length > 0 ? (
        <div className="nt-stack nt-gap-6">
          <div className="nt-filter-bar nt-gap-8">
            <span className="nt-hint-muted">
              {schedule.entries.length} would-have-sent report
              {schedule.entries.length === 1 ? '' : 's'} — nothing left the process
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="nt-ml-auto"
              onClick={() => {
                void (async () => {
                  const res = await downloadApiCsv(
                    '/api/notifications/report/export',
                    'fleet-report-outbox.csv',
                  );
                  if (res.ok) {
                    toast('Server CSV downloaded', {
                      description:
                        'fleet-report-outbox.csv — subject/recipients only (no email bodies).',
                      tone: 'success',
                    });
                  } else {
                    toast('Server CSV failed', {
                      description: res.error ?? 'Could not download export',
                      tone: 'warning',
                    });
                  }
                })();
              }}
            >
              Download server CSV
            </Button>
          </div>
          {schedule.entries.map((entry) => (
            <div key={entry.id} className="nt-stack-col nt-gap-4 nt-rule-row-sm">
              <div className="nt-filter-bar nt-gap-8">
                <Badge tone="neutral">demo</Badge>
                <span className="nt-body-sm nt-text-primary">{entry.subject}</span>
                <span className="nt-hint-muted">
                  {when(entry.at)} · to {entry.recipients.length > 0 ? entry.recipients.join(', ') : 'no recipients'}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <Drawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        width="md"
        className="nd-drawer--write-ritual nt-write-ritual"
        dataPhase={saving ? 'executing' : 'confirm'}
        title="Fleet summary report schedule"
        description="Totals and offline devices by type, bell alert counts, and subscriptions approaching expiry — emailed through the configured SMTP relay."
      >
        <div className="nt-stack nt-gap-14">
          <Switch
            checked={draft.enabled}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
            label="Enabled — a disabled schedule keeps its settings but fires nothing"
          />
          <FormField label="Frequency" help="Weekly fires on Mondays.">
            <Select
              options={FREQUENCY_OPTIONS}
              value={draft.frequency}
              onValueChange={(v) => {
                if (v === 'daily' || v === 'weekly') setDraft((d) => ({ ...d, frequency: v }));
              }}
              aria-label="Report frequency"
            />
          </FormField>
          <FormField label="Hour (UTC)" help="The fire hour, in UTC — server-local timezones are a deployment accident the schedule does not inherit.">
            <Select
              options={HOUR_OPTIONS}
              value={String(draft.hour)}
              onValueChange={(v) => setDraft((d) => ({ ...d, hour: Number(v) }))}
              aria-label="Report hour"
            />
          </FormField>
          <FormField label="Recipients" help="One or more email addresses, comma-separated.">
            <Input mono value={draft.recipients} onChange={(e) => setDraft((d) => ({ ...d, recipients: e.target.value }))} placeholder="noc@example.com, netops@example.com" aria-label="Report recipients" />
          </FormField>
          <div className="nt-chip-wrap">
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save schedule'}
            </Button>
            <Button variant="ghost" onClick={() => setDrawerOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Drawer>
    </div>
  );
}

/** One watch-list row's probe line, verbatim from the persisted outcome. */
function probeLine(host: SslProbeHost): { text: string; tone: 'success' | 'danger' | 'warning' | 'neutral' } {
  const p = host.lastProbe;
  if (!p) return { text: 'not probed yet — the scheduler checks on its next pass', tone: 'neutral' };
  const at = new Date(p.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (!p.ok) return { text: `probe failed — ${p.error ?? 'unknown'} · ${at}`, tone: 'danger' };
  const left = p.daysLeft ?? null;
  if (left === null) return { text: `expires ${p.notAfter ?? 'unknown'} · probed ${at}`, tone: 'neutral' };
  return {
    text: `${left < 0 ? `expired ${-left}d ago` : `expires in ${left}d`} · ${p.notAfter?.slice(0, 10) ?? ''} · probed ${at}`,
    tone: left < 0 || left <= 15 ? 'danger' : left <= 30 ? 'warning' : 'success',
  };
}

/** The SSL certificate watch card: hosts whose certificate expiry walks the
 *  90/60/30/15-day ladder into the notification center. */
function SslHostsCard({ demoMode }: { demoMode: boolean | null }) {
  const { toast } = useToast();
  const [loaded, setLoaded] = useState(false);
  const [hosts, setHosts] = useState<SslProbeHost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [addValue, setAddValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<SslProbeHost | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  /** Text triage for watch list + server CSV (Loop 116 `q=`). */
  const [sslQ, setSslQ] = useState('');

  const load = async () => {
    const r = await getSslHosts();
    if ('error' in r) {
      setError(`SSL watch list could not be loaded: ${r.error}`);
      return;
    }
    setHosts(r.hosts);
    setError(null);
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      await load();
      if (live) setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const add = async () => {
    if (adding || !addValue.trim()) return;
    setAdding(true);
    const res = await addSslHost(addValue.trim());
    setAdding(false);
    if ('error' in res) {
      toast(res.error, { tone: 'danger' });
      return;
    }
    setAddValue('');
    toast(`Watching ${res.host.host}:${res.host.port}`, {
      description: demoMode ? 'demo mode — probes never dial; the demo certificate walks the ladder instead.' : 'probed on the scheduler’s next pass, then every 6h.',
      tone: 'success',
    });
    await load();
  };

  const remove = (host: SslProbeHost) => {
    setPendingRemove(host);
  };

  const confirmRemove = async () => {
    if (!pendingRemove) return;
    setRemoveBusy(true);
    try {
      const res = await removeSslHost(pendingRemove.id);
      if ('error' in res) {
        toast(res.error, { tone: 'danger' });
        return;
      }
      toast(`${pendingRemove.host}:${pendingRemove.port} removed`, { tone: 'success' });
      setPendingRemove(null);
      await load();
    } finally {
      setRemoveBusy(false);
    }
  };

  const probe = async (host: SslProbeHost) => {
    if (probingId) return;
    setProbingId(host.id);
    const res = await probeSslHost(host.id);
    setProbingId(null);
    if ('error' in res) {
      toast(res.error, { tone: 'danger' });
      return;
    }
    if (res.result.demo) {
      toast('Probe skipped', { description: res.result.message, tone: 'warning' });
      return;
    }
    const probeResult = res.result.host?.lastProbe;
    toast(probeResult?.ok ? 'Probe succeeded' : 'Probe failed', {
      description: probeResult?.ok
        ? `${host.host}:${host.port} — certificate expires ${probeResult.notAfter?.slice(0, 10) ?? 'unknown'}.`
        : probeResult?.error ?? 'unknown error',
      tone: probeResult?.ok ? 'success' : 'danger',
    });
    await load();
  };

  const sslNeedle = sslQ.trim().toLowerCase();
  const visibleHosts = !sslNeedle
    ? hosts
    : hosts.filter((h) => {
        const probe = h.lastProbe;
        const hay = [
          h.host,
          String(h.port),
          probe?.error ?? '',
          probe?.notAfter ?? '',
          probe?.ok === true ? 'ok yes' : probe?.ok === false ? 'fail no error' : '',
          probe?.daysLeft ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(sslNeedle);
      });

  return (
    <div className="nt-stack nt-gap-8">
      <SectionHeader
        label="SSL certificate watch"
        meta={
          loaded && !error && sslNeedle
            ? `${visibleHosts.length} of ${hosts.length} · EXPIRY LADDER · 90/60/30/15 DAYS`
            : 'EXPIRY LADDER · 90/60/30/15 DAYS'
        }
      />
      {loaded && !error ? (
        <div className="nt-filter-bar nt-gap-8">
          <div className="nt-w-180">
            <Input
              value={sslQ}
              onChange={(e) => setSslQ(e.target.value)}
              placeholder="Search host, port, error…"
              aria-label="Search SSL watch list"
              size="sm"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="nt-ml-auto"
            onClick={() => {
              void (async () => {
                const qs = new URLSearchParams();
                if (sslQ.trim()) qs.set('q', sslQ.trim());
                const suffix = qs.toString() ? `?${qs}` : '';
                const res = await downloadApiCsv(
                  `/api/notifications/ssl-hosts/export${suffix}`,
                  'ssl-hosts.csv',
                );
                if (res.ok) {
                  toast('Server CSV downloaded', {
                    description: 'ssl-hosts.csv — watch list + last probe (no PEMs).',
                    tone: 'success',
                  });
                } else {
                  toast('Server CSV failed', {
                    description: res.error ?? 'Could not download export',
                    tone: 'warning',
                  });
                }
              })();
            }}
          >
            Download server CSV
          </Button>
        </div>
      ) : null}
      {demoMode ? (
        <div className="nt-filter-bar nt-gap-8">
          <Badge tone="warning" dot>demo — probes never dial</Badge>
          <span className="nt-hint-muted">a labelled demo certificate walks the ladder instead</span>
        </div>
      ) : null}
      {error ? <span className="nt-hint-muted">{error}</span> : null}
      {!loaded && !error ? <span className="nt-hint-muted">reading the watch list…</span> : null}
      <div className="nt-stack nt-gap-2">
        {visibleHosts.map((host) => {
          const line = probeLine(host);
          return (
            <div
              key={host.id}
              className="nt-row-center nt-gap-10 nt-rule-row"
            >
              <div className="nt-stack-col--flex nt-gap-3">
                <span className="nt-mono-11 nt-fs-12-primary">
                  {host.host}:{host.port}
                </span>
                <span
                  className={`nt-hint-muted ${`nt-tone-${line.tone === 'danger' ? 'danger' : line.tone === 'success' ? 'success' : line.tone === 'warning' ? 'warning' : 'muted'}`}`}
                >
                  {line.text}
                </span>
              </div>
              <Button variant="ghost" size="sm" disabled={probingId !== null} onClick={() => void probe(host)}>
                {probingId === host.id ? 'Probing…' : 'Probe now'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void remove(host)}>
                Remove
              </Button>
            </div>
          );
        })}
        {loaded && !error && hosts.length === 0 ? (
          <div className="nt-hint-muted nt-pad-row">no hosts watched — add one and its certificate expiry joins the 90/60/30/15-day ladder</div>
        ) : null}
        {loaded && !error && hosts.length > 0 && visibleHosts.length === 0 ? (
          <div className="nt-hint-muted nt-pad-row">no hosts match this search — clear the filter to widen</div>
        ) : null}
      </div>
      <div className="nt-filter-bar nt-gap-8">
        <Input
          mono
          value={addValue}
          onChange={(e) => setAddValue(e.target.value)}
          placeholder="host[:port] — e.g. vpn.example.com:8443"
          aria-label="SSL host to watch"
        />
        <Button variant="primary" size="sm" disabled={adding || !addValue.trim()} onClick={() => void add()}>
          {adding ? 'Adding…' : 'Add host'}
        </Button>
      </div>
      <ConfirmDialog
        open={pendingRemove != null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
        title={pendingRemove ? `Stop watching ${pendingRemove.host}:${pendingRemove.port}?` : 'Stop watching host?'}
        description="Its certificate expiry leaves the notification ladder until the host is added again."
        confirmLabel="Stop watching"
        tone="danger"
        busy={removeBusy}
        onConfirm={confirmRemove}
      />
    </div>
  );
}
