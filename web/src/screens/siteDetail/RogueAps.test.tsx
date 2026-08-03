/**
 * Rogue & neighbor AP section tests: the on-your-wire rogue leads under a
 * danger Alert (that is the alarm), rows sort on-LAN first then by signal,
 * and every no-data outcome is an honest sentence — 'not reported' for an
 * absent payload, a real "nothing heard" when Mist watched, and a null
 * seen_on_lan rendered as 'not reported', never an assumed safe.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SiteRogueAps } from './RogueAps';
import { MIST_ROGUE_APS } from '@hpe/shared';
import type { MistRogueApRow } from '@hpe/shared';

const CAM02 = MIST_ROGUE_APS.filter((r) => r.siteId === 'campus-02');

afterEach(cleanup);

describe('SiteRogueAps', () => {
  it('leads with the on-your-wire rogue: the danger Alert names it and its row carries the alarm badge', () => {
    render(<SiteRogueAps rogues={CAM02} mistClaimed />);
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
    const { container } = render(<SiteRogueAps rogues={rows} mistClaimed />);
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
    render(<SiteRogueAps rogues={[]} mistClaimed />);
    expect(screen.getByText(/Mist reported no rogue or neighbor BSSIDs at this site this cycle/)).toBeTruthy();
    expect(screen.queryByText(/ON YOUR WIRE/)).toBeNull();
  });

  it('a site with no Mist badge gets the no-plane sentence, not an all-clear', () => {
    render(<SiteRogueAps rogues={[]} mistClaimed={false} />);
    expect(screen.getByText('No linked plane publishes rogue detection for this site.')).toBeTruthy();
  });

  it('an absent payload is not reported, never a fabricated all-clear', () => {
    render(<SiteRogueAps rogues={undefined} mistClaimed />);
    expect(screen.getByText('The portal did not say whether this site reports rogue detection.')).toBeTruthy();
  });
});
