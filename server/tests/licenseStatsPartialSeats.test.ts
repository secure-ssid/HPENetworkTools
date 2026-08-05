import { describe, expect, it } from 'vitest';
import { liveLicenseStats } from '../src/routes/screens/licenseModel';
import type { LiveSubscription } from '../src/routes/screens/liveCore';

/**
 * greenlake's mapper omits `qtyValue`/`assignedValue` rather than guessing
 * (greenlake.ts:449-450), and the row it builds renders '—' for the same
 * cells. The stats tiles above the table used to sum both as zero.
 */
function sub(hints: Partial<LiveSubscription>): LiveSubscription {
  return {
    name: 'Foundation AP',
    sku: 'R7G20AAE · greenlake',
    plane: 'GREENLAKE',
    planeTone: 'accent',
    term: '3 yr subscription',
    qty: '—',
    assigned: '—',
    pct: '—',
    expires: '—',
    status: 'active',
    tone: 'neutral',
    ...hints,
  } as LiveSubscription;
}

const tile = (stats: ReturnType<typeof liveLicenseStats>, label: string) => {
  const found = stats.find((s) => s.label === label);
  if (found === undefined) throw new Error(`no ${label} tile`);
  return found;
};

describe('liveLicenseStats over a partly reported entitlement pool', () => {
  it('does not call a pool fully in use when no seat count was reported', () => {
    // The quiet failure: every tile reads like a healthy, fully-assigned
    // estate, computed entirely from data the plane never sent.
    const stats = liveLicenseStats([sub({ assignedValue: 40 }), sub({ assignedValue: 12 })], [], null);
    expect(tile(stats, 'Subscriptions').delta).toBe('2 subscriptions · no seat count reported');
    expect(tile(stats, 'Unassigned').value).toBe('—');
    expect(tile(stats, 'Unassigned').delta).not.toBe('all subscriptions in use');
  });

  it('never reports utilisation above 100% by mixing reported halves', () => {
    // 4 of 10 seats on one subscription, and a second that stated 900
    // assigned with no pool size. Assigned counted the 900, seats could not,
    // and the tile read '9040% utilised' in positive green.
    const stats = liveLicenseStats(
      [sub({ qtyValue: 10, assignedValue: 4 }), sub({ assignedValue: 900 })],
      [],
      null,
    );
    const assigned = tile(stats, 'Assigned');
    expect(assigned.delta).toBe('40% utilised over 1 of 2');
    expect(assigned.tone).not.toBe('positive');
  });

  it('does not report zero assigned when no subscription stated an assignment', () => {
    // The mirror of the first case, and the plain form of the honesty rule:
    // unread is not zero.
    const stats = liveLicenseStats([sub({ qtyValue: 500 }), sub({ qtyValue: 100 })], [], null);
    expect(tile(stats, 'Assigned').value).toBe('—');
    expect(tile(stats, 'Assigned').delta).toBe('2 subscriptions · none states an assignment');
    expect(tile(stats, 'Subscriptions').delta).toBe('600 seats');
  });

  it('says how much of the pool a partial seat total covers', () => {
    const stats = liveLicenseStats(
      [sub({ qtyValue: 180, assignedValue: 174 }), sub({ assignedValue: 40 })],
      [],
      null,
    );
    expect(tile(stats, 'Subscriptions').delta).toBe('180 seats over 1 of 2');
    expect(tile(stats, 'Unassigned').delta).toBe('counted across 1 of 2 subscriptions');
  });

  it('leaves a fully reported pool exactly as it read before', () => {
    // The guard. Disclosure is for the incomplete case; when every
    // subscription stated both halves nothing about these tiles moves.
    const stats = liveLicenseStats(
      [sub({ qtyValue: 180, assignedValue: 174 }), sub({ qtyValue: 40, assignedValue: 40 })],
      [],
      null,
    );
    expect(tile(stats, 'Subscriptions').delta).toBe('220 seats');
    expect(tile(stats, 'Assigned').value).toBe('214');
    expect(tile(stats, 'Assigned').delta).toBe('97% utilised');
    expect(tile(stats, 'Assigned').tone).toBe('positive');
    expect(tile(stats, 'Unassigned').value).toBe('6');
    expect(tile(stats, 'Unassigned').delta).toBe('all subscriptions in use');
  });

  it('still counts an explicit zero as an idle subscription', () => {
    // `assignedValue: 0` is a statement, not a silence, and the tile that
    // names idle pools must keep hearing it.
    const stats = liveLicenseStats(
      [sub({ qtyValue: 96, assignedValue: 0 }), sub({ qtyValue: 40, assignedValue: 40 })],
      [],
      null,
    );
    expect(tile(stats, 'Unassigned').value).toBe('96');
    expect(tile(stats, 'Unassigned').delta).toBe('1 subscription with none assigned');
  });
});
