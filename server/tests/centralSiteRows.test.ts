/**
 * server/tests/centralSiteRows.test.ts — the Central screen's per-site rows.
 *
 * Sites and devices are separate reads. A Central pull can carry the site list
 * and miss the inventory, and the row builder took `devices: pull?.devices ??
 * []` — laundering "not read" into "none" before the rows were built. Every
 * site then reported `devices: 0`, on the screen and in central-sites.csv,
 * which is the one number an operator cannot check by looking at it.
 *
 * The row already had the vocabulary for this: `clients` and `openAlerts` are
 * `number | null` precisely so an unreported dataset is not a zero, and the
 * type's own comment says "never a fabricated 0". `devices` was the count that
 * could not say it.
 */
import { describe, expect, it } from 'vitest';
import type { AlertRow, ClientRow, DeviceRow, SiteId } from '@hpe/shared';
import { centralSiteRows } from '@hpe/shared';

const CAMPUS = 'campus-01' as SiteId;

function device(name: string, state = 'up'): DeviceRow {
  return {
    name,
    model: 'CX 6300',
    type: 'switch',
    siteId: CAMPUS,
    siteName: 'Campus-01 HQ',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state,
    stateTone: state === 'up' ? 'success' : 'danger',
    firmware: '10.10',
    firmwareApproved: true,
    licence: 'Foundation',
    reconciliationIssue: false,
    localShell: false,
  };
}

describe('centralSiteRows device counts', () => {
  it('reports no device count when the pull carried no inventory', () => {
    // Central answered for sites and not for devices — the case the screen
    // already names in `notReported`, which the rows used to contradict.
    const [row] = centralSiteRows({ devices: null, clients: null, alerts: null, siteIds: [CAMPUS] });

    expect(row.siteId).toBe(CAMPUS);
    // Was 0: a site with an unknown number of devices, reported as a site
    // with none of them.
    expect(row.devices).toBeNull();
  });

  it('still reports zero when the plane genuinely reported an empty estate', () => {
    // The distinction the null exists to protect. An inventory that came back
    // empty is a fact about the estate; one that never came back is not, and
    // collapsing them is what the row was doing.
    const [row] = centralSiteRows({ devices: [], clients: null, alerts: null, siteIds: [CAMPUS] });

    expect(row.devices).toBe(0);
    expect(row.devices).not.toBeNull();
  });

  it('counts the devices it was given', () => {
    const [row] = centralSiteRows({
      devices: [device('sw-1'), device('sw-2'), device('sw-3', 'down')],
      clients: null,
      alerts: null,
      siteIds: [CAMPUS],
    });

    expect(row.devices).toBe(3);
    expect(row.healthPct).toBe(67);
  });

  it('asserts no health from an inventory it was never given', () => {
    const [row] = centralSiteRows({ devices: null, clients: null, alerts: null, siteIds: [CAMPUS] });

    // Health is a share of devices. With no inventory there is no denominator
    // and no honest numerator — 100% and 0% are both inventions here.
    expect(row.healthPct).toBeNull();
  });

  it('leaves the sibling counts reading as they always did', () => {
    // The guard: clients and openAlerts already distinguished unread from
    // zero, and this change must not disturb either.
    const clients: ClientRow[] = [];
    const alerts: AlertRow[] = [];
    const [unread] = centralSiteRows({
      devices: [device('sw-1')],
      clients: null,
      alerts: null,
      siteIds: [CAMPUS],
    });
    expect(unread.clients).toBeNull();
    expect(unread.openAlerts).toBeNull();

    const [empty] = centralSiteRows({
      devices: [device('sw-1')],
      clients,
      alerts,
      siteIds: [CAMPUS],
    });
    expect(empty.clients).toBe(0);
    expect(empty.openAlerts).toBe(0);
  });
});
