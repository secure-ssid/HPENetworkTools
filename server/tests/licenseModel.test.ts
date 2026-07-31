/**
 * server/tests/licenseModel.test.ts — the Licences screen's reclaim list.
 *
 * `liveOrphans` is the only row on this screen derived by subtracting one
 * plane's data from another's: GreenLake says which serials hold entitlement,
 * the merged inventory says which serials exist, and what is left over is
 * billed for and gone. A subtraction is only as true as its smaller operand,
 * and the merged inventory is a UNION over ten planes that shrinks silently
 * whenever one of them does not answer.
 *
 * Everything here is a pure call — no poller, no registry, no fixtures — so
 * the assertions are about what the panel is willing to CLAIM given an
 * inventory of a stated completeness.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { Plane, SubscriptionAssignment } from '@hpe/shared';

// Set before the settings singleton is constructed at import time — the real
// data/settings.json is never touched by the suite.
const tmp = mkdtempSync(join(tmpdir(), 'hpe-license-model-'));
process.env.HPE_SETTINGS_PATH = join(tmp, 'settings.json');
process.env.HPE_DATA_DIR = join(tmp, 'data');

let liveOrphans: typeof import('../src/routes/screens/licenseModel').liveOrphans;

beforeAll(async () => {
  ({ liveOrphans } = await import('../src/routes/screens/licenseModel'));
});

type Device = Parameters<typeof liveOrphans>[0][number];

/** A reconciled inventory row — only the serial matters to the join. */
function device(serial: string, name = serial.toLowerCase()): Device {
  return { name, serial } as unknown as Device;
}

function assignment(over: Partial<SubscriptionAssignment> = {}): SubscriptionAssignment {
  return { serial: 'SG1', deviceName: 'ap-lobby', assigned: true, subscriptionKey: 'AP-FOUND', ...over };
}

const tagsOf = (rows: { tag: string }[]): string[] => rows.map((r) => r.tag);

describe('liveOrphans — what the reclaim list is willing to claim', () => {
  it('calls an entitlement orphaned only when every plane reported its devices', () => {
    const rows = liveOrphans(
      [device('SG1')],
      [],
      [assignment({ serial: 'SG1' }), assignment({ serial: 'GONE-9', deviceName: 'sw-old' })],
      [],
    );

    expect(tagsOf(rows)).toContain('orphan');
    expect(rows.find((r) => r.tag === 'orphan')?.what).toContain('1 entitlement');
    expect(rows.find((r) => r.tag === 'orphan')?.detail).toContain('sw-old');
  });

  /* The case that actually happens. Central's devices read fails inside an
     otherwise successful pull, or it simply has not finished its first one;
     its whole estate leaves the merged inventory without a trace, and every
     GreenLake entitlement on it "matches nothing". Reported as an orphan that
     is aimed at hardware sitting in the rack passing traffic. */
  it('will not call an entitlement orphaned against an inventory a plane is missing from', () => {
    const rows = liveOrphans(
      [device('SG1')],
      [],
      [assignment({ serial: 'SG1' }), assignment({ serial: 'CENTRAL-ONLY-1', deviceName: 'sw-idf-3' })],
      ['CENTRAL' as Plane],
    );

    expect(tagsOf(rows)).not.toContain('orphan');
  });

  /* Suppressing the verdict silently would leave "nothing to reclaim", which
     is itself a finding. This cycle has no finding to give. */
  it('says the comparison did not run, and names the plane that was missing', () => {
    const rows = liveOrphans(
      [device('SG1')],
      [],
      [assignment({ serial: 'SG1' }), assignment({ serial: 'CENTRAL-ONLY-1' })],
      ['CENTRAL' as Plane, 'MIST' as Plane],
    );

    const note = rows.find((r) => r.tag === 'unchecked');
    expect(note).toBeTruthy();
    expect(note?.what).toContain('2 entitlements');
    expect(note?.detail).toContain('CENTRAL · MIST');
    // Not a finding, so not a colour that reads as one.
    expect(note?.tone).toBe('neutral');
  });

  /* The gap and archived rows read GreenLake's own assigned/subscriptionKey/
     archived fields and never touch the inventory, so an unread plane costs
     them nothing. Suppressing them too would be the mirror-image lie. */
  it('still reports the rows that never needed the inventory', () => {
    const rows = liveOrphans(
      [device('SG1')],
      [],
      [
        assignment({ serial: 'SG2', deviceName: 'ap-store', assigned: false }),
        assignment({ serial: 'SG3', deviceName: 'sw-retired', archived: true, assigned: true }),
      ],
      ['CENTRAL' as Plane],
    );

    expect(tagsOf(rows)).toContain('gap');
    expect(tagsOf(rows)).toContain('archived');
  });

  /* The pre-existing guard, which only ever caught the total blackout. Kept
     because it answers a different question: planes that ANSWERED and publish
     no serial at all. */
  it('still refuses the verdict when the planes answered but published no serials', () => {
    const rows = liveOrphans([device('', 'unnamed')], [], [assignment({ serial: 'SG9' })], []);

    expect(tagsOf(rows)).not.toContain('orphan');
    // Nothing was missing, so there is nothing to explain either.
    expect(tagsOf(rows)).not.toContain('unchecked');
  });

  it('adds no note when there was nothing to check in the first place', () => {
    expect(tagsOf(liveOrphans([device('SG1')], [], [], ['CENTRAL' as Plane]))).not.toContain('unchecked');
    expect(tagsOf(liveOrphans([device('SG1')], [], null, ['CENTRAL' as Plane]))).not.toContain('unchecked');
  });
});
