/**
 * Site health must count a device the plane reported offline.
 *
 * UXI words an offline sensor 'offline'; central/mist/aos8 normalize to
 * 'down'. The health bar used to test for the literal pair, so a reported
 * offline sensor fell out of the percentage entirely — not counted against
 * health, and not counted at all. The error ran in the one direction that
 * matters: it made the badge greener.
 */
import { describe, expect, it } from 'vitest';
import type { SiteId } from '@hpe/shared';
import { isAssertableState, isOfflineState } from '@hpe/shared';
import { mergeLiveSites } from '../src/routes/screens/liveCore';
import type { ReconciledDeviceRow } from '../src/services/reconcile';

describe('isAssertableState', () => {
  it('accepts both words the planes use for a device that is down', () => {
    expect(isAssertableState('down')).toBe(true);
    expect(isAssertableState('offline')).toBe(true);
    // The equivalence the fleet report already relied on.
    expect(isOfflineState('offline')).toBe(true);
  });

  it('accepts a device reported up', () => {
    expect(isAssertableState('up')).toBe(true);
  });

  it('refuses the two words that mean the state was never read', () => {
    // central/uxi when the plane published no status.
    expect(isAssertableState('unknown')).toBe(false);
    // reconcile, when every claiming plane is stale.
    expect(isAssertableState('unverified')).toBe(false);
  });

  it('refuses a word no adapter normalized rather than guessing at it', () => {
    expect(isAssertableState('degraded')).toBe(false);
    expect(isAssertableState('')).toBe(false);
  });
});

/**
 * The health bar as mergeLiveSites actually computes it. Driven through the
 * real function rather than a copy of its arithmetic, so a change that stops
 * consulting the shared vocabulary fails here.
 */
function device(name: string, state: string): ReconciledDeviceRow {
  return {
    name,
    model: 'UXI sensor',
    type: 'sensor',
    siteId: 'campus-01' as SiteId,
    siteName: 'Campus-01 HQ',
    plane: 'UXI',
    planeTone: 'info',
    state,
    stateTone: state === 'up' ? 'success' : state === 'unverified' ? 'neutral' : 'danger',
    firmware: 'unknown',
    firmwareApproved: true,
    licence: 'unknown',
    reconciliationIssue: false,
    localShell: false,
  };
}

function siteRow(states: string[]) {
  const devices = states.map((st, i) => device(`uxi-${i}`, st));
  const [site] = mergeLiveSites([], devices, [], []);
  return site;
}

function siteHealth(states: string[]): string | null {
  return siteRow(states).health;
}

describe('mergeLiveSites health over the live state vocabulary', () => {
  it('counts an offline UXI sensor against the site, not out of it', () => {
    // Three up, one reported offline. Testing for the literal pair 'up'/'down'
    // dropped the offline sensor and reported a perfect site.
    expect(siteHealth(['up', 'up', 'up', 'offline'])).toBe('75%');
  });

  it('gives offline and down the same weight, because they are the same fact', () => {
    expect(siteHealth(['up', 'offline'])).toBe(siteHealth(['up', 'down']));
    expect(siteHealth(['up', 'offline'])).toBe('50%');
  });

  it('does not let an unread device dilute the devices that were read', () => {
    // Half the read devices are down either way, so the unread one cannot
    // change the verdict and the site is still reported on what it showed.
    expect(siteHealth(['up', 'offline', 'unknown'])).toBe('50%');
  });

  it('asserts nothing when nothing was read', () => {
    expect(siteHealth(['unverified', 'unknown'])).toBeNull();
  });

  it('still reports a fully offline site as zero, not as unknown', () => {
    expect(siteHealth(['offline', 'offline'])).toBe('0%');
  });

  it('keeps the device count whole even when some states were unread', () => {
    const devices = ['up', 'offline', 'unverified'].map((st, i) => device(`uxi-${i}`, st));
    const [site] = mergeLiveSites([], devices, [], []);
    expect(site.devices).toBe(3);
    expect(site.health).toBe('50%');
  });
});

/**
 * A site cannot be certified on the strength of the devices that answered.
 *
 * The percentage is the share of KNOWN-STATE devices that are up, which is the
 * documented contract and stays that way. The band is the part that makes a
 * claim: 'ok' renders as the green 'Healthy' chip an operator scans past. It
 * was read straight off that percentage, so a site where one switch answered
 * and twenty went unread certified itself green on a sample of one.
 *
 * The band is now asserted only when the unread devices cannot move it —
 * floorPct is where the site lands if every one of them turns out to be down.
 * Same band either way and the reading holds whatever they were; different
 * bands and the inventory cannot support a verdict, which is what SiteRow's
 * `health: null` means and the shape SITES authors for Riverside (health null,
 * tone 'stale'). reconcile writes 'unverified' for exactly this — design rule
 * 1, every claimant stale, "we cannot assert live state".
 */
describe('mergeLiveSites certification over a partially read inventory', () => {
  it('refuses to call a site healthy when one device of twenty-four answered', () => {
    // Riverside's shape: 1 confirmed up, 23 reconcile could not verify.
    const site = siteRow(['up', ...Array<string>(23).fill('unverified')]);
    expect(site.devices).toBe(24);
    // Was 'ok' — the green chip, off a sample of one.
    expect(site.tone).toBe('stale');
    expect(site.health).toBeNull();
    // And the bar is drawn to what the estate earned, which is what the
    // authored SITES row for Riverside draws: '4%' across 24 devices, not a
    // full bar. 1 of 24 confirmed up.
    expect(site.healthPct).toBe('4%');
  });

  it('withholds the verdict when the unread devices would change the band', () => {
    // 100% of what answered, but 67% if the third device is down: ok vs bad.
    const site = siteRow(['up', 'up', 'unverified']);
    expect(site.health).toBeNull();
    expect(site.tone).toBe('stale');
    // Cycle 93 left this at '100%' on the reasoning that the measured share
    // was data rather than verdict. The bar's width is not neutral reporting:
    // a full-width bar reads as a full site however it is coloured. With the
    // band withheld the width is the floor — 2 of 3 confirmed up.
    expect(site.healthPct).toBe('67%');
  });

  it('draws a certified site to its measured share, unchanged', () => {
    // The guard: certification is what makes the measured share safe to draw,
    // and where it holds nothing about the bar moves.
    const site = siteRow([...Array<string>(147).fill('up'), 'unknown']);
    expect(site.tone).toBe('ok');
    expect(site.healthPct).toBe('100%');
    expect(site.health).toBe('100%');
  });

  it('never draws a withheld site wider than the estate confirmed', () => {
    // The invariant behind the fix. It is scoped to sites whose verdict was
    // withheld on purpose: where the band IS certified the width matches the
    // label beside it, so the two agree and the reading is disclosed. It is
    // only when the label reads '—' that the bar is the sole thing speaking.
    for (const states of [
      ['up', 'unverified', 'unverified'],
      ['up', 'up', 'unverified'],
      ['up', ...Array<string>(23).fill('unverified')],
      ['unverified', 'unverified'],
      ['up', 'up', 'up', 'unknown', 'unknown'],
    ]) {
      const site = siteRow(states);
      if (site.health !== null) continue; // certified: width and label agree
      const drawn = site.healthPct === '—' ? 0 : Number(site.healthPct.replace('%', ''));
      const confirmedUp = states.filter((x) => x === 'up').length;
      expect(drawn).toBeLessThanOrEqual(Math.round((confirmedUp / states.length) * 100));
    }
  });

  it('still certifies a healthy campus with a single unread device', () => {
    // 147 up, 1 unknown: 100% measured, 99% floor — both 'ok', so the gap
    // cannot change the reading and the site is not dragged to 'Unreported'.
    const site = siteRow([...Array<string>(147).fill('up'), 'unknown']);
    expect(site.tone).toBe('ok');
    expect(site.health).toBe('100%');
  });

  it('never counts an unread device as a failure', () => {
    // The mirror error. 'stale' is neutral ('Unreported'); 'bad' is a verdict
    // that the site is broken, which nobody established.
    expect(siteRow(['up', 'unverified', 'unverified']).tone).toBe('stale');
    expect(siteRow(['unverified', 'unverified']).tone).toBe('stale');
  });

  it('leaves a fully read site exactly as it was, verdict and all', () => {
    const ok = siteRow([...Array<string>(9).fill('up'), 'offline']);
    expect(ok.healthPct).toBe('90%');
    expect(ok.health).toBe('90%');
    expect(ok.tone).toBe('ok');
    const bad = siteRow(['up', 'offline', 'offline', 'offline']);
    expect(bad.health).toBe('25%');
    expect(bad.tone).toBe('bad');
  });
});
