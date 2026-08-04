/**
 * Rogue & neighbor AP section tests: the on-your-wire rogue leads under a
 * danger Alert (that is the alarm), rows sort on-LAN first then by signal,
 * and every no-data outcome is an honest sentence — 'not reported' for an
 * absent payload, a real "nothing heard" when Mist watched, and a null
 * seen_on_lan rendered as 'not reported', never an assumed safe.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { SiteRogueAps, siteRoguesExportPath } from './RogueAps';
import { MIST_ROGUE_APS } from '@hpe/shared';
import type { MistRogueApRow } from '@hpe/shared';
import { ToastProvider } from '../../nightdesk';
import { exportTableCsv } from '../../lib/csv';
import { downloadApiCsv } from '../../lib/downloadApiCsv';

vi.mock('../../lib/csv', () => ({
  exportTableCsv: vi.fn(() => 2),
}));

vi.mock('../../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(async () => ({ ok: true })),
}));

const mockExportTableCsv = vi.mocked(exportTableCsv);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

const CAM02 = MIST_ROGUE_APS.filter((r) => r.siteId === 'campus-02');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderRogues(ui: ReactElement) {
  return render(
    <MemoryRouter>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>,
  );
}

describe('SiteRogueAps', () => {
  it('leads with the on-your-wire rogue: the danger Alert names it and its row carries the alarm badge', () => {
    renderRogues(<SiteRogueAps rogues={CAM02} mistClaimed />);
    expect(screen.getByText(/1 rogue BSSID on your wire/)).toBeTruthy();
    expect(screen.getByText('FREE-CLINIC-WIFI')).toBeTruthy();
    expect(screen.getByText('ON YOUR WIRE')).toBeTruthy();
    // Both 3F APs heard the on-wire rogue AND the evil twin — two rows say it.
    expect(screen.getAllByText(/heard by 2 APs/)).toHaveLength(2);
  });

  it('sorts on-LAN first, then strongest signal first — and a hidden SSID says so', () => {
    const rows: MistRogueApRow[] = [
      { siteId: 'campus-02', siteName: 'Campus-02 Research', bssid: 'aa:00', ssid: 'weak', channel: 1, avgRssi: -90, numAps: 1, seenOnLan: false },
      { siteId: 'campus-02', siteName: 'Campus-02 Research', bssid: 'bb:00', ssid: 'strong', channel: 6, avgRssi: -50, numAps: 1, seenOnLan: false },
      { siteId: 'campus-02', siteName: 'Campus-02 Research', bssid: 'cc:00', ssid: 'wire', channel: 11, avgRssi: -80, numAps: 1, seenOnLan: true },
      { siteId: 'campus-02', siteName: 'Campus-02 Research', bssid: 'dd:00', ssid: null, channel: 36, avgRssi: null, numAps: null, seenOnLan: null },
    ];
    const { container } = renderRogues(<SiteRogueAps rogues={rows} mistClaimed />);
    const ssids = [...container.querySelectorAll('span')].map((s) => s.textContent);
    const wireIdx = ssids.indexOf('wire');
    const strongIdx = ssids.indexOf('strong');
    const weakIdx = ssids.indexOf('weak');
    const hiddenIdx = ssids.indexOf('SSID not broadcast');
    expect(wireIdx).toBeGreaterThanOrEqual(0);
    expect(strongIdx).toBeGreaterThan(wireIdx);
    expect(weakIdx).toBeGreaterThan(strongIdx);
    // The unreported row settles last and says 'not reported' — no readings invented.
    expect(hiddenIdx).toBeGreaterThan(weakIdx);
    expect(screen.getByText('not reported')).toBeTruthy();
  });

  it('a Mist site that heard nothing says so — a real answer, not a failed read', () => {
    renderRogues(<SiteRogueAps rogues={[]} mistClaimed />);
    expect(screen.getByText(/Mist reported no rogue or neighbor BSSIDs at this site this cycle/)).toBeTruthy();
    expect(screen.queryByText(/ON YOUR WIRE/)).toBeNull();
  });

  it('a site with no Mist badge gets the no-plane sentence, not an all-clear', () => {
    renderRogues(<SiteRogueAps rogues={[]} mistClaimed={false} />);
    expect(screen.getByText('No linked plane publishes rogue detection for this site.')).toBeTruthy();
  });

  it('an absent payload is not reported, never a fabricated all-clear', () => {
    renderRogues(<SiteRogueAps rogues={undefined} mistClaimed />);
    expect(screen.getByText('The portal did not say whether this site reports rogue detection.')).toBeTruthy();
  });

  it('offers Export CSV of the sorted site rogue rows (no secrets)', () => {
    renderRogues(<SiteRogueAps rogues={CAM02} mistClaimed />);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mockExportTableCsv).toHaveBeenCalledWith(
      'site-rogues.csv',
      ['site', 'bssid', 'ssid', 'channel', 'avgRssi', 'numAps', 'seenOnLan'],
      expect.any(Array),
    );
    const rows = mockExportTableCsv.mock.calls[0]![2] as unknown[][];
    expect(rows.length).toBe(CAM02.length);
    // on-your-wire first in the export (same sort as the section)
    expect(rows[0]).toEqual(expect.arrayContaining(['yes']));
    expect(screen.getByText(/exported \d+ rogues?/i)).toBeTruthy();
  });

  it('hides Export CSV when nothing was heard', () => {
    renderRogues(<SiteRogueAps rogues={[]} mistClaimed />);
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('live Download server CSV hits site rogues export (Loop 104)', async () => {
    renderRogues(
      <SiteRogueAps rogues={CAM02} mistClaimed siteKey="campus-02" live />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    expect(mockDownloadApiCsv).toHaveBeenCalledWith(
      siteRoguesExportPath('campus-02'),
      'site-rogues-campus-02.csv',
    );
    expect(siteRoguesExportPath('campus-02')).toBe('/api/sites/campus-02/rogues/export');
  });

  it('hides Download server CSV on demo (no live flag)', () => {
    renderRogues(<SiteRogueAps rogues={CAM02} mistClaimed siteKey="campus-02" />);
    expect(screen.queryByRole('button', { name: 'Download server CSV' })).toBeNull();
  });

  it('Copy section link shares section=rogues (Loop 71)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderRogues(<SiteRogueAps rogues={CAM02} mistClaimed />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy section link' }));
    expect(writeText).toHaveBeenCalled();
    expect(String(writeText.mock.calls[0]![0])).toMatch(/\?section=rogues#rogues/);
  });

  it('Copy section link remains available when the section is empty', () => {
    renderRogues(<SiteRogueAps rogues={[]} mistClaimed />);
    expect(screen.getByRole('button', { name: 'Copy section link' })).toBeTruthy();
  });
});

/* Loop 193 — site rogue multi-select bulk bar. */
describe('SiteRogueAps bulk (Loop 193)', () => {
  it('shows bulk bar: Export selected, Copy BSSIDs, Copy selection link, Clear', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mockExportTableCsv.mockReturnValue(1);

    renderRogues(<SiteRogueAps rogues={CAM02} mistClaimed />);
    expect(screen.queryByRole('region', { name: 'Site rogue selection actions' })).toBeNull();

    const table = screen.getByRole('grid', { name: 'Site rogue and neighbor APs' });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Site rogue selection actions' });
    expect(bar.textContent ?? '').toMatch(/1 SELECTED/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(mockExportTableCsv).toHaveBeenCalledWith(
      'site-rogues-selected.csv',
      expect.any(Array),
      expect.any(Array),
    );
    expect(await screen.findByText(/Exported 1 selected rogue/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy BSSIDs' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/:/);

    writeText.mockClear();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(decodeURIComponent(String(writeText.mock.calls[0]![0]))).toMatch(/bssids=/);
    expect(decodeURIComponent(String(writeText.mock.calls[0]![0]))).toMatch(/section=rogues/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Site rogue selection actions' })).toBeNull(),
    );
  });

  it('deep-links ?bssids= and shows a clearable selection chip', async () => {
    const target = CAM02[0]!.bssid;
    render(
      <MemoryRouter initialEntries={[`/sites/campus-02?bssids=${encodeURIComponent(target)}`]}>
        <ToastProvider>
          <SiteRogueAps rogues={CAM02} mistClaimed />
        </ToastProvider>
      </MemoryRouter>,
    );
    const chip = await screen.findByRole('button', { name: /1 selected BSSID/i });
    expect(chip.textContent ?? '').toMatch(/clear/);
    expect(screen.getByText(CAM02[0]!.ssid ?? '')).toBeTruthy();
    // Other SSIDs from the site should be filtered out when present.
    const other = CAM02.find((r) => r.bssid !== target && r.ssid);
    if (other?.ssid) {
      expect(screen.queryByText(other.ssid)).toBeNull();
    }
    fireEvent.click(chip);
    await waitFor(() => {
      if (other?.ssid) expect(screen.getByText(other.ssid)).toBeTruthy();
    });
  });
});
