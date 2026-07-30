import { describe, expect, it } from 'vitest';
import { pathFor } from '@hpe/shared/logic';
import { CLIENTS } from '@hpe/shared/fixtures';
import type { ClientRow } from '@hpe/shared';

/**
 * Harness smoke + the pathFor gateway guard: an AOS-10 wireless client
 * attached to gw-edge-1 but homed at a site whose chain has no gateway
 * (lakeshore) must fall through to the normal wireless path instead of
 * dereferencing chain.gw! — that produced blank path rows.
 */
describe('pathFor', () => {
  // A real fixture row with only the fields under test overridden.
  const base = CLIENTS.find((c) => c.siteId === 'lakeshore' && c.medium === 'wireless');
  if (!base) throw new Error('fixture missing a lakeshore wireless client');

  it('renders no null hop names for a gw-edge client at a gateway-less site', () => {
    const client: ClientRow = { ...base, plane: 'AOS-10', attach: 'gw-edge-1' };
    const hops = pathFor(client);
    expect(hops.length).toBeGreaterThan(0);
    for (const hop of hops) {
      expect(hop.name).toBeTruthy();
      expect(hop.role).toBeTruthy();
    }
  });

  it('still renders the fixture VIA path with its gateway hops intact', () => {
    const via = CLIENTS.find((c) => c.attach === 'gw-edge-1' && c.plane === 'AOS-10');
    if (!via) throw new Error('fixture missing the VIA client');
    const names = pathFor(via).map((h) => h.name);
    expect(names).toContain('gw-edge-1');
    for (const name of names) expect(name).toBeTruthy();
  });
});
