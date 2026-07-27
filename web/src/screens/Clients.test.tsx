import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Clients from './Clients';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getClients, getSettings, getTickets } from '../api/client';
import type { ClientRow } from '../../../shared';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getClients: vi.fn(),
    getSettings: vi.fn(),
    getTickets: vi.fn(),
    blockClient: vi.fn(),
    disconnectClient: vi.fn(),
  };
});

const mockGetClients = vi.mocked(getClients);
const mockGetSettings = vi.mocked(getSettings);
const mockGetTickets = vi.mocked(getTickets);

const SPARSE_LIVE_CLIENT: ClientRow = {
  name: '3c:a9:ab:7c:a9:51',
  model: 'unknown',
  type: 'unknown',
  mac: '3c:a9:ab:7c:a9:51',
  ip: '192.168.1.89',
  medium: 'wireless',
  siteId: 'multiple',
  siteName: 'SecureSSID',
  group: '—',
  attach: 'LR655',
  where: 'aruba-home',
  plane: 'CENTRAL',
  planeTone: 'accent',
  auth: '—',
  authBy: '—',
  role: '—',
  vlan: '200',
  health: 'good',
  healthTone: 'success',
  session: '99h 59m',
  problem: false,
  link: '—',
  rssi: '—',
  snr: '—',
  retries: '—',
  tput: '—',
  roams: '—',
  quality: null,
  zone: '—',
  closet: '—',
};

beforeEach(() => {
  mockGetSettings.mockResolvedValue({
    density: 'compact',
    inventoryView: 'Unified table',
    showPlatformTags: true,
    workspaceName: 'SecureSSID',
    pollIntervalSec: 60,
  });
  mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'live' });
  mockGetClients.mockResolvedValue({
    stats: [],
    clients: [SPARSE_LIVE_CLIENT],
    dataSource: 'live',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Clients live sparse detail', () => {
  it('shows unavailable metrics honestly instead of a zero failure score or demo derivations', async () => {
    render(
      <MemoryRouter initialEntries={['/clients?mac=3c%3Aa9%3Aab%3A7c%3Aa9%3A51']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('PARTIAL PLANE METRICS')).toBeTruthy());
    expect(screen.getByText('NOT REPORTED')).toBeTruthy();
    expect(screen.getByText(/CENTRAL reports health as “good” but did not provide a numeric experience score/)).toBeTruthy();
    expect(screen.queryByText('0 / 100')).toBeNull();
    expect(screen.queryByText(/effectively unusable/)).toBeNull();
    expect(screen.getByText('VLAN 200')).toBeTruthy();
    expect(screen.getByText('Not reported by the client plane')).toBeTruthy();
    expect(screen.getByText(/will not substitute the demo topology/)).toBeTruthy();
    expect(screen.getByText(/will not substitute the demo timeline/)).toBeTruthy();
  });

  it('counts only the sessions the poller returned — no fixture estate total', async () => {
    render(
      <MemoryRouter initialEntries={['/clients']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1 of 1 sampled')).toBeTruthy());
    expect(screen.queryByText(/4,982 live sessions/)).toBeNull();
  });

  it('marks a session whose source plane is behind as unverified, not as health', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{ ...SPARSE_LIVE_CLIENT, health: 'unverified', healthTone: 'neutral' }],
      syncedAt: '2026-07-26T09:05:00',
      dataSource: 'live',
    });
    render(
      <MemoryRouter initialEntries={['/clients?mac=3c%3Aa9%3Aab%3A7c%3Aa9%3A51']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    // Row-level marker, count line, and the drawer all name the behind plane.
    await waitFor(() => expect(screen.getByText('CENTRAL behind')).toBeTruthy());
    expect(screen.getByText('1 of 1 sampled · 1 unverified')).toBeTruthy();
    expect(screen.getByText(/CENTRAL is behind, so this session was not re-confirmed/)).toBeTruthy();
    // …and the freshness stamp says when the rows were pulled.
    expect(screen.getByText('SYNCED 09:05')).toBeTruthy();
  });

  it('prints one VLAN label for a demo row that already carries the prefix', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{ ...SPARSE_LIVE_CLIENT, vlan: 'vlan 820' }],
      dataSource: 'demo',
    });
    render(
      <MemoryRouter initialEntries={['/clients?mac=3c%3Aa9%3Aab%3A7c%3Aa9%3A51']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('VLAN 820')).toBeTruthy());
    expect(screen.queryByText('VLAN vlan 820')).toBeNull();
  });

  it('keeps the authored estate total for a demo-sourced section', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [SPARSE_LIVE_CLIENT],
      dataSource: 'demo',
    });
    render(
      <MemoryRouter initialEntries={['/clients']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1 of 1 sampled · 4,982 live sessions')).toBeTruthy());
  });
});
