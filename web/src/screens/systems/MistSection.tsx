/**
 * web/src/screens/systems/MistSection.tsx — the Mist plane's own sections in
 * the Systems drawer's Configuration tab: the webhook receiver's
 * auto-registration, and the org audit log.
 *
 * REGISTRATION. The receiver (POST /api/hooks/mist) only receives once the
 * Mist org has a webhook subscription pointing at it. This panel reads the
 * registration status (which org subscriptions target this receiver, when a
 * delivery last arrived) and offers the REVIEWED register/rotate write: the
 * apply is gated on an explicit review checkbox, because it changes the org's
 * configuration; the signing secret is write-only (never rendered back, never
 * toasted); "Verify" is simply the status re-read — registered AND delivering
 * are two different facts and the panel keeps them separate.
 *
 * AUDIT LOG. The org's latest admin changes, read on demand when the drawer
 * opens — never on a poll. before/after snapshots render exactly as the
 * server serves them: secret-shaped values arrive already redacted.
 *
 * Demo mode serves the authored fixtures (the registered state, three admin
 * changes) and the reviewed write answers with a demo-labelled canned result
 * — the panel says so rather than implying a plane was written.
 *
 * The read halves (audit rows/section, the two GET helpers, the stamp and
 * note styles) live in ../mist/audit.tsx, shared with the Mist screen's
 * read-only ops sections — one place words what a failed or empty read
 * means. Only the WRITE (postMistRegistration, the reviewed form) is
 * Systems-only.
 */

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FormField,
  Input,
  SectionHeader,
  Spinner,
  useToast,
} from '../../nightdesk';
import { apiFetch, isApiError, type ApiResult } from '../../api/client';
import { MIST_WEBHOOK_TOPICS, countOf } from '@hpe/shared';
import type {
  MistAuditLogLive,
  MistWebhookRegistrationResult,
  MistWebhookRegistrationStatus,
} from '@hpe/shared';
import { AuditLogSection, getMistAuditLog, getMistRegistration, stampLabel } from '../mist/audit';
import { noteStyle } from '../mist/style';

async function postMistRegistration(form: {
  url: string;
  secret?: string;
  topics: string[];
}): Promise<ApiResult<MistWebhookRegistrationResult>> {
  try {
    const r = await apiFetch('/api/hooks/mist/registration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, reviewConfirmed: true }),
    });
    const body = (await r.json()) as MistWebhookRegistrationResult;
    // The service's result body is the honest answer even on a non-OK status
    // (a validation refusal is a 400 with the reason; an upstream failure is
    // a 502 with Mist's HTTP code) — surface it as-is.
    if (r.ok || typeof body.message === 'string') return body;
    return { error: `request failed — HTTP ${r.status}`, httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export function MistSection() {
  const { toast } = useToast();
  const [status, setStatus] = useState<MistWebhookRegistrationStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [audit, setAudit] = useState<MistAuditLogLive | null | undefined>(undefined);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<MistWebhookRegistrationResult | null>(null);

  const load = (): Promise<void> => {
    return Promise.all([getMistRegistration(), getMistAuditLog()]).then(([statusResult, auditResult]) => {
      if (isApiError(statusResult)) {
        setStatusError(statusResult.error);
      } else {
        setStatusError(null);
        setStatus(statusResult);
        // Prefill the form from the subscription already pointing here — an
        // edit, not a fresh registration. Never overwrite what the operator is
        // typing, so only an untouched field takes it.
        setUrl((cur) => (cur.trim() === '' ? (statusResult.subscriptions[0]?.url ?? cur) : cur));
      }
      if (isApiError(auditResult)) {
        setAuditError(auditResult.error);
      } else {
        setAuditError(null);
        setAudit(auditResult);
      }
    });
  };

  useEffect(() => {
    void load();
  }, []);

  /** Any form edit invalidates the review checkbox — the review always
   *  states "I reviewed THIS exact write", never a stale one. */
  const updateUrl = (v: string) => {
    setUrl(v);
    setReviewed(false);
  };
  const updateSecret = (v: string) => {
    setSecret(v);
    setReviewed(false);
  };

  const apply = async (): Promise<void> => {
    if (!reviewed || applying) return;
    setApplying(true);
    const applied = await postMistRegistration({
      url: url.trim(),
      topics: [...MIST_WEBHOOK_TOPICS],
      ...(secret.trim() !== '' ? { secret: secret.trim() } : {}),
    });
    setApplying(false);
    if (isApiError(applied)) {
      toast(`Registration failed: ${applied.error}`, { tone: 'danger' });
      return;
    }
    setResult(applied);
    // The secret is write-only: it leaves state the moment the write
    // settles, whatever the outcome.
    setSecret('');
    if (applied.ok) {
      toast(
        applied.demo === true
          ? 'Demo registration answered — no plane was written'
          : `Subscription ${applied.action} on the Mist org`,
        { tone: 'success' },
      );
      void load();
    }
  };

  const registered = status?.subscriptions[0] ?? null;
  const delivering = status?.lastReceivedAt ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SectionHeader
          label="Webhook receiver"
          meta={status?.demo === true ? 'DEMO FIXTURE' : registered ? 'REGISTERED' : 'NOT REGISTERED'}
        />
        {statusError !== null ? (
          <div style={noteStyle}>The registration status could not be read — {statusError}</div>
        ) : status === null ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
            <Spinner size="sm" />
          </div>
        ) : (
          <>
            {status.error ? (
              <div style={noteStyle}>{status.error}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {status.subscriptions.map((s) => (
                  <div
                    key={s.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}
                  >
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
            {status.linked || status.demo === true ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 6 }}>
                <FormField
                  label="Receiver URL"
                  help="the public URL Mist should POST to — must end with /api/hooks/mist"
                >
                  <Input
                    value={url}
                    onChange={(e) => updateUrl(e.target.value)}
                    placeholder="https://portal.example.com/api/hooks/mist"
                    mono
                  />
                </FormField>
                <FormField
                  label="Signing secret"
                  help="write-only — leave blank to keep the current one; setting it rotates on the org AND the receiver"
                >
                  <Input
                    type="password"
                    value={secret}
                    onChange={(e) => updateSecret(e.target.value)}
                    placeholder="leave blank to keep the existing secret"
                    autoComplete="new-password"
                    mono
                  />
                </FormField>
                <Checkbox
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                  label={`I reviewed this registration — it creates or updates a webhook subscription on the Mist org (${MIST_WEBHOOK_TOPICS.join(', ')})`}
                />
                {result !== null ? (
                  <Alert tone={result.ok ? 'success' : 'danger'} title={result.ok ? `Registration ${result.action}` : 'Registration failed'}>
                    {result.message}
                  </Alert>
                ) : null}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!reviewed || applying || url.trim() === ''}
                    onClick={() => void apply()}
                  >
                    {applying ? 'Registering…' : registered ? 'Update subscription' : 'Register receiver'}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => void load()}>
                    Verify
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      <AuditLogSection audit={audit} error={auditError} />
    </div>
  );
}
