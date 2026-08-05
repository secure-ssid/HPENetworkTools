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

function siteHealth(states: string[]): string | null {
  const devices = states.map((st, i) => device(`uxi-${i}`, st));
  const [site] = mergeLiveSites([], devices, [], []);
  return site.health;
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
    expect(siteHealth(['up', 'up', 'unverified'])).toBe('100%');
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
