/**
 * server/tests/overviewModel.test.ts — the "Planes linked" tile's second line.
 *
 * That line is the landing screen's entire account of plane health. Everything
 * more detailed lives on Systems, behind a click, so whatever this line leaves
 * out is not merely ranked lower — it is not on the screen the operator is
 * looking at.
 *
 * Pure calls: no poller, no registry, no fixtures. The assertions are about
 * what the tile is willing to claim given a stated set of plane states.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PLANE_IDS, type PlaneHealth, type PlaneId } from '../src/planes/types';

let planesLinkedDelta: (
  states: Record<PlaneId, { id: PlaneId; linked: boolean; health: PlaneHealth }>,
) => string;

beforeAll(async () => {
  // The settings singleton resolves its path at construction; keep it in tmp.
  process.env.HPE_SETTINGS_PATH = join(mkdtempSync(join(tmpdir(), 'hpe-overview-')), 'settings.json');
  ({ planesLinkedDelta } = await import('../src/routes/screens/overviewModel'));
});

/** Every plane healthy and linked, then the named ones overridden. */
function states(
  over: Partial<Record<PlaneId, PlaneHealth | 'not-linked'>> = {},
): Record<PlaneId, { id: PlaneId; linked: boolean; health: PlaneHealth }> {
  const out = {} as Record<PlaneId, { id: PlaneId; linked: boolean; health: PlaneHealth }>;
  for (const id of PLANE_IDS) {
    const o = over[id];
    out[id] =
      o === 'not-linked' || o === undefined
        ? { id, linked: o !== 'not-linked', health: 'healthy' }
        : { id, linked: true, health: o };
  }
  return out;
}

/** Nothing linked at all — every plane off. */
const NONE_LINKED = states(
  Object.fromEntries(PLANE_IDS.map((id) => [id, 'not-linked' as const])),
);

describe('the Planes linked tile names the planes that are not healthy', () => {
  it('says all healthy only when every linked plane is', () => {
    expect(planesLinkedDelta(states())).toBe('all healthy');
  });

  it('distinguishes nothing linked from everything healthy', () => {
    // A portal nobody has configured reports zero problems, and so does a
    // portal where all ten planes answer. They are not the same sentence.
    expect(planesLinkedDelta(NONE_LINKED)).toBe('none configured');
  });

  it('names the one unhealthy plane, exactly as it always did', () => {
    expect(planesLinkedDelta(states({ central: 'degraded' }))).toBe('CENTRAL degraded');
  });

  it('puts the worse plane in front of the milder one, whatever the roster order', () => {
    // 'mist' is third in PLANE_IDS and 'sse' is last, so first-match order puts
    // the warning in front. An operator told "MIST warning" goes and looks at
    // Mist, while the plane that actually stopped answering is the other one.
    const delta = planesLinkedDelta(states({ mist: 'warning', sse: 'degraded' }));
    expect(delta.startsWith('SSE degraded')).toBe(true);
    expect(delta).toBe('SSE degraded · MIST warning');
  });

  it('keeps roster order between planes of equal severity', () => {
    // Nothing separates them, so the order must not wobble between polls for a
    // reason the reader cannot see.
    expect(planesLinkedDelta(states({ central: 'degraded', sse: 'degraded' }))).toBe(
      'CENTRAL degraded · SSE degraded',
    );
  });

  it('counts the planes it has no room to name', () => {
    const delta = planesLinkedDelta(
      states({ central: 'degraded', mist: 'degraded', sse: 'degraded', uxi: 'warning' }),
    );
    // Two named and two dropped would read as two problems. The remainder is
    // counted so that what is missing is at least visible as missing.
    expect(delta).toBe('CENTRAL degraded · MIST degraded · +2 more');
  });

  it('does not add a remainder it does not have', () => {
    // Over-application guard: '+0 more' is noise, and the exact-limit case is
    // where an off-by-one would put it.
    expect(planesLinkedDelta(states({ central: 'degraded', mist: 'warning' }))).toBe(
      'CENTRAL degraded · MIST warning',
    );
  });

  it('ignores unlinked planes entirely', () => {
    // An unlinked plane is 'unhealthy' by the health union but is not a fault;
    // it has no credentials, which the roster panel already says.
    expect(planesLinkedDelta(states({ mist: 'not-linked', uxi: 'not-linked' }))).toBe(
      'all healthy',
    );
  });
});
