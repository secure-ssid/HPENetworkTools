/**
 * web/src/screens/CentralWebhooksReceiver.test.tsx — the inbound receiver
 * section of the Central webhooks panel.
 *
 * The management-half api calls are mocked at the module boundary (they are
 * not what this file tests); the receiver calls go through the REAL apiFetch
 * against a stubbed global fetch, so the panel's own /api/hooks/* helpers are
 * exercised end to end. Covers: per-source receiver status with the URL to
 * register and the nothing-received-yet state, the recent events list with
 * demo labels, the honest empty/unavailable states, and the demo simulate
 * button (present only in demo mode; posts through and refreshes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CentralWebhooksPanel } from './CentralWebhooksPanel';
import { ToastProvider } from '../nightdesk';
import { getCentralWebhookHandoffStatus, getCentralWebhooks } from '../api/client';
import type {
  WebhookEventsEnvelope,
  WebhookListEnvelope,
  WebhookReceivedEvent,
  WebhookReceiverStatusEnvelope,
} from '@hpe/shared';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getCentralWebhooks: vi.fn(),
    getCentralWebhookHandoffStatus: vi.fn(),
  };
});

const mockList = vi.mocked(getCentralWebhooks);
const mockHandoffStatus = vi.mocked(getCentralWebhookHandoffStatus);

const LIST_ENVELOPE: WebhookListEnvelope = {
  items: [],
  totalCount: 0,
  count: 0,
  limit: 10,
  offset: 0,
  hasMore: false,
  source: 'demo fixture',
  note: 'Central reports no configured webhooks for this tenant.',
  gatewayBaseUrl: null,
  tenantBinding: null,
};

function statusEnvelope(overrides: Partial<WebhookReceiverStatusEnvelope> = {}): WebhookReceiverStatusEnvelope {
  return {
    demoMode: true,
    receivers: [
      { source: 'mist', label: 'Mist', path: '/api/hooks/mist', secret: 'demo', lastReceivedAt: null, receivedCount: 0 },
      {
        source: 'central',
        label: 'New Central',
        path: '/api/hooks/central',
        secret: 'operator',
        lastReceivedAt: null,
        receivedCount: 0,
      },
    ],
    ...overrides,
  };
}

const RECEIVED_EVENT: WebhookReceivedEvent = {
  id: 'evt-1',
  source: 'mist',
  receivedAt: '2026-08-01T12:00:00.000Z',
  eventType: 'alarms:rogue_ap',
  demo: true,
  sev: 'P2',
  title: 'Rogue Ap',
  detail: '',
  state: 'open',
  device: '5c5b35000042',
  siteId: 'campus-01',
  siteName: 'Campus-01 — Meridian HQ',
  eventAt: '2026-08-01T11:59:00.000Z',
};

function eventsEnvelope(overrides: Partial<WebhookEventsEnvelope> = {}): WebhookEventsEnvelope {
  return {
    events: [],
    note: 'nothing received yet — register the receiver URL as a webhook target with Mist or New Central',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) };
}

interface HooksFetchOpts {
  status?: WebhookReceiverStatusEnvelope;
  statusHttp?: number;
  events?: WebhookEventsEnvelope;
  simulate?: unknown;
  simulateHttp?: number;
}

/** Route the panel's /api/hooks/* calls by URL; anything else is a test bug. */
function stubHooksFetch(opts: HooksFetchOpts = {}) {
  const fn = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/hooks/receivers')) {
      const status = opts.statusHttp ?? 200;
      return jsonResponse(status === 200 ? (opts.status ?? statusEnvelope()) : { error: 'receiver status blew up' }, status);
    }
    if (url.startsWith('/api/hooks/events')) return jsonResponse(opts.events ?? eventsEnvelope());
    if (url.startsWith('/api/hooks/simulate')) {
      return jsonResponse(opts.simulate ?? { accepted: 1, demo: true }, opts.simulateHttp ?? 202);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <CentralWebhooksPanel />
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockList.mockResolvedValue(LIST_ENVELOPE);
  mockHandoffStatus.mockResolvedValue({ pending: false });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('receiver status', () => {
  it('shows each source with the URL to register, its secret state, and the nothing-received-yet state', async () => {
    stubHooksFetch();
    renderPanel();
    expect(await screen.findByText('Mist')).toBeTruthy();
    expect(screen.getByText('New Central')).toBeTruthy();
    // The exact URL an operator registers with the vendor.
    expect(screen.getByText(`${window.location.origin}/api/hooks/mist`)).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/api/hooks/central`)).toBeTruthy();
    // Secret state is honest: demo-labelled where the public demo secret
    // verifies, 'configured' where an operator secret does.
    expect(screen.getByText('demo secret')).toBeTruthy();
    expect(screen.getByText('configured')).toBeTruthy();
    // Nothing received yet is said, not implied by a blank cell.
    expect(screen.getAllByText('Nothing received yet')).toHaveLength(2);
  });

  it('renders an honest unavailable state when the status read fails — never a fabricated roster', async () => {
    stubHooksFetch({ statusHttp: 500 });
    renderPanel();
    expect(await screen.findByText('Receiver status unavailable')).toBeTruthy();
    expect(screen.getByText('receiver status blew up')).toBeTruthy();
    expect(screen.queryByText('/api/hooks/mist', { exact: false })).toBeNull();
  });
});

describe('received events', () => {
  it('lists recent events with source, severity, demo label and device', async () => {
    stubHooksFetch({ events: eventsEnvelope({ events: [RECEIVED_EVENT], note: undefined }) });
    renderPanel();
    expect(await screen.findByText('Rogue Ap')).toBeTruthy();
    expect(screen.getByText('P2')).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
    expect(screen.getByText('5c5b35000042')).toBeTruthy();
    expect(screen.queryByText('No events received yet')).toBeNull();
  });

  it('shows the server note when nothing has been received', async () => {
    stubHooksFetch();
    renderPanel();
    expect(await screen.findByText('No events received yet')).toBeTruthy();
    expect(screen.getByText(/nothing received yet — register the receiver URL/)).toBeTruthy();
  });
});

describe('the demo simulate path', () => {
  it('posts the fixture through the receiver and refreshes status and events', async () => {
    const fetchMock = stubHooksFetch();
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Simulate Mist event' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith('/api/hooks/simulate'))).toBe(true);
    });
    const simulateCall = fetchMock.mock.calls.find(([input]) => String(input).startsWith('/api/hooks/simulate'));
    expect(simulateCall).toBeDefined();
    const init = simulateCall?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ source: 'mist' });
    expect(await screen.findByText(/Demo mist event accepted/)).toBeTruthy();
    // Status + events were refetched after the accepted delivery.
    await waitFor(() => {
      const receiversCalls = fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/hooks/receivers'));
      expect(receiversCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('hides the simulate buttons when the server is not in demo mode', async () => {
    stubHooksFetch({ status: statusEnvelope({ demoMode: false }) });
    renderPanel();
    expect(await screen.findByText('Mist')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Simulate Mist event' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Simulate Central event' })).toBeNull();
  });

  it('reports a failed simulation instead of claiming a delivery', async () => {
    stubHooksFetch({ simulate: { error: 'the simulate path is only available in demo mode' }, simulateHttp: 403 });
    renderPanel();
    const button = await screen.findByRole('button', { name: 'Simulate Central event' });
    fireEvent.click(button);
    expect(await screen.findByText(/Demo event failed: the simulate path is only available in demo mode/)).toBeTruthy();
  });
});
