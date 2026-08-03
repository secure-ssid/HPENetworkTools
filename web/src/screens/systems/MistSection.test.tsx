/**
 * web/src/screens/systems/MistSection.test.tsx — the Systems drawer's Mist
 * sections: the webhook receiver auto-registration (status, reviewed write,
 * verify) and the org audit log.
 *
 * The panel's api calls go through the REAL apiFetch against a stubbed
 * global fetch routed by URL (the CentralWebhooksReceiver.test.tsx pattern),
 * so its /api/hooks/mist/registration + /api/systems/mist/audit-log helpers
 * are exercised end to end. Covers: the registered-and-delivering status
 * split, the review gate (the apply stays disabled until reviewed), the
 * write-only secret (posted, then dropped from the form), the demo-labelled
 * result, and the audit log's honest states.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MistSection } from './MistSection';
import { ToastProvider } from '../../nightdesk';
import { MIST_AUDIT_LOG } from '@hpe/shared';
import type {
  MistAuditLogLive,
  MistWebhookRegistrationResult,
  MistWebhookRegistrationStatus,
} from '@hpe/shared';

const REGISTERED: MistWebhookRegistrationStatus = {
  demoMode: false,
  linked: true,
  receiverPath: '/api/hooks/mist',
  subscriptions: [
    {
      id: 'wh-1',
      name: 'hpe-network-tools receiver',
      url: 'https://portal.meridian-health.example/api/hooks/mist',
      topics: ['alarms', 'client-sessions', 'device-updowns'],
      enabled: true,
      secretConfigured: true,
    },
  ],
  totalSubscriptions: 2,
  lastReceivedAt: '2026-08-01T11:42:00.000Z',
};

const AUDIT: MistAuditLogLive = {
  entries: MIST_AUDIT_LOG,
  source: { plane: 'mist', at: '2026-07-26T11:59:00.000Z', sections: { logs: 'ok' } },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) };
}

interface MistFetchOpts {
  status?: MistWebhookRegistrationStatus;
  statusHttp?: number;
  audit?: MistAuditLogLive | null;
  auditHttp?: number;
  register?: MistWebhookRegistrationResult;
  registerHttp?: number;
}

/** Route the panel's calls by URL; anything else is a test bug. */
function stubMistFetch(opts: MistFetchOpts = {}) {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/hooks/mist/registration')) {
      if (_init?.method === 'POST') {
        return jsonResponse(
          opts.register ?? { ok: true, action: 'updated', verified: true, message: 'subscription updated and confirmed by re-read' },
          opts.registerHttp ?? 200,
        );
      }
      const status = opts.statusHttp ?? 200;
      return jsonResponse(status === 200 ? (opts.status ?? REGISTERED) : { error: 'registration status blew up' }, status);
    }
    if (url.startsWith('/api/systems/mist/audit-log')) {
      const status = opts.auditHttp ?? 200;
      return jsonResponse(status === 200 ? { auditLog: opts.audit === undefined ? AUDIT : opts.audit } : { error: 'audit log blew up' }, status);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPanel() {
  return render(
    <ToastProvider>
      <MistSection />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MistSection — registration status', () => {
  it('shows the registered subscription with its URL, and last-received separately from registered', async () => {
    stubMistFetch();
    renderPanel();
    expect(await screen.findByText(/portal.meridian-health.example\/api\/hooks\/mist/)).toBeTruthy();
    expect(screen.getByText('enabled')).toBeTruthy();
    expect(screen.getByText(/signed/)).toBeTruthy();
    expect(screen.getByText(/last delivery accepted/)).toBeTruthy();
    // "Update" not "Register" — the URL prefilled from the subscription.
    expect(screen.getByRole('button', { name: 'Update subscription' })).toBeTruthy();
  });

  it('says registered-is-not-delivering when nothing has arrived, and offers Register', async () => {
    stubMistFetch({ status: { ...REGISTERED, subscriptions: [], lastReceivedAt: null, note: 'the org has no webhook subscriptions yet' } });
    renderPanel();
    expect(await screen.findByText('the org has no webhook subscriptions yet')).toBeTruthy();
    expect(screen.getByText(/no delivery accepted yet — registered is not delivering/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Register receiver' })).toBeTruthy();
  });

  it('an unreadable status is an honest error, never a fabricated roster', async () => {
    stubMistFetch({ statusHttp: 500 });
    renderPanel();
    expect(await screen.findByText(/registration status blew up/)).toBeTruthy();
  });
});

describe('MistSection — the reviewed write', () => {
  it('keeps the apply disabled until reviewed, then posts reviewConfirmed and the write-only secret', async () => {
    const fetchMock = stubMistFetch();
    renderPanel();
    const apply = await screen.findByRole('button', { name: 'Update subscription' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    // A secret entered but NOT reviewed — still disabled.
    fireEvent.change(screen.getByPlaceholderText('leave blank to keep the existing secret'), {
      target: { value: 'brand-new-signing-secret' },
    });
    expect((apply as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox'));
    expect((apply as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(apply);

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input, init]) => String(input).includes('/api/hooks/mist/registration') && init?.method === 'POST')).toBe(true);
    });
    const post = fetchMock.mock.calls.find(([input, init]) => String(input).includes('/api/hooks/mist/registration') && init?.method === 'POST');
    const body = JSON.parse(String(post?.[1]?.body));
    expect(body.reviewConfirmed).toBe(true);
    expect(body.secret).toBe('brand-new-signing-secret');
    expect(body.topics).toEqual(['alarms', 'client-sessions', 'device-updowns']);
    // The result lands as the panel's own message, and the secret leaves the form.
    expect(await screen.findByText(/subscription updated and confirmed by re-read/)).toBeTruthy();
    expect((screen.getByPlaceholderText('leave blank to keep the existing secret') as HTMLInputElement).value).toBe('');
  });

  it('a demo result is labelled demo, not implied to be a real write', async () => {
    stubMistFetch({
      register: { ok: true, action: 'created', demo: true, verified: true, message: 'demo mode — the reviewed registration is answered as authored; no subscription was written to a plane' },
    });
    renderPanel();
    fireEvent.change(await screen.findByPlaceholderText(/portal.example.com/), {
      target: { value: 'https://portal.meridian-health.example/api/hooks/mist' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Update subscription' }));
    expect(await screen.findByText(/no subscription was written to a plane/)).toBeTruthy();
    expect(await screen.findByText(/Demo registration answered/)).toBeTruthy();
  });
});

describe('MistSection — org audit log', () => {
  it('lists the admin changes with admin and site, redaction markers intact', async () => {
    stubMistFetch();
    renderPanel();
    expect(await screen.findByText(/Updated WLAN 'MRDN-Research'/)).toBeTruthy();
    expect(screen.getByText(/n.osei@meridian-health.example/)).toBeTruthy();
    expect(screen.getAllByText(/<redacted by the portal>/).length).toBeGreaterThan(0);
    expect(screen.getByText(/org-wide/)).toBeTruthy();
  });

  it('an honest empty when Mist reports no admin changes', async () => {
    stubMistFetch({ audit: { entries: [], source: { plane: 'mist', at: '2026-07-26T11:59:00.000Z', sections: { logs: 'empty' } } } });
    renderPanel();
    expect(await screen.findByText('Mist reported no admin changes for this org.')).toBeTruthy();
  });

  it('no linked plane is a straight sentence, and a failed read says it broke', async () => {
    stubMistFetch({ audit: null });
    renderPanel();
    expect(await screen.findByText(/No linked Mist plane can read the org audit log/)).toBeTruthy();

    cleanup();
    stubMistFetch({ audit: { source: { plane: 'mist', at: '2026-08-01T12:00:00.000Z', sections: { logs: 'failed' }, note: 'audit log: HTTP 500' } } });
    renderPanel();
    expect(await screen.findByText(/The audit-log read failed — audit log: HTTP 500/)).toBeTruthy();
  });
});
