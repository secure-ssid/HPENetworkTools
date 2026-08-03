/**
 * The live Client 360 world: everything the cross-plane correlation reads,
 * assembled from the poller's last-good contributions.
 *
 * The correlation itself is shared/logic.ts clientPlaneSections() so the
 * browser's demo fallback runs the identical join. This module only assembles
 * the live inputs — which is where the live-mode honesty rules live:
 *
 *   - sessions are PRE-GROUP, per plane. The roster's unified grouping
 *     (liveCore.ts groupClientObservations) retains the sightings, but this
 *     exists to show: "both Central and Mist report this MAC" is the answer,
 *     not a duplicate.
 *   - a stale plane's session is rewritten to 'unverified', the same rule
 *     liveClients() applies (design rule 1 — an aged cache is not a current
 *     session). The 360 must not present last-good as current either.
 *   - a linked plane that has not reported a dataset is 'unread', never
 *     'empty': "ClearPass has not answered" and "ClearPass has nothing for
 *     this MAC" are different facts (see liveCore.ts planesMissingDataset).
 *   - an unlinked or stub adapter plane is 'unavailable' with the reason.
 *
 * NO plane call happens here: every input is a row the 60s poll already paid
 * for, so attaching the 360 block to a drawer open adds zero outbound cost.
 */

import { type Client360Dataset, type Client360World, type ClientRow } from '@hpe/shared';
import { registry, StubAdapter, UnconfiguredAdapter } from '../../planes/registry';
import { PLANE_IDS, type PlaneId } from '../../planes/types';
import { poller } from '../../services/poller';
import { stalePlanes } from './context';

/**
 * Planes whose pull can carry per-client rows at all: sessions, or the
 * ClearPass policy pair (auth events + endpoint repository). Every other
 * plane is structurally clientless and the shared correlation says so itself
 * (CLIENT_360_STRUCTURAL) — this list only gates the live-mode checks, so a
 * linked GreenLake is not told "no session" when it never models one.
 */
const CLIENT_DATA_PLANES: readonly PlaneId[] = [
  'central',
  'classic',
  'mist',
  'aos8',
  'aos10',
  'local',
  'clearpass',
];

export function liveClient360World(): Client360World {
  const contributions = poller.contributionsByPlane();
  const stale = stalePlanes();
  const sessions: ClientRow[] = [];
  for (const [id, pull] of contributions) {
    if (!pull.clients) continue;
    for (const row of pull.clients) {
      sessions.push(
        stale.has(id) ? { ...row, health: 'unverified', healthTone: 'neutral', problem: false } : row,
      );
    }
  }

  const unavailable: Client360World['unavailable'] = {};
  const unread: Client360World['unread'] = {};
  for (const id of PLANE_IDS) {
    if (!CLIENT_DATA_PLANES.includes(id)) continue;
    if (!registry.state(id).linked) {
      unavailable[id] = 'plane not linked';
      continue;
    }
    const adapter = registry.get(id);
    // A linked plane can still have no reader: partial credentials land on the
    // StubAdapter, and an adapter whose constructor threw lands back as an
    // UnconfiguredAdapter with linked: true (see poller.ts). Neither ever
    // carries a row, and "not read" must not arrive worded as "nothing".
    if (adapter instanceof StubAdapter) {
      unavailable[id] = 'sync adapter not yet implemented';
      continue;
    }
    if (adapter instanceof UnconfiguredAdapter) {
      unavailable[id] = 'no working adapter — its configuration was rejected';
      continue;
    }
    const pull = contributions.get(id);
    const gaps: Client360Dataset[] = [];
    if (id === 'clearpass') {
      if (pull?.authEvents === undefined) gaps.push('authEvents');
      if (pull?.endpoints === undefined) gaps.push('endpoints');
    } else if (pull?.clients === undefined) {
      gaps.push('clients');
    }
    if (gaps.length > 0) unread[id] = gaps;
  }

  const cache = poller.getCache();
  return {
    sessions,
    authEvents: cache.authEvents,
    endpoints: cache.endpoints,
    mistSle: contributions.get('mist')?.mistSle ?? [],
    unavailable,
    unread,
  };
}
