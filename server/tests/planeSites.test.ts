/**
 * server/tests/planeSites.test.ts — "Sites on this plane" on the Systems screen.
 *
 * planeSites tallies each site's devices and clients out of one plane's own
 * pull. The datasets are separate reads, so the site list can arrive without
 * the inventory beside it — and the tally was built over `pull.devices ?? []`,
 * which counts an absent read as zero of them. Every row then read
 * '0 devices · 0 clients' for an estate nobody had counted.
 *
 * planeLiveStats, the next function down the same file, has always got this
 * right: it publishes a counter only `if (pull.devices)`. The two functions
 * read the same pull and disagreed about what an absent dataset means.
 *
 * The string matters more than most: the Systems screen renders `detail`
 * verbatim, and its CSV export ships that one string per site with nothing
 * else attached.
 */
import { describe, expect, it } from 'vitest';
import type { ClientRow, DeviceRow, SiteId, SiteRow } from '@hpe/shared';
import { planeSites } from '../src/routes/screens/systemsModel';
import type { PlanePull } from '../src/planes/types';

const CAMPUS = 'campus-01' as SiteId;

/* Only the site keys are read by planeSites; the rest of each row is filler so
 * the shapes stay honest without a page of irrelevant fields. */
function site(): SiteRow {
  return {
    id: CAMPUS,
    name: 'Campus-01 HQ',
    subnet: '10.42.0.0/16',
    planes: [],
    mix: '',
    devices: 0,
    clients: '—',
    health: null,
    healthPct: '—',
    tone: 'stale',
    alerts: '—',
    alertTone: 'neutral',
    sync: '—',
  };
}

function device(name: string): DeviceRow {
  return {
    name,
    model: 'CX 6300',
    type: 'switch',
    siteId: CAMPUS,
    siteName: 'Campus-01 HQ',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'up',
    stateTone: 'success',
    firmware: '10.10',
    firmwareApproved: true,
    licence: 'Foundation',
    reconciliationIssue: false,
    localShell: false,
  };
}

function client(name: string): ClientRow {
  return {
    name,
    siteId: CAMPUS,
    siteName: 'Campus-01 HQ',
    planeTone: 'accent',
    healthTone: 'success',
  } as ClientRow;
}

function detailOf(pull: PlanePull): string {
  const [row] = planeSites(pull);
  return row.detail;
}

describe('planeSites tallies', () => {
  it('names an unread inventory rather than counting it as none', () => {
    // The plane answered for sites and not for devices.
    const detail = detailOf({ sites: [site()], clients: [client('laptop-1')] });

    expect(detail).toContain('devices not reported');
    // The claim that used to be here, about an estate nobody had counted.
    expect(detail).not.toContain('0 devices');
    // The dataset that DID arrive is still reported normally.
    expect(detail).toContain('1 client');
  });

  it('names an unread client roster the same way', () => {
    const detail = detailOf({ sites: [site()], devices: [device('sw-1')] });

    expect(detail).toContain('clients not reported');
    expect(detail).not.toContain('0 clients');
    expect(detail).toContain('1 device');
  });

  it('still says zero when the plane reported an empty inventory', () => {
    // The distinction the wording exists to protect: an estate that came back
    // empty is a fact, and an estate that never came back is not.
    const detail = detailOf({ sites: [site()], devices: [], clients: [] });

    expect(detail).toBe('0 devices · 0 clients');
    expect(detail).not.toContain('not reported');
  });

  it('counts what it was given', () => {
    const detail = detailOf({
      sites: [site()],
      devices: [device('sw-1'), device('sw-2')],
      clients: [client('laptop-1')],
    });

    expect(detail).toBe('2 devices · 1 client');
  });

  it('adds no caveat when both datasets arrived', () => {
    // A caveat nobody earned is its own kind of untruth — the row must read
    // exactly as it always did on a complete pull.
    const detail = detailOf({ sites: [site()], devices: [device('sw-1')], clients: [] });

    expect(detail).not.toContain('not reported');
    expect(detail).toBe('1 device · 0 clients');
  });
});
