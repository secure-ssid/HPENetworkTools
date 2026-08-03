/**
 * web/src/screens/systems/NotificationsSection.test.tsx
 *
 * The assertions worth having here are the section's honesty rules:
 *   - demo mode must never read like delivery — the badge says nothing is
 *     sent and the outbox is labelled demo;
 *   - a failed delivery stays on the row with its error, not laundered into
 *     "quiet";
 *   - the write-only secret is kept by absence on edit, and cleared only by
 *     the explicit checkbox — an untouched password field must never mean
 *     deletion;
 *   - a test send surfaces the server's own message verbatim, failure or not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NotificationsSection } from './NotificationsSection';
import { ToastProvider } from '../../nightdesk';
import {
  addSslHost,
  createNotificationEndpoint,
  deleteNotificationEndpoint,
  getNotificationEndpoints,
  getNotificationOutbox,
  getNotificationStatus,
  getReportPreview,
  getReportSchedule,
  getSmtpConfig,
  getSslHosts,
  probeSslHost,
  putReportSchedule,
  putSmtpConfig,
  sendReportNow,
  testNotificationEndpoint,
  testSmtpConfig,
  updateNotificationEndpoint,
} from '../../api/notifications';
import type { FleetReport, NotificationEndpointView, NotificationServiceStatus, ReportConfig } from '@hpe/shared';

vi.mock('../../api/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/notifications')>();
  return {
    ...actual,
    getNotificationEndpoints: vi.fn(),
    getNotificationStatus: vi.fn(),
    getNotificationOutbox: vi.fn(),
    createNotificationEndpoint: vi.fn(),
    updateNotificationEndpoint: vi.fn(),
    deleteNotificationEndpoint: vi.fn(),
    testNotificationEndpoint: vi.fn(),
    getSmtpConfig: vi.fn(),
    putSmtpConfig: vi.fn(),
    deleteSmtpConfig: vi.fn(),
    testSmtpConfig: vi.fn(),
    getReportSchedule: vi.fn(),
    putReportSchedule: vi.fn(),
    sendReportNow: vi.fn(),
    getReportPreview: vi.fn(),
    getSslHosts: vi.fn(),
    addSslHost: vi.fn(),
    removeSslHost: vi.fn(),
    probeSslHost: vi.fn(),
  };
});

const FAILED: NotificationEndpointView = {
  id: 'ntf-1',
  name: 'noc-slack',
  url: 'https://hooks.slack.com/services/T00/B00/xxx',
  template: 'slack',
  enabled: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  hmacSecretConfigured: true,
  delivery: { lastAttemptAt: '2026-08-01T11:58:00.000Z', lastResult: 'failed', lastError: 'HTTP 503 — 3 attempts', httpCode: 503 },
};

const QUIET: NotificationEndpointView = {
  id: 'ntf-2',
  name: 'ntfy-ops',
  url: 'https://ntfy.example.com/ops',
  template: 'ntfy',
  enabled: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  hmacSecretConfigured: false,
};

const DEMO_STATUS: NotificationServiceStatus = {
  demoMode: true,
  sampling: { running: true, lastSampleAt: '2026-08-01T12:00:00.000Z', trackedGroups: 3 },
  endpoints: [],
};

const LIVE_STATUS: NotificationServiceStatus = {
  demoMode: false,
  sampling: { running: true, lastSampleAt: '2026-08-01T12:00:00.000Z', trackedGroups: 3 },
  endpoints: [],
};

function mount() {
  return render(
    <ToastProvider>
      <NotificationsSection />
    </ToastProvider>,
  );
}

const REPORT_DEFAULTS: ReportConfig = { enabled: false, frequency: 'daily', hour: 6, recipients: [] };

beforeEach(() => {
  // The email-channel cards load independently; give each a quiet default so
  // the webhook tests above never trip over an unstubbed call.
  vi.mocked(getSmtpConfig).mockResolvedValue({ smtp: null });
  vi.mocked(getReportSchedule).mockResolvedValue({ report: { config: REPORT_DEFAULTS, demoMode: false, entries: [] } });
  vi.mocked(getSslHosts).mockResolvedValue({ hosts: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('notifications section', () => {
  it('lists endpoints with their last-delivery outcome — failures stay visible', async () => {
    vi.mocked(getNotificationEndpoints).mockResolvedValue({ endpoints: [FAILED, QUIET] });
    vi.mocked(getNotificationStatus).mockResolvedValue({ status: LIVE_STATUS });
    mount();
    await waitFor(() => expect(screen.getByText('noc-slack')).toBeTruthy());
    expect(screen.getByText(/failed — HTTP 503 — 3 attempts/)).toBeTruthy();
    expect(screen.getByText('never attempted')).toBeTruthy();
    expect(screen.getByText('signed')).toBeTruthy();
    // Scoped: the report card below has its own 'disabled' schedule badge.
    const quietRow = screen.getByText('ntfy-ops').closest('div')!;
    expect(within(quietRow.parentElement!).getByText('disabled')).toBeTruthy();
    expect(screen.getByText('live — sends are real')).toBeTruthy();
  });

  it('demo mode says nothing is sent and shows the labelled outbox payload', async () => {
    vi.mocked(getNotificationEndpoints).mockResolvedValue({ endpoints: [QUIET] });
    vi.mocked(getNotificationStatus).mockResolvedValue({ status: DEMO_STATUS });
    vi.mocked(getNotificationOutbox).mockResolvedValue({
      outbox: {
        demoMode: true,
        entries: [
          {
            id: 'out-1',
            at: '2026-08-01T12:00:00.000Z',
            endpointId: 'ntf-2',
            endpointName: 'ntfy-ops',
            event: {
              id: 'evt-1',
              kind: 'fired',
              at: '2026-08-01T12:00:00.000Z',
              fingerprint: 'central|gw-edge-1|gateway down',
              plane: 'CENTRAL',
              device: 'gw-edge-1',
              title: 'Gateway down',
              sev: 'P1',
              state: 'open',
              siteName: 'Campus-01 HQ',
              age: '4m',
              count: 1,
            },
            contentType: 'text/plain; charset=utf-8',
            body: '[P1] FIRED: Gateway down — gw-edge-1 (CENTRAL · Campus-01 HQ)',
            demo: true,
          },
        ],
      },
    });
    mount();
    await waitFor(() => expect(screen.getByText('demo — nothing is sent')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/WOULD-HAVE-SENT/)).toBeTruthy());
    expect(screen.getByText(/\[P1\] FIRED: Gateway down/)).toBeTruthy();
    expect(screen.getByText('FIRED')).toBeTruthy();
  });

  it('creates an endpoint from the drawer without inventing a secret', async () => {
    vi.mocked(getNotificationEndpoints).mockResolvedValue({ endpoints: [] });
    vi.mocked(getNotificationStatus).mockResolvedValue({ status: LIVE_STATUS });
    vi.mocked(createNotificationEndpoint).mockResolvedValue({ endpoint: QUIET });
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add endpoint' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
    // The footer button and the drawer submit share the name — scope to the dialog.
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Endpoint name'), { target: { value: 'ntfy-ops' } });
    fireEvent.change(within(dialog).getByLabelText('Endpoint URL'), { target: { value: 'https://ntfy.example.com/ops' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add endpoint' }));
    await waitFor(() => expect(createNotificationEndpoint).toHaveBeenCalled());
    const payload = vi.mocked(createNotificationEndpoint).mock.calls[0]![0];
    expect(payload).toMatchObject({ name: 'ntfy-ops', url: 'https://ntfy.example.com/ops', template: 'generic', enabled: true });
    expect('hmacSecret' in payload).toBe(false);
  });

  it('edit keeps the stored secret by absence — and clears it only via the checkbox', async () => {
    vi.mocked(getNotificationEndpoints).mockResolvedValue({ endpoints: [FAILED] });
    vi.mocked(getNotificationStatus).mockResolvedValue({ status: LIVE_STATUS });
    vi.mocked(updateNotificationEndpoint).mockResolvedValue({ endpoint: FAILED });
    mount();
    await waitFor(() => expect(screen.getByText('noc-slack')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // The drawer says a secret is stored; the field starts blank.
    expect(screen.getByText(/A secret is stored\. Leave blank to keep it/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Endpoint name'), { target: { value: 'noc-slack-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }));
    await waitFor(() => expect(updateNotificationEndpoint).toHaveBeenCalled());
    const keepPayload = vi.mocked(updateNotificationEndpoint).mock.calls[0]![1];
    expect(keepPayload.name).toBe('noc-slack-2');
    expect('hmacSecret' in keepPayload).toBe(false);

    // Now the explicit clear: the only way an empty secret means deletion.
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByLabelText(/Clear the stored signing secret/));
    fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' }));
    await waitFor(() => expect(vi.mocked(updateNotificationEndpoint).mock.calls.length).toBe(2));
    expect(vi.mocked(updateNotificationEndpoint).mock.calls[1]![1].hmacSecret).toBeNull();
  });

  it('surfaces the server’s test-send message verbatim, failure included', async () => {
    vi.mocked(getNotificationEndpoints).mockResolvedValue({ endpoints: [FAILED] });
    vi.mocked(getNotificationStatus).mockResolvedValue({ status: LIVE_STATUS });
    vi.mocked(testNotificationEndpoint).mockResolvedValue({
      result: { ok: false, ms: 12, message: 'refused — endpoint may not target a private, loopback, or reserved network address' },
    });
    mount();
    await waitFor(() => expect(screen.getByText('noc-slack')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(screen.getByText('Test failed')).toBeTruthy());
    expect(screen.getByText(/refused — endpoint may not target a private/)).toBeTruthy();
  });

  it('a demo test-send is a warning, never a green delivery', async () => {
    vi.mocked(getNotificationEndpoints).mockResolvedValue({ endpoints: [QUIET] });
    vi.mocked(getNotificationStatus).mockResolvedValue({ status: DEMO_STATUS });
    vi.mocked(getNotificationOutbox).mockResolvedValue({ outbox: { demoMode: true, entries: [] } });
    vi.mocked(testNotificationEndpoint).mockResolvedValue({
      result: { ok: true, demo: true, ms: 0, message: 'Demo mode — nothing was sent. The would-have-sent payload is in the outbox below.' },
    });
    mount();
    await waitFor(() => expect(screen.getByText('ntfy-ops')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(screen.getByText(/nothing was sent/)).toBeTruthy());
    expect(screen.queryByText('Delivered — HTTP 200.')).toBeNull();
  });

  it('removes an endpoint after confirmation and re-reads the list', async () => {
    vi.mocked(getNotificationEndpoints)
      .mockResolvedValueOnce({ endpoints: [QUIET] })
      .mockResolvedValue({ endpoints: [] });
    vi.mocked(getNotificationStatus).mockResolvedValue({ status: LIVE_STATUS });
    vi.mocked(deleteNotificationEndpoint).mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    await waitFor(() => expect(screen.getByText('ntfy-ops')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleteNotificationEndpoint).toHaveBeenCalledWith('ntf-2'));
    await waitFor(() => expect(screen.getByText(/no endpoints yet/)).toBeTruthy());
  });
});

// ---------------------------------------------------------------------------
// Email channel cards — SMTP relay, fleet report, SSL watch
// ---------------------------------------------------------------------------

const SMTP_VIEW = {
  host: 'smtp.example.com',
  port: 587,
  user: 'svc-reports',
  from: 'reports@example.com',
  tls: true,
  updatedAt: '2026-08-01T00:00:00.000Z',
  passwordConfigured: true,
};

const SCHEDULE = {
  config: {
    enabled: true,
    frequency: 'weekly' as const,
    hour: 7,
    recipients: ['noc@example.com'],
    lastAttemptAt: '2026-08-01T07:00:00.000Z',
    lastSentAt: '2026-08-01T07:00:00.000Z',
    lastResult: 'sent' as const,
  },
  demoMode: false,
  entries: [],
};

const SSL_OK = {
  id: 'ssl-1',
  host: 'vpn.example.com',
  port: 443,
  addedAt: '2026-08-01T00:00:00.000Z',
  lastProbe: { at: '2026-08-01T11:00:00.000Z', ok: true, notAfter: '2026-09-14T00:00:00.000Z', daysLeft: 43 },
};

const SSL_FAIL = {
  id: 'ssl-2',
  host: 'dead.example.com',
  port: 443,
  addedAt: '2026-08-01T00:00:00.000Z',
  lastProbe: { at: '2026-08-01T11:00:00.000Z', ok: false, error: 'connect ECONNREFUSED 10.0.0.1:443' },
};

const PREVIEW: FleetReport = {
  subject: 'Fleet Summary Report — 2026-08-02',
  generatedAt: '2026-08-02T06:00:00.000Z',
  demo: true,
  totalDevices: 2,
  totalOnline: 1,
  totalOffline: 1,
  totals: [{ type: 'switch', total: 2, online: 1, offline: 1 }],
  offline: [{ name: 'sw-2', type: 'switch', state: 'down', siteName: 'Campus' }],
  offlineOverflow: 0,
  alerts24h: 1,
  alerts168h: 3,
  alerts24hBySeverity: { danger: 1 },
  expiring: [],
  expiringOverflow: 0,
  notes: [],
  text: 'Fleet Summary Report — 2026-08-02\n\nDEVICES\n  switch      2 total ·     1 online ·     1 offline',
  html: '<p>html</p>',
};

/** The row a text lives on — climb until the container holds its buttons. */
function rowOf(text: string): HTMLElement {
  let node: HTMLElement | null = screen.getByText(text);
  while (node && within(node).queryAllByRole('button').length === 0) node = node.parentElement;
  if (!node) throw new Error(`no row found for '${text}'`);
  return node;
}

function stubWebhooks(demoStatus: NotificationServiceStatus = LIVE_STATUS) {
  vi.mocked(getNotificationEndpoints).mockResolvedValue({ endpoints: [] });
  vi.mocked(getNotificationStatus).mockResolvedValue({ status: demoStatus });
}

describe('smtp card', () => {
  it('unconfigured says so honestly and configures via the drawer — no password invented', async () => {
    stubWebhooks();
    vi.mocked(putSmtpConfig).mockResolvedValue({ smtp: SMTP_VIEW });
    mount();
    await waitFor(() => expect(screen.getByText(/no relay configured/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Configure SMTP' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('SMTP host'), { target: { value: 'smtp.example.com' } });
    fireEvent.change(within(dialog).getByLabelText('From address'), { target: { value: 'reports@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save relay' }));
    await waitFor(() => expect(putSmtpConfig).toHaveBeenCalled());
    const payload = vi.mocked(putSmtpConfig).mock.calls[0]![0];
    expect(payload).toMatchObject({ host: 'smtp.example.com', port: 587, from: 'reports@example.com', tls: true });
    expect('password' in payload).toBe(false);
  });

  it('configured shows the relay with honest badges; edit keeps the password by absence', async () => {
    stubWebhooks();
    vi.mocked(getSmtpConfig).mockResolvedValue({ smtp: SMTP_VIEW });
    vi.mocked(putSmtpConfig).mockResolvedValue({ smtp: SMTP_VIEW });
    mount();
    await waitFor(() => expect(screen.getByText('smtp.example.com:587')).toBeTruthy());
    expect(screen.getByText('STARTTLS')).toBeTruthy();
    expect(screen.getByText('password set — write-only')).toBeTruthy();
    expect(screen.getByText('auth as svc-reports')).toBeTruthy();

    fireEvent.click(within(rowOf('smtp.example.com:587')).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog');
    // The drawer says a password is stored; the field starts blank.
    expect(within(dialog).getByText(/A password is stored\. Leave blank to keep it/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('SMTP host'), { target: { value: 'smtp2.example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save relay' }));
    await waitFor(() => expect(putSmtpConfig).toHaveBeenCalled());
    expect('password' in vi.mocked(putSmtpConfig).mock.calls[0]![0]).toBe(false);
  });

  it('edit clears the password only via the explicit checkbox', async () => {
    stubWebhooks();
    vi.mocked(getSmtpConfig).mockResolvedValue({ smtp: SMTP_VIEW });
    vi.mocked(putSmtpConfig).mockResolvedValue({ smtp: { ...SMTP_VIEW, passwordConfigured: false } });
    mount();
    await waitFor(() => expect(screen.getByText('smtp.example.com:587')).toBeTruthy());
    fireEvent.click(within(rowOf('smtp.example.com:587')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByLabelText(/Clear the stored password/));
    fireEvent.click(screen.getByRole('button', { name: 'Save relay' }));
    await waitFor(() => expect(putSmtpConfig).toHaveBeenCalled());
    expect(vi.mocked(putSmtpConfig).mock.calls[0]![0].password).toBeNull();
  });

  it('the test send surfaces the server’s own message verbatim', async () => {
    stubWebhooks();
    vi.mocked(getSmtpConfig).mockResolvedValue({ smtp: SMTP_VIEW });
    vi.mocked(testSmtpConfig).mockResolvedValue({
      result: { ok: false, ms: 12, message: 'AUTH LOGIN refused — 535 authentication failed' },
    });
    mount();
    await waitFor(() => expect(screen.getByText('smtp.example.com:587')).toBeTruthy());
    fireEvent.click(within(rowOf('smtp.example.com:587')).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(screen.getByText('Test failed')).toBeTruthy());
    expect(screen.getByText(/535 authentication failed/)).toBeTruthy();
  });
});

describe('report card', () => {
  it('shows the schedule and its last outcome, and Send now surfaces the result', async () => {
    stubWebhooks();
    vi.mocked(getReportSchedule).mockResolvedValue({ report: SCHEDULE });
    vi.mocked(sendReportNow).mockResolvedValue({ result: { ok: true, emailed: true, ms: 40, message: 'Emailed to noc@example.com — smtp.example.com:587 accepted it.' } });
    mount();
    await waitFor(() => expect(screen.getByText(/weekly at 07:00 UTC/)).toBeTruthy());
    expect(screen.getByText(/noc@example\.com/)).toBeTruthy();
    expect(screen.getByText(/sent · Aug 1/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Send now' }));
    await waitFor(() => expect(sendReportNow).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Emailed to noc@example\.com/)).toBeTruthy());
  });

  it('the schedule drawer parses recipients and saves the patch', async () => {
    stubWebhooks();
    vi.mocked(getReportSchedule).mockResolvedValue({ report: SCHEDULE });
    vi.mocked(putReportSchedule).mockResolvedValue({ config: SCHEDULE.config });
    mount();
    await waitFor(() => expect(screen.getByText(/weekly at 07:00 UTC/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Edit schedule' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Report frequency' }), { target: { value: 'daily' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Report hour' }), { target: { value: '9' } });
    fireEvent.change(within(dialog).getByLabelText('Report recipients'), { target: { value: 'noc@example.com, netops@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(putReportSchedule).toHaveBeenCalled());
    expect(vi.mocked(putReportSchedule).mock.calls[0]![0]).toEqual({
      enabled: true,
      frequency: 'daily',
      hour: 9,
      recipients: ['noc@example.com', 'netops@example.com'],
    });
  });

  it('the preview renders the exact would-be-sent report, demo-labelled', async () => {
    stubWebhooks();
    vi.mocked(getReportSchedule).mockResolvedValue({ report: SCHEDULE });
    vi.mocked(getReportPreview).mockResolvedValue({ report: PREVIEW });
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByText('Fleet Summary Report — 2026-08-02')).toBeTruthy());
    expect(screen.getByText('demo data')).toBeTruthy();
    expect(screen.getByText(/DEVICES/)).toBeTruthy();
    // The toggle hides it again.
    fireEvent.click(screen.getByRole('button', { name: 'Hide preview' }));
    await waitFor(() => expect(screen.queryByText('demo data')).toBeNull());
  });

  it('demo schedule lists the would-have-sent outbox entries', async () => {
    stubWebhooks();
    vi.mocked(getReportSchedule).mockResolvedValue({
      report: {
        config: { ...SCHEDULE.config, lastResult: 'demo' },
        demoMode: true,
        entries: [
          {
            id: 'rpt-1',
            at: '2026-08-01T07:00:00.000Z',
            subject: 'Fleet Summary Report — 2026-08-01',
            recipients: ['noc@example.com'],
            text: 'text',
            html: '<p>html</p>',
            demo: true as const,
          },
        ],
      },
    });
    mount();
    await waitFor(() => expect(screen.getByText('Fleet Summary Report — 2026-08-01')).toBeTruthy());
    expect(screen.getByText(/nothing left the process/)).toBeTruthy();
  });
});

describe('ssl watch card', () => {
  it('lists hosts with their probe outcomes — failures stay visible', async () => {
    stubWebhooks();
    vi.mocked(getSslHosts).mockResolvedValue({ hosts: [SSL_OK, SSL_FAIL] });
    mount();
    await waitFor(() => expect(screen.getByText('vpn.example.com:443')).toBeTruthy());
    expect(screen.getByText(/expires in 43d/)).toBeTruthy();
    expect(screen.getByText(/probe failed — connect ECONNREFUSED/)).toBeTruthy();
  });

  it('adds a host from the input and re-reads the list', async () => {
    stubWebhooks();
    vi.mocked(getSslHosts).mockResolvedValue({ hosts: [] });
    vi.mocked(addSslHost).mockResolvedValue({ host: SSL_OK });
    mount();
    await waitFor(() => expect(screen.getByText(/no hosts watched/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText('SSL host to watch'), { target: { value: 'vpn.example.com:8443' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
    await waitFor(() => expect(addSslHost).toHaveBeenCalledWith('vpn.example.com:8443'));
  });

  it('probe-now in demo answers honestly instead of dialling', async () => {
    stubWebhooks(DEMO_STATUS);
    vi.mocked(getNotificationOutbox).mockResolvedValue({ outbox: { demoMode: true, entries: [] } });
    vi.mocked(getSslHosts).mockResolvedValue({ hosts: [SSL_OK] });
    vi.mocked(probeSslHost).mockResolvedValue({
      result: { demo: true, message: 'Demo mode — probes never dial. The demo certificate walks the ladder instead.' },
    });
    mount();
    await waitFor(() => expect(screen.getByText('vpn.example.com:443')).toBeTruthy());
    expect(screen.getByText(/demo — probes never dial/)).toBeTruthy();
    fireEvent.click(within(rowOf('vpn.example.com:443')).getByRole('button', { name: 'Probe now' }));
    await waitFor(() => expect(screen.getByText('Probe skipped')).toBeTruthy());
    expect(screen.getByText(/The demo certificate walks the ladder instead/)).toBeTruthy();
  });
});
